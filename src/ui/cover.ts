import type { Track } from "../library/types.js";
import { PixelGrid } from "./avatar.js";

const BG = 1;
const PANEL = 2;
const EMBER = 3;
const AMBER = 4;
const MINT = 5;
const DEEP = 12;
const SHADOW = 13;
const WHITE = 11;

export function hashString(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Deterministic fallback cover art.
 *
 * The same track always produces the same cover, so a library without embedded
 * artwork still gets a stable visual identity instead of a blank tile.
 */
export function createProceduralCover(track: Track, width = 16, height = 16): PixelGrid {
  const grid = new PixelGrid(width, height);
  const seed = hashString(`${track.title}|${track.artist ?? ""}|${track.album ?? ""}`);
  const random = (index: number): number => {
    const value = Math.sin((seed % 100000) + index * 97.13) * 43758.5453;
    return value - Math.floor(value);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const diagonal = (x + y + (seed % 5)) % 7;
      const color = diagonal < 2 ? DEEP : diagonal < 5 ? PANEL : BG;
      grid.set(x, y, color);
    }
  }

  // Large offset circle.
  const centerX = Math.floor(random(1) * width);
  const centerY = Math.floor(random(2) * height);
  const radius = 3 + Math.floor(random(3) * 3);
  grid.circle(centerX, centerY, radius, EMBER, false);
  grid.circle(centerX, centerY, Math.max(1, radius - 2), AMBER, false);

  // Horizon line and sun.
  const horizon = Math.floor(height * 0.62);
  for (let x = 0; x < width; x += 1) {
    if ((x + seed) % 3 !== 0) grid.set(x, horizon, DEEP);
  }
  const sunX = Math.floor(width / 2 + (random(4) - 0.5) * width * 0.4);
  grid.circle(sunX, horizon - 2, 2, MINT);

  // Stars.
  for (let index = 0; index < 10; index += 1) {
    const x = Math.floor(random(10 + index) * width);
    const y = Math.floor(random(20 + index) * horizon);
    grid.set(x, y, index % 4 === 0 ? WHITE : index % 3 === 0 ? AMBER : SHADOW);
  }

  // Bottom label bars, like a tiny sleeve.
  grid.rect(1, height - 3, width - 2, 1, SHADOW);
  grid.rect(2, height - 2, Math.max(2, Math.floor(width * 0.45)), 1, EMBER);
  grid.rect(2 + Math.floor(width * 0.5), height - 2, Math.max(1, Math.floor(width * 0.25)), 1, AMBER);

  // Frame.
  grid.frame(0, 0, width, height, EMBER);
  return grid;
}
