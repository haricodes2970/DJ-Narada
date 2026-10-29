import assert from "node:assert/strict";
import test from "node:test";

import { computeLayout, centeredRect } from "../../src/ui/layout.js";
import { ScreenBuffer, diffFrames, progressBar } from "../../src/ui/screen.js";
import { EMBER_THEME, detectColorDepth, foreground, paint } from "../../src/ui/theme.js";

test("screen text clips at the right edge", () => {
  const screen = new ScreenBuffer(5, 2);
  screen.text(3, 0, "abcdef", { fg: EMBER_THEME.text });
  assert.equal(screen.rows("none")[0], "   ab");
});

test("screen ignores out-of-bounds writes", () => {
  const screen = new ScreenBuffer(4, 2);
  screen.set(-1, 0, "x");
  screen.set(4, 0, "x");
  screen.set(0, 2, "x");
  assert.equal(screen.rows("none").join(""), "        ");
});

test("screen draws a box with a title", () => {
  const screen = new ScreenBuffer(12, 4);
  screen.box({ x: 0, y: 0, width: 12, height: 4 }, { fg: EMBER_THEME.border }, "LIB");
  const rows = screen.rows("none");
  assert.match(rows[0], /^╭─ LIB ────╮$/);
  assert.match(rows[1], /^│/);
  assert.match(rows[3], /^╰──────────╯$/);
});

test("screen renders truecolor ANSI and plain fallback", () => {
  const screen = new ScreenBuffer(2, 1);
  screen.text(0, 0, "ab", { fg: EMBER_THEME.ember, bold: true });
  assert.match(screen.rows("truecolor")[0], /\u001b\[1m/);
  assert.match(screen.rows("truecolor")[0], /\u001b\[38;2;203;116;96m/);
  assert.equal(screen.rows("none")[0], "ab");
});

test("diffFrames returns nothing for identical frames", () => {
  const screen = new ScreenBuffer(4, 2);
  screen.text(0, 0, "same");
  const rows = screen.rows("none");
  assert.equal(diffFrames(rows, rows), "");
});

test("diffFrames addresses only changed rows", () => {
  const first = ["aaaa", "bbbb", "cccc"];
  const second = ["aaaa", "Bbbb", "cccc"];
  const output = diffFrames(first, second);
  assert.match(output, /\u001b\[2;1H/);
  assert.doesNotMatch(output, /\u001b\[1;1H/);
  assert.doesNotMatch(output, /\u001b\[3;1H/);
});

test("diffFrames forces a full redraw when dimensions change", () => {
  const output = diffFrames(["a"], ["a", "b"]);
  assert.match(output, /\u001b\[2J/);
  assert.match(output, /a/);
  assert.match(output, /b/);
});

test("progressBar clamps and fills deterministically", () => {
  assert.equal(progressBar(0, 5), "░░░░░");
  assert.equal(progressBar(1, 5), "█████");
  assert.equal(progressBar(0.5, 4), "██░░");
  assert.equal(progressBar(-1, 3), "░░░");
  assert.equal(progressBar(2, 3), "███");
});

test("color depth detection honors NO_COLOR and terminal capabilities", () => {
  assert.equal(detectColorDepth({}, false), "none");
  assert.equal(detectColorDepth({ NO_COLOR: "1" }, true), "none");
  assert.equal(detectColorDepth({ TERM: "dumb" }, true), "none");
  assert.equal(detectColorDepth({ TERM: "xterm-256color" }, true), "256");
  assert.equal(detectColorDepth({ TERM: "xterm", COLORTERM: "truecolor" }, true), "truecolor");
  assert.equal(detectColorDepth({ TERM: "xterm" }, true), "16");
});

test("foreground emits the expected escape for each depth", () => {
  assert.equal(foreground([1, 2, 3], "truecolor"), "\u001b[38;2;1;2;3m");
  assert.match(foreground([1, 2, 3], "256"), /^\u001b\[38;5;\d+m$/);
  assert.match(foreground([1, 2, 3], "16"), /^\u001b\[(3|9)\d+m$/);
  assert.equal(foreground([1, 2, 3], "none"), "");
});

test("paint is plain when color is disabled", () => {
  assert.equal(paint("hello", { fg: [1, 2, 3], bold: true }, "none"), "hello");
  assert.match(paint("hello", { fg: [1, 2, 3], bold: true }, "truecolor"), /\u001b\[1m/);
});

test("layout uses three columns on wide terminals", () => {
  const layout = computeLayout(140, 44);
  assert.equal(layout.showLibrary, true);
  assert.equal(layout.showQueue, true);
  assert.equal(layout.showAvatar, true);
  assert.ok(layout.library.width >= 22);
  assert.ok(layout.queue.width >= 26);
  assert.ok(layout.nowPlaying.width > 50);
});

test("layout collapses to two columns then one column", () => {
  const two = computeLayout(90, 30);
  assert.equal(two.showLibrary, true);
  assert.equal(two.showQueue, false);
  assert.equal(two.library.width + two.nowPlaying.width, 90);

  const one = computeLayout(70, 24);
  assert.equal(one.showLibrary, false);
  assert.equal(one.showQueue, false);
  assert.equal(one.nowPlaying.width, 70);
});

test("layout becomes compact on short terminals", () => {
  const layout = computeLayout(120, 16);
  assert.equal(layout.compact, true);
  assert.equal(layout.showAvatar, false);
  assert.equal(layout.transport.height, 1);
});

test("centeredRect centers within bounds", () => {
  assert.deepEqual(centeredRect({ x: 10, y: 5, width: 20, height: 10 }, 10, 4), {
    x: 15,
    y: 8,
    width: 10,
    height: 4,
  });
});
