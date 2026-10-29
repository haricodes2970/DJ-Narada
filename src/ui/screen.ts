import { background, foreground, reset, type ColorDepth, type Rgb, type Style } from "./theme.js";

export type Cell = {
  char: string;
  style: Style;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function styleKey(style: Style): string {
  return [
    style.fg?.join(",") ?? "",
    style.bg?.join(",") ?? "",
    style.bold ? "b" : "",
    style.dim ? "d" : "",
  ].join("|");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * A fixed-size cell buffer. Components draw into the buffer; the renderer
 * converts it to ANSI once and diffs rows so animation does not repaint the
 * whole terminal.
 */
export class ScreenBuffer {
  readonly width: number;
  readonly height: number;
  private cells: Cell[][];

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.cells = this.createCells();
  }

  private createCells(): Cell[][] {
    return Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ char: " ", style: {} })),
    );
  }

  clear(style: Style = {}): void {
    this.cells = this.createCells();
    if (style.fg !== undefined || style.bg !== undefined) this.fill(0, 0, this.width, this.height, " ", style);
  }

  set(x: number, y: number, char: string, style: Style = {}): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.cells[y][x] = { char: char.length === 0 ? " " : char[0], style };
  }

  text(x: number, y: number, text: string, style: Style = {}): void {
    if (y < 0 || y >= this.height) return;
    let column = x;
    for (const char of text) {
      if (column >= this.width) break;
      if (column >= 0) this.cells[y][column] = { char, style };
      column += 1;
    }
  }

  textBlock(x: number, y: number, lines: readonly string[], style: Style = {}): void {
    lines.forEach((line, index) => this.text(x, y + index, line, style));
  }

  fill(x: number, y: number, width: number, height: number, char = " ", style: Style = {}): void {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        this.set(column, row, char, style);
      }
    }
  }

  box(rect: Rect, style: Style = {}, title?: string): void {
    if (rect.width < 2 || rect.height < 2) return;
    const { x, y, width, height } = rect;
    this.set(x, y, "╭", style);
    this.set(x + width - 1, y, "╮", style);
    this.set(x, y + height - 1, "╰", style);
    this.set(x + width - 1, y + height - 1, "╯", style);
    for (let column = x + 1; column < x + width - 1; column += 1) {
      this.set(column, y, "─", style);
      this.set(column, y + height - 1, "─", style);
    }
    for (let row = y + 1; row < y + height - 1; row += 1) {
      this.set(x, row, "│", style);
      this.set(x + width - 1, row, "│", style);
    }
    if (title !== undefined && width > 4) {
      const label = ` ${title} `;
      this.text(x + 2, y, label.slice(0, width - 4), style);
    }
  }

  hline(x: number, y: number, width: number, char = "─", style: Style = {}): void {
    for (let column = x; column < x + width; column += 1) this.set(column, y, char, style);
  }

  vline(x: number, y: number, height: number, char = "│", style: Style = {}): void {
    for (let row = y; row < y + height; row += 1) this.set(x, row, char, style);
  }

  rows(depth: ColorDepth): string[] {
    const rendered: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let line = "";
      let current = "";
      let open = false;
      for (let x = 0; x < this.width; x += 1) {
        const cell = this.cells[y][x];
        const key = styleKey(cell.style);
        if (key !== current) {
          if (open) line += reset(depth);
          line += stylePrefix(cell.style, depth);
          current = key;
          open = true;
        }
        line += cell.char;
      }
      if (open) line += reset(depth);
      rendered.push(line);
    }
    return rendered;
  }

  frame(depth: ColorDepth): string {
    return `${this.rows(depth).join("\n")}\n`;
  }
}

function stylePrefix(style: Style, depth: ColorDepth): string {
  if (depth === "none") return "";
  let prefix = "";
  if (style.bold) prefix += "\u001b[1m";
  if (style.dim) prefix += "\u001b[2m";
  if (style.bg !== undefined) prefix += background(style.bg, depth);
  if (style.fg !== undefined) prefix += foreground(style.fg, depth);
  return prefix;
}

/**
 * Diff two rendered frames. Unchanged rows are skipped; changed rows are
 * addressed directly. A size change forces a full redraw.
 */
export function diffFrames(
  previous: readonly string[] | undefined,
  next: readonly string[],
  options: { synchronized?: boolean } = {},
): string {
  if (previous === undefined || previous.length !== next.length) {
    const body = next.map((row) => `${row}\u001b[K`).join("\n");
    return `${options.synchronized ? "\u001b[?2026h" : ""}\u001b[2J\u001b[H${body}${options.synchronized ? "\u001b[?2026l" : ""}`;
  }

  let output = options.synchronized ? "\u001b[?2026h" : "";
  for (let row = 0; row < next.length; row += 1) {
    if (next[row] === previous[row]) continue;
    output += `\u001b[${row + 1};1H${next[row]}\u001b[K`;
  }
  if (options.synchronized) output += "\u001b[?2026l";
  return output;
}

export function containsText(screen: ScreenBuffer, needle: string): boolean {
  const plain = screen
    .rows("none")
    .join("\n");
  return plain.includes(needle);
}

export function rectInside(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function inset(rect: Rect, left: number, top: number, right = left, bottom = top): Rect {
  const x = rect.x + left;
  const y = rect.y + top;
  const width = Math.max(1, rect.width - left - right);
  const height = Math.max(1, rect.height - top - bottom);
  return { x, y, width, height };
}

export function progressBar(value: number, width: number, filled = "█", empty = "░"): string {
  const clamped = clamp(value, 0, 1);
  const count = Math.round(clamped * width);
  return `${filled.repeat(count)}${empty.repeat(Math.max(0, width - count))}`;
}

export function rgbHex(color: Rgb): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
