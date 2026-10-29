import assert from "node:assert/strict";
import test from "node:test";

import { syntheticBpm, syntheticEnergy } from "../../src/ui/state.js";
import type { Track } from "../../src/library/types.js";

const track: Track = {
  id: "track-a",
  path: "/music/a.mp3",
  title: "A",
  sizeBytes: 1,
};

test("UI uses measured BPM when analysis is available", () => {
  assert.equal(syntheticBpm({ ...track, bpm: 132 }), 132);
});

test("UI uses measured energy when analysis is available", () => {
  assert.equal(syntheticEnergy({ ...track, energy: 0.82 }, 99), 0.82);
});
