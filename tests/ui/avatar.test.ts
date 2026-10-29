import assert from "node:assert/strict";
import test from "node:test";

import {
  AVATAR_HEIGHT,
  AVATAR_WIDTH,
  createAvatarFrame,
  drawPixelGrid,
  type AvatarState,
} from "../../src/ui/avatar.js";
import { ScreenBuffer } from "../../src/ui/screen.js";
import { EMBER_THEME } from "../../src/ui/theme.js";

const base = {
  state: "playing" as AvatarState,
  tick: 0,
  energy: 0.6,
  beatPhase: 0.5,
  transitionProgress: 0.5,
};

test("avatar frame has fixed dimensions and palette indices", () => {
  const frame = createAvatarFrame(base);
  const rows = frame.toIndexRows();
  assert.equal(rows.length, AVATAR_HEIGHT);
  for (const row of rows) {
    assert.equal(row.length, AVATAR_WIDTH);
    assert.match(row, /^[0-9a-d]+$/);
  }
});

test("avatar frames are deterministic for identical options", () => {
  assert.deepEqual(createAvatarFrame(base).toIndexRows(), createAvatarFrame(base).toIndexRows());
});

test("avatar animation changes across ticks", () => {
  const first = createAvatarFrame({ ...base, tick: 0 }).toIndexRows();
  const second = createAvatarFrame({ ...base, tick: 7 }).toIndexRows();
  assert.notDeepEqual(first, second);
});

test("paused avatar differs from playing avatar", () => {
  const playing = createAvatarFrame({ ...base, tick: 3, state: "playing" }).toIndexRows();
  const paused = createAvatarFrame({ ...base, tick: 3, state: "paused" }).toIndexRows();
  assert.notDeepEqual(playing, paused);
});

test("higher energy lights more VU pixels", () => {
  const low = createAvatarFrame({ ...base, tick: 2, energy: 0, beatPhase: 0 }).toIndexRows().join("");
  const high = createAvatarFrame({ ...base, tick: 2, energy: 1, beatPhase: 1 }).toIndexRows().join("");
  const count = (value: string, character: string): number => [...value].filter((item) => item === character).length;
  assert.ok(count(high, "5") + count(high, "4") + count(high, "6") >= count(low, "5") + count(low, "4") + count(low, "6"));
});

test("every avatar state renders without throwing", () => {
  const states: AvatarState[] = ["boot", "idle", "playing", "mixing", "paused", "error"];
  for (const state of states) {
    const frame = createAvatarFrame({ ...base, state, tick: 5 });
    assert.equal(frame.toIndexRows().length, AVATAR_HEIGHT);
  }
});

test("drawPixelGrid uses half blocks and respects the rect", () => {
  const frame = createAvatarFrame(base);
  const screen = new ScreenBuffer(32, 16);
  drawPixelGrid(screen, { x: 0, y: 0, width: 32, height: 16 }, frame, EMBER_THEME);
  const plain = screen.rows("none").join("");
  assert.match(plain, /[▀▄█]/);
  assert.equal(screen.rows("none").length, 16);
});

test("drawPixelGrid scales into a smaller rect", () => {
  const frame = createAvatarFrame(base);
  const screen = new ScreenBuffer(20, 10);
  drawPixelGrid(screen, { x: 0, y: 0, width: 20, height: 10 }, frame, EMBER_THEME);
  assert.equal(screen.rows("none").length, 10);
  assert.match(screen.rows("none").join(""), /[▀▄█]/);
});
