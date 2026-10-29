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

function randomFrom(seed: number): (index: number) => number {
  return (index: number): number => {
    const value = Math.sin((seed % 100000) + index * 97.13) * 43758.5453;
    return value - Math.floor(value);
  };
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
  const random = randomFrom(seed);

  // Night-sky gradient.
  const horizon = Math.max(5, Math.floor(height * 0.64));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const band = y < horizon ? PANEL : DEEP;
      grid.set(x, y, (x + y + seed) % 9 === 0 ? SHADOW : band);
    }
  }

  // Retro sun with a sliced lower half.
  const sunX = Math.floor(width * (0.35 + random(1) * 0.3));
  const sunY = Math.max(4, horizon - 3);
  const radius = Math.max(3, Math.floor(Math.min(width, height) * 0.28));
  grid.circle(sunX, sunY, radius, AMBER);
  grid.circle(sunX, sunY, Math.max(1, radius - 2), EMBER);
  for (let offset = 1; offset < radius; offset += 3) {
    for (let x = sunX - radius; x <= sunX + radius; x += 1) {
      grid.set(x, sunY + offset, DEEP);
    }
  }

  // Stars.
  for (let index = 0; index < 12; index += 1) {
    const x = Math.floor(random(10 + index) * width);
    const y = Math.floor(random(30 + index) * Math.max(1, horizon - 2));
    grid.set(x, y, index % 5 === 0 ? WHITE : index % 3 === 0 ? MINT : SHADOW);
  }

  // Horizon and simple mountain silhouettes.
  for (let x = 0; x < width; x += 1) grid.set(x, horizon, SHADOW);
  for (let index = 0; index < 3; index += 1) {
    const peakX = Math.floor(random(50 + index) * width);
    const peakHeight = 2 + Math.floor(random(60 + index) * 3);
    for (let step = 0; step < peakHeight; step += 1) {
      const half = peakHeight - step;
      for (let x = peakX - half; x <= peakX + half; x += 1) {
        if (x >= 0 && x < width) grid.set(x, horizon - step, index % 2 === 0 ? SHADOW : DEEP);
      }
    }
  }

  // Bottom label bars, like a tiny sleeve.
  grid.rect(1, height - 3, width - 2, 1, SHADOW);
  grid.rect(2, height - 2, Math.max(2, Math.floor(width * 0.45)), 1, EMBER);
  grid.rect(2 + Math.floor(width * 0.5), height - 2, Math.max(1, Math.floor(width * 0.25)), 1, AMBER);

  // Frame.
  grid.frame(0, 0, width, height, AMBER);
  return grid;
}
