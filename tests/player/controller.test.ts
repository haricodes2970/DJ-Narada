import assert from "node:assert/strict";
import test from "node:test";

import { DummyBackend } from "../../src/player/dummyBackend.js";
import { PlaybackController } from "../../src/player/controller.js";
import type { Track } from "../../src/library/types.js";

const tracks: Track[] = [
  { id: "/music/a.mp3", path: "/music/a.mp3", title: "A", durationSeconds: 100, sizeBytes: 1 },
  { id: "/music/b.mp3", path: "/music/b.mp3", title: "B", durationSeconds: 200, sizeBytes: 1 },
  { id: "/music/c.mp3", path: "/music/c.mp3", title: "C", durationSeconds: 300, sizeBytes: 1 },
];

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("controller plays a queue and reports elapsed position", async () => {
  let now = 1_000;
  const backend = new DummyBackend();
  const controller = new PlaybackController({
    backend,
    queue: tracks,
    volume: 55,
    now: () => now,
  });

  await controller.playIndex(0);
  assert.equal(controller.getState().status, "playing");
  assert.equal(controller.current?.title, "A");
  assert.deepEqual(backend.calls.slice(0, 3), ["load:/music/a.mp3", "play", "volume:55"]);

  now += 12_500;
  assert.equal(controller.getState().positionSeconds, 12.5);
  assert.equal(controller.getState().durationSeconds, 100);
});

test("pause freezes position and resume continues it", async () => {
  let now = 1_000;
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: tracks, now: () => now });
  await controller.playIndex(0);
  now += 10_000;
  await controller.pause();
  assert.equal(controller.getState().status, "paused");
  now += 30_000;
  assert.equal(controller.getState().positionSeconds, 10);
  await controller.resume();
  now += 5_000;
  assert.equal(controller.getState().positionSeconds, 15);
});

test("next and previous wrap the queue", async () => {
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: tracks });
  await controller.playIndex(2);
  await controller.next();
  assert.equal(controller.current?.title, "A");
  await controller.previous();
  assert.equal(controller.current?.title, "C");
});

test("previous restarts the current track after three seconds", async () => {
  let now = 1_000;
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: tracks, now: () => now });
  await controller.playIndex(1);
  now += 4_000;
  await controller.previous();
  assert.equal(controller.current?.title, "B");
  assert.equal(controller.getState().positionSeconds, 0);
});

test("natural end auto-advances to the next track", async () => {
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: tracks });
  await controller.playIndex(0);
  backend.finish();
  await flush();
  assert.equal(controller.current?.title, "B");
  assert.equal(controller.getState().status, "playing");
  assert.ok(backend.calls.includes("load:/music/b.mp3"));
});

test("natural end stops at the end of a single-track queue", async () => {
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: [tracks[0]] });
  await controller.playIndex(0);
  backend.finish();
  await flush();
  assert.equal(controller.getState().status, "stopped");
});

test("autoAdvance can be disabled", async () => {
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: tracks, autoAdvance: false });
  await controller.playIndex(0);
  backend.finish();
  await flush();
  assert.equal(controller.current?.title, "A");
  assert.equal(controller.getState().status, "stopped");
});

test("backend errors surface as controller errors", async () => {
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: tracks });
  await controller.playIndex(0);
  backend.fail("decoder exploded");
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().error, "decoder exploded");
});

test("playTrack appends a track that is not in the queue", async () => {
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: [tracks[0]] });
  await controller.playTrack(tracks[2]);
  assert.deepEqual(controller.getState().queue.map((track) => track.title), ["A", "C"]);
  assert.equal(controller.current?.title, "C");
});

test("setQueue handles empty and volume changes", async () => {
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: tracks });
  controller.setQueue([]);
  assert.equal(controller.getState().status, "stopped");
  assert.equal(controller.current, undefined);
  await controller.setVolume(120);
  assert.equal(controller.getState().volume, 100);
  assert.ok(backend.calls.includes("volume:100"));
});

test("close releases the backend", async () => {
  const backend = new DummyBackend();
  const controller = new PlaybackController({ backend, queue: tracks });
  await controller.playIndex(0);
  await controller.close();
  assert.equal(controller.getState().status, "idle");
  assert.ok(backend.calls.includes("close"));
});
