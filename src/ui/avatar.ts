import type { ScreenBuffer, Rect } from "./screen.js";
import type { Rgb, Theme } from "./theme.js";

export type AvatarState = "boot" | "idle" | "playing" | "mixing" | "paused" | "error";

export type AvatarOptions = {
  state: AvatarState;
  tick: number;
  energy: number;
  beatPhase: number;
  transitionProgress: number;
};

export const AVATAR_WIDTH = 32;
export const AVATAR_HEIGHT = 32;

const TRANSPARENT = 0;
const BG = 1;
const PANEL = 2;
const EMBER = 3;
const AMBER = 4;
const MINT = 5;
const RED = 6;
const SKIN = 7;
const HOODIE = 8;
const VINYL = 9;
const STEEL = 10;
const WHITE = 11;
const DEEP = 12;
const SHADOW = 13;

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  N: ["101", "111", "111", "101", "101"],
  A: ["010", "101", "111", "101", "101"],
  R: ["110", "101", "110", "101", "101"],
  D: ["110", "101", "101", "101", "110"],
};

export class PixelGrid {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height);
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return TRANSPARENT;
    return this.pixels[y * this.width + x];
  }

  set(x: number, y: number, color: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = color;
  }

  rect(x: number, y: number, width: number, height: number, color: number): void {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) this.set(column, row, color);
    }
  }

  frame(x: number, y: number, width: number, height: number, color: number): void {
    this.rect(x, y, width, 1, color);
    this.rect(x, y + height - 1, width, 1, color);
    this.rect(x, y, 1, height, color);
    this.rect(x + width - 1, y, 1, height, color);
  }

  circle(centerX: number, centerY: number, radius: number, color: number, filled = true): void {
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (let x = centerX - radius; x <= centerX + radius; x += 1) {
        const distance = Math.hypot(x - centerX, y - centerY);
        if (filled ? distance <= radius : Math.abs(distance - radius) < 0.6) this.set(x, y, color);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const steps = Math.max(dx, dy, 1);
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(x0 + ((x1 - x0) * step) / steps);
      const y = Math.round(y0 + ((y1 - y0) * step) / steps);
      this.set(x, y, color);
    }
  }

  text(x: number, y: number, value: string, color: number): void {
    let cursor = x;
    for (const character of value) {
      const glyph = GLYPHS[character];
      if (glyph === undefined) {
        cursor += 4;
        continue;
      }
      glyph.forEach((row, rowIndex) => {
        [...row].forEach((pixel, columnIndex) => {
          if (pixel === "1") this.set(cursor + columnIndex, y + rowIndex, color);
        });
      });
      cursor += 4;
    }
  }

  toIndexRows(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let row = "";
      for (let x = 0; x < this.width; x += 1) row += this.get(x, y).toString(16);
      rows.push(row);
    }
    return rows;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isActive(state: AvatarState): boolean {
  return state === "playing" || state === "mixing" || state === "boot";
}

function hash(value: number): number {
  const x = Math.sin(value * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function drawStarfield(grid: PixelGrid, tick: number): void {
  for (let index = 0; index < 14; index += 1) {
    const x = Math.floor(hash(index * 7 + 1) * AVATAR_WIDTH);
    const y = Math.floor(hash(index * 11 + 3) * 8);
    const phase = (tick + index * 3) % 24;
    const color = phase < 12 ? STEEL : index % 3 === 0 ? AMBER : MUTED_STAR;
    grid.set(x, y, color);
  }
}

const MUTED_STAR = STEEL;

function drawSign(grid: PixelGrid, options: AvatarOptions): void {
  const { state, tick } = options;
  const blink = state === "boot" ? tick % 6 < 3 : state === "error" ? tick % 4 < 2 : true;
  const borderColor = state === "error" ? RED : blink ? EMBER : DEEP;
  const textColor = state === "paused" ? STEEL : blink ? AMBER : DEEP;
  grid.frame(3, 1, 26, 7, borderColor);
  grid.rect(4, 2, 24, 5, PANEL);
  if (blink) grid.text(6, 2, "NARADA", textColor);
  if (state === "mixing") {
    const width = 22;
    const filled = Math.round(clamp01(options.transitionProgress) * width);
    grid.rect(5, 8, width, 1, DEEP);
    grid.rect(5, 8, filled, 1, MINT);
  }
}

function drawHead(grid: PixelGrid, options: AvatarOptions): void {
  const { state, tick } = options;
  const bob = isActive(state) ? (Math.floor(tick / 2) % 2) : 0;
  const baseY = 9 + bob;
  const skinColor = state === "paused" ? STEEL : SKIN;
  const hoodieColor = state === "paused" ? SHADOW : HOODIE;

  // Headphones band and ear cups.
  grid.circle(16, baseY + 2, 5, state === "paused" ? SHADOW : EMBER, false);
  grid.rect(9, baseY + 2, 2, 3, STEEL);
  grid.rect(21, baseY + 2, 2, 3, STEEL);

  // Face.
  grid.rect(12, baseY, 8, 6, skinColor);
  grid.rect(11, baseY + 1, 1, 4, skinColor);
  grid.rect(20, baseY + 1, 1, 4, skinColor);

  // Eyes and third-eye LED.
  const eyeColor = state === "error" ? RED : WHITE;
  grid.set(14, baseY + 2, eyeColor);
  grid.set(18, baseY + 2, eyeColor);
  const led = state === "playing" || state === "mixing" ? MINT : state === "error" ? RED : AMBER;
  grid.set(16, baseY + 1, led);

  // Mouth.
  grid.rect(15, baseY + 4, 3, 1, state === "error" ? RED : DEEP);

  // Torso / hoodie.
  grid.rect(11, baseY + 6, 10, 7, hoodieColor);
  grid.rect(12, baseY + 6, 8, 1, state === "paused" ? SHADOW : DEEP);
  grid.rect(15, baseY + 8, 2, 3, EMBER);
}

function drawDeck(grid: PixelGrid, centerX: number, centerY: number, options: AvatarOptions, side: "left" | "right"): void {
  const { state, tick } = options;
  const paused = state === "paused";
  const spin = isActive(state) ? tick * (state === "mixing" ? 0.9 : 0.55) : 0;
  const angle = side === "left" ? spin : spin + Math.PI;
  const radius = 4;

  grid.circle(centerX, centerY, radius + 1, paused ? SHADOW : STEEL, false);
  grid.circle(centerX, centerY, radius, VINYL);
  grid.circle(centerX, centerY, 1, paused ? STEEL : AMBER);
  const markerX = Math.round(centerX + Math.cos(angle) * (radius - 1));
  const markerY = Math.round(centerY + Math.sin(angle) * (radius - 1));
  grid.set(markerX, markerY, paused ? STEEL : WHITE);

  // Tonearm.
  grid.line(centerX + 4, centerY - 5, centerX + 2, centerY - 1, STEEL);
}

function drawMixer(grid: PixelGrid, options: AvatarOptions): void {
  const { state, tick } = options;
  grid.rect(13, 21, 6, 3, STEEL);
  grid.rect(14, 22, 4, 1, VINYL);
  const progress = state === "mixing"
    ? clamp01(options.transitionProgress)
    : 0.5 + (state === "playing" ? Math.sin(tick / 6) * 0.05 : 0);
  const knob = 14 + Math.round(clamp01(progress) * 3);
  grid.rect(knob, 21, 1, 3, state === "paused" ? STEEL : EMBER);

  // VU segments.
  const energy = state === "paused" ? 0 : clamp01(options.energy);
  const beat = state === "playing" || state === "mixing" ? 0.25 + 0.75 * clamp01(options.beatPhase) : 0;
  const lit = Math.round(clamp01(energy * 0.7 + beat * 0.3) * 5);
  for (let index = 0; index < 5; index += 1) {
    const color = index >= 4 ? RED : index >= 3 ? AMBER : MINT;
    grid.set(12 - 0, 25 - index, index < lit ? color : SHADOW);
    grid.set(19, 25 - index, index < lit ? color : SHADOW);
  }
}

function drawCrowd(grid: PixelGrid, tick: number): void {
  const bob = Math.floor(tick / 3) % 2;
  for (let index = 0; index < 9; index += 1) {
    const x = 2 + index * 3;
    const height = 2 + (index % 3);
    const offset = (index + bob) % 2;
    grid.rect(x, 31 - height - offset, 2, height, SHADOW);
    grid.set(x, 31 - height - offset - 1, index % 4 === 0 ? EMBER : SHADOW);
  }
}

/**
 * Build one deterministic avatar frame.
 *
 * The avatar is intentionally data-driven: the same options always produce the
 * same grid, which makes snapshot tests and animation debugging possible.
 */
export function createAvatarFrame(options: AvatarOptions): PixelGrid {
  const grid = new PixelGrid(AVATAR_WIDTH, AVATAR_HEIGHT);
  drawStarfield(grid, options.tick);
  drawSign(grid, options);
  drawHead(grid, options);

  const deckY = 20;
  drawDeck(grid, 7, deckY, options, "left");
  drawDeck(grid, 25, deckY, options, "right");
  drawMixer(grid, options);

  // Desk and crowd.
  grid.rect(2, 26, 28, 2, STEEL);
  grid.rect(2, 27, 28, 1, SHADOW);
  drawCrowd(grid, options.tick);

  if (options.state === "error") {
    for (let row = 8; row < 24; row += 5) {
      grid.rect(2, row, 28, 1, row % 2 === 0 ? RED : SHADOW);
    }
  }

  return grid;
}

const PALETTE_KEYS: readonly (keyof Theme)[] = [
  "bg", "bg", "panel", "ember", "amber", "mint", "red", "skin",
  "hoodie", "vinyl", "steel", "white", "deep", "border",
];

function paletteColor(index: number, theme: Theme): Rgb | undefined {
  if (index === TRANSPARENT) return undefined;
  return theme[PALETTE_KEYS[Math.min(index, PALETTE_KEYS.length - 1)]];
}

function sample(grid: PixelGrid, x: number, y: number, targetWidth: number, targetHeight: number): number {
  const sourceX = Math.min(grid.width - 1, Math.floor((x / targetWidth) * grid.width));
  const sourceY = Math.min(grid.height - 1, Math.floor((y / targetHeight) * grid.height));
  return grid.get(sourceX, sourceY);
}

/**
 * Draw a pixel grid into a terminal rect using half-block characters.
 * Each terminal cell carries two vertical pixels (foreground and background).
 */
export function drawPixelGrid(
  screen: ScreenBuffer,
  rect: Rect,
  grid: PixelGrid,
  theme: Theme,
): void {
  if (rect.width < 2 || rect.height < 2) return;
  const targetWidth = rect.width;
  const targetHeight = rect.height * 2;
  for (let row = 0; row < rect.height; row += 1) {
    for (let column = 0; column < rect.width; column += 1) {
      const top = sample(grid, column, row * 2, targetWidth, targetHeight);
      const bottom = sample(grid, column, row * 2 + 1, targetWidth, targetHeight);
      const topColor = paletteColor(top, theme);
      const bottomColor = paletteColor(bottom, theme);
      const x = rect.x + column;
      const y = rect.y + row;
      if (topColor === undefined && bottomColor === undefined) {
        screen.set(x, y, " ");
      } else if (topColor === undefined && bottomColor !== undefined) {
        screen.set(x, y, "▄", { fg: bottomColor });
      } else if (topColor !== undefined && bottomColor === undefined) {
        screen.set(x, y, "▀", { fg: topColor });
      } else if (topColor !== undefined && bottomColor !== undefined) {
        if (topColor[0] === bottomColor[0] && topColor[1] === bottomColor[1] && topColor[2] === bottomColor[2]) {
          screen.set(x, y, "█", { fg: topColor });
        } else {
          screen.set(x, y, "▀", { fg: topColor, bg: bottomColor });
        }
      }
    }
  }
}
