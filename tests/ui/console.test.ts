import assert from "node:assert/strict";
import test from "node:test";

import { TerminalSession, type TerminalInput, type TerminalOutput } from "../../src/cli/terminal.js";
import type { Track } from "../../src/library/types.js";
import { PlaybackController } from "../../src/player/controller.js";
import { DummyBackend } from "../../src/player/dummyBackend.js";
import type { CrossfadeRenderResult } from "../../src/mixing/crossfade.js";
import { NaradaConsole } from "../../src/ui/console.js";
import { EMBER_THEME } from "../../src/ui/theme.js";

class FakeInput implements TerminalInput {
  isTTY = true;
  listeners = new Set<(chunk: string | Buffer) => void>();
  rawModes: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }

  resume(): void {}
  pause(): void {}

  on(_event: "data", listener: (chunk: string | Buffer) => void): void {
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (chunk: string | Buffer) => void): void {
    this.listeners.delete(listener);
  }

  emit(chunk: string): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

class FakeOutput implements TerminalOutput {
  isTTY = true;
  columns = 120;
  rows = 40;
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

function track(overrides: Partial<Track> & Pick<Track, "id" | "path" | "title">): Track {
  return { sizeBytes: 1, ...overrides };
}

const tracks: Track[] = [
  track({
    id: "/music/hiphop/nanchaku.mp3",
    path: "/music/hiphop/nanchaku.mp3",
    title: "Nanchaku",
    artist: "Seedhe Maut",
    album: "Nayaab",
    durationSeconds: 222,
  }),
  track({
    id: "/music/desi/tum-hi-ho.mp3",
    path: "/music/desi/tum-hi-ho.mp3",
    title: "Tum Hi Ho",
    artist: "Arijit Singh",
    durationSeconds: 300,
  }),
  track({
    id: "/music/focus/deep-work.mp3",
    path: "/music/focus/deep-work.mp3",
    title: "Deep Work",
    artist: "Ambient Lab",
    durationSeconds: 180,
  }),
  track({
    id: "/music/other/gym-anthem.mp3",
    path: "/music/other/gym-anthem.mp3",
    title: "Gym Anthem",
    artist: "Unknown",
    durationSeconds: 120,
  }),
];

function setup(options: {
  columns?: number;
  rows?: number;
  splashMs?: number;
  frameMs?: number;
  playback?: PlaybackController;
  crossfadeRenderer?: (plan: unknown) => Promise<CrossfadeRenderResult>;
} = {}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = options.columns ?? 120;
  output.rows = options.rows ?? 40;
  const terminal = new TerminalSession({ input, output, installSignalHandlers: false });
  const console = new NaradaConsole({
    terminal,
    catalog: { tracks, warnings: [] },
    libraryRoot: "/music",
    demo: true,
    theme: EMBER_THEME,
    depth: "none",
    splashMs: options.splashMs ?? 0,
    frameMs: options.frameMs ?? 90,
    autoStartTimer: false,
    playback: options.playback,
    crossfadeRenderer: options.crossfadeRenderer as never,
  });
  return { input, output, terminal, console };
}

test("console renders library, now playing, queue, and transport", () => {
  const { console } = setup();
  assert.equal(console.start(), true);
  const text = console.renderToString();
  assert.match(text, /NARADA/);
  assert.match(text, /LIBRARY/);
  assert.match(text, /ON AIR/);
  assert.match(text, /QUEUE/);
  assert.match(text, /Nanchaku/);
  assert.match(text, /Seedhe Maut/);
  assert.match(text, /PLAYING/);
  assert.match(text, /q quit/);
});

test("console collapses the queue and library at narrow widths", () => {
  const wide = setup({ columns: 90, rows: 30 });
  wide.console.start();
  const two = wide.console.renderToString();
  assert.match(two, /LIBRARY/);
  assert.doesNotMatch(two, /QUEUE/);

  const narrow = setup({ columns: 70, rows: 24 });
  narrow.console.start();
  const one = narrow.console.renderToString();
  assert.doesNotMatch(one, /LIBRARY/);
  assert.match(one, /ON AIR/);
});

test("console navigates the library and plays the selected track", () => {
  const { console } = setup();
  console.start();
  console.dispatch("down", "j");
  assert.equal(console.getState().libraryIndex, 1);
  console.dispatch("select", "\r");
  assert.equal(console.getState().queueIndex, 1);
  assert.match(console.getState().message, /Tum Hi Ho/);
  assert.match(console.renderToString(), /Tum Hi Ho/);
});

test("console drives a real playback controller when attached", async () => {
  const backend = new DummyBackend();
  const playback = new PlaybackController({ backend, queue: tracks });
  const { console } = setup({ playback });
  console.start();

  console.dispatch("select", "\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(console.getState().playback, "playing");
  assert.ok(backend.calls.includes("load:/music/hiphop/nanchaku.mp3"));
  assert.ok(backend.calls.includes("play"));

  console.dispatch("pause", " ");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(console.getState().playback, "paused");
  assert.ok(backend.calls.includes("pause"));

  console.dispatch("next", "n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(console.getState().queueIndex, 1);
  assert.ok(backend.calls.includes("load:/music/desi/tum-hi-ho.mp3"));

  console.dispatch("volumeUp", "+");
  assert.equal(console.getState().volume, 75);
  assert.ok(backend.calls.includes("volume:75"));

  await playback.close();
});

test("crossfade key renders a cached transition preview", async () => {
  let calls = 0;
  const { console } = setup({
    crossfadeRenderer: async (plan) => {
      calls += 1;
      return {
        ok: true,
        path: "/tmp/transition.wav",
        cached: true,
        durationSeconds: (plan as { durationSeconds: number }).durationSeconds,
        plan: plan as never,
      };
    },
  });
  console.start();
  console.dispatch("crossfade", "x");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.match(console.getState().message, /Crossfade ready/);
  assert.equal(console.getState().transition > 0, true);
});

test("search overlay accepts text and applies a filter", () => {
  const { console } = setup();
  console.start();
  console.dispatch("search", "/");
  assert.equal(console.getState().overlay, "search");
  for (const character of "seedhe") console.dispatch("unknown", character);
  console.dispatch("select", "\r");
  assert.equal(console.getState().overlay, "none");
  assert.equal(console.getState().query, "seedhe");
  assert.deepEqual(console.getState().filtered.map((item) => item.title), ["Nanchaku"]);
});

test("search overlay supports backspace and cancel", () => {
  const { console } = setup();
  console.start();
  console.dispatch("search", "/");
  for (const character of "abc") console.dispatch("unknown", character);
  console.dispatch("unknown", "\u007f");
  assert.equal(console.getState().searchDraft, "ab");
  console.dispatch("back", "\u001b");
  assert.equal(console.getState().overlay, "none");
  assert.equal(console.getState().query, "");
});

test("mode overlay applies a listening mode", () => {
  const { console } = setup();
  console.start();
  console.dispatch("mode", "m");
  assert.equal(console.getState().overlay, "modes");
  console.dispatch("down", "\u001b[B");
  console.dispatch("select", "\r");
  assert.equal(console.getState().modeId, "desi");
  assert.deepEqual(console.getState().filtered.map((item) => item.title), ["Tum Hi Ho"]);
  assert.match(console.getState().message, /Desi/i);
});

test("pause and play toggle playback state", () => {
  const { console } = setup();
  console.start();
  console.dispatch("pause", " ");
  assert.equal(console.getState().playback, "paused");
  console.dispatch("pause", " ");
  assert.equal(console.getState().playback, "playing");
});

test("next and previous wrap around the queue", () => {
  const { console } = setup();
  console.start();
  console.dispatch("previous", "b");
  assert.equal(console.getState().queueIndex, tracks.length - 1);
  console.dispatch("next", "n");
  assert.equal(console.getState().queueIndex, 0);
});

test("volume is clamped", () => {
  const { console } = setup();
  console.start();
  for (let index = 0; index < 20; index += 1) console.dispatch("volumeUp", "+");
  assert.equal(console.getState().volume, 100);
  for (let index = 0; index < 30; index += 1) console.dispatch("volumeDown", "-");
  assert.equal(console.getState().volume, 0);
});

test("tick advances position and wraps to the next track", () => {
  const { console } = setup({ frameMs: 100000 });
  console.start();
  console.tick();
  assert.equal(console.getState().position, 100);
  console.tick();
  console.tick();
  assert.equal(console.getState().queueIndex, 1);
  assert.equal(console.getState().position, 0);
});

test("help and info overlays open and close", () => {
  const { console } = setup();
  console.start();
  console.dispatch("help", "?");
  assert.equal(console.getState().overlay, "help");
  assert.match(console.renderToString(), /KEYS/);
  console.dispatch("unknown", "x");
  assert.equal(console.getState().overlay, "none");

  console.dispatch("info", "i");
  assert.equal(console.getState().overlay, "info");
  assert.match(console.renderToString(), /TRACK INFO/);
  console.dispatch("unknown", "x");
  assert.equal(console.getState().overlay, "none");
});

test("splash renders boot state and dismisses on input", () => {
  const { console } = setup({ splashMs: 900 });
  console.start();
  const splash = console.renderToString();
  assert.match(splash, /N A R A D A/);
  assert.match(splash, /COSMIC DJ SAGE/);
  assert.equal(console.getState().playback, "loading");
  console.dispatch("unknown", "x");
  assert.equal(console.getState().playback, "playing");
  assert.doesNotMatch(console.renderToString(), /COSMIC DJ SAGE/);
});

test("quit closes the terminal and resolves run", async () => {
  const { console, input, output } = setup();
  const running = console.run();
  assert.equal(input.rawModes[0], true);
  console.dispatch("quit", "q");
  await running;
  assert.equal(input.rawModes.at(-1), false);
  assert.match(output.text, /\u001b\[\?1049l/);
});

test("empty catalog renders an actionable empty state", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new TerminalSession({ input, output, installSignalHandlers: false });
  const console = new NaradaConsole({
    terminal,
    catalog: { tracks: [], warnings: [] },
    libraryRoot: "/empty",
    demo: false,
    depth: "none",
    autoStartTimer: false,
  });
  console.start();
  const text = console.renderToString();
  assert.match(text, /NO TRACK SELECTED/);
  assert.match(text, /rescan/);
  assert.equal(console.getState().playback, "stopped");
});

test("shuffle keeps the queue deterministic and complete", () => {
  const { console } = setup();
  console.start();
  console.dispatch("shuffle", "s");
  const first = console.getState().queue.map((item) => item.id);
  assert.equal(first.length, tracks.length);
  assert.deepEqual([...first].sort(), tracks.map((item) => item.id).sort());
});
