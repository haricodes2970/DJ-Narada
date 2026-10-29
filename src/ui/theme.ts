export type Rgb = readonly [number, number, number];
export type ColorDepth = "truecolor" | "256" | "16" | "none";

export type Theme = {
  bg: Rgb;
  panel: Rgb;
  panelAlt: Rgb;
  border: Rgb;
  text: Rgb;
  muted: Rgb;
  ember: Rgb;
  amber: Rgb;
  deep: Rgb;
  mint: Rgb;
  red: Rgb;
  vinyl: Rgb;
  steel: Rgb;
  skin: Rgb;
  hoodie: Rgb;
  white: Rgb;
};

export const EMBER_THEME: Theme = {
  bg: [20, 20, 22],
  panel: [30, 30, 34],
  panelAlt: [38, 38, 44],
  border: [51, 51, 58],
  text: [214, 214, 220],
  muted: [124, 124, 134],
  ember: [203, 116, 96],
  amber: [224, 164, 94],
  deep: [138, 74, 58],
  mint: [123, 224, 173],
  red: [255, 107, 107],
  vinyl: [11, 11, 13],
  steel: [74, 74, 82],
  skin: [201, 138, 99],
  hoodie: [46, 46, 54],
  white: [240, 240, 244],
};

export const HIGH_CONTRAST_THEME: Theme = {
  ...EMBER_THEME,
  bg: [0, 0, 0],
  panel: [10, 10, 10],
  panelAlt: [20, 20, 20],
  border: [120, 120, 120],
  text: [255, 255, 255],
  muted: [180, 180, 180],
  ember: [255, 180, 90],
  amber: [255, 220, 130],
  mint: [140, 255, 190],
  red: [255, 120, 120],
};

export type Style = {
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  dim?: boolean;
};

export function detectColorDepth(
  env: Record<string, string | undefined>,
  isTTY: boolean,
): ColorDepth {
  if (!isTTY || env.NO_COLOR !== undefined) return "none";
  if (env.TERM === "dumb") return "none";
  if (env.FORCE_COLOR === "0") return "none";
  const term = `${env.TERM ?? ""} ${env.COLORTERM ?? ""}`.toLowerCase();
  if (term.includes("truecolor") || term.includes("24bit")) return "truecolor";
  if (term.includes("256color")) return "256";
  if (env.COLORTERM !== undefined) return "truecolor";
  return "16";
}

function rgbTo256(color: Rgb): number {
  const [r, g, b] = color;
  const levels = [0, 95, 135, 175, 215, 255];
  const nearest = (value: number): number => {
    let best = 0;
    for (let index = 1; index < levels.length; index += 1) {
      if (Math.abs(levels[index] - value) < Math.abs(levels[best] - value)) best = index;
    }
    return best;
  };
  const ri = nearest(r);
  const gi = nearest(g);
  const bi = nearest(b);
  if (ri === 0 && gi === 0 && bi === 0) return 16;
  return 16 + 36 * ri + 6 * gi + bi;
}

function rgbTo16(color: Rgb): number {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const bright = max > 170;
  if (max - min < 24) {
    if (bright) return 97;
    return max > 100 ? 37 : 90;
  }
  const base = bright ? 90 : 30;
  const index = r >= g && r >= b ? 1 : g >= r && g >= b ? 2 : 4;
  return base + index;
}

export function foreground(color: Rgb, depth: ColorDepth): string {
  if (depth === "none") return "";
  if (depth === "truecolor") return `\u001b[38;2;${color[0]};${color[1]};${color[2]}m`;
  if (depth === "256") return `\u001b[38;5;${rgbTo256(color)}m`;
  return `\u001b[${rgbTo16(color)}m`;
}

export function background(color: Rgb, depth: ColorDepth): string {
  if (depth === "none") return "";
  if (depth === "truecolor") return `\u001b[48;2;${color[0]};${color[1]};${color[2]}m`;
  if (depth === "256") return `\u001b[48;5;${rgbTo256(color)}m`;
  return `\u001b[${rgbTo16(color) + 10}m`;
}

export function reset(depth: ColorDepth): string {
  return depth === "none" ? "" : "\u001b[0m";
}

export function paint(text: string, style: Style, depth: ColorDepth): string {
  if (depth === "none" || (style.fg === undefined && style.bg === undefined && !style.bold && !style.dim)) {
    return text;
  }
  let prefix = "";
  if (style.bold) prefix += "\u001b[1m";
  if (style.dim) prefix += "\u001b[2m";
  if (style.bg !== undefined) prefix += background(style.bg, depth);
  if (style.fg !== undefined) prefix += foreground(style.fg, depth);
  return `${prefix}${text}${reset(depth)}`;
}
