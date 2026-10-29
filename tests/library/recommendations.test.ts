import assert from "node:assert/strict";
import test from "node:test";

import { rankRecommendations, type RecommendationContext } from "../../src/library/recommendations.js";
import type { Track } from "../../src/library/types.js";

const current: Track = { id: "current", path: "/music/current.mp3", title: "Current", artist: "A", sizeBytes: 1, bpm: 100, energy: 0.5 };
const tracks: Track[] = [
  { id: "same", path: "/music/same.mp3", title: "Same Artist", artist: "A", sizeBytes: 1, bpm: 102, energy: 0.52 },
  { id: "good", path: "/music/good.mp3", title: "Good Match", artist: "B", sizeBytes: 1, bpm: 104, energy: 0.55 },
  { id: "far", path: "/music/far.mp3", title: "Far Match", artist: "C", sizeBytes: 1, bpm: 180, energy: 0.1 },
  { id: "liked", path: "/music/liked.mp3", title: "Liked Track", artist: "D", sizeBytes: 1, bpm: 140, energy: 0.8 },
];

test("recommendations rank compatible BPM and energy above distant tracks", () => {
  const result = rankRecommendations(tracks, { current, limit: 4 });
  assert.deepEqual(result.map((item) => item.track.id), ["good", "same", "liked", "far"]);
  assert.match(result[0].explanation, /BPM/);
});

test("recommendations exclude current and recently played tracks", () => {
  const result = rankRecommendations(tracks, { current, recentTrackIds: ["good"], limit: 10 });
  assert.equal(result.some((item) => item.track.id === "current"), false);
  assert.equal(result.some((item) => item.track.id === "good"), false);
});

test("positive and negative feedback affect ranking transparently", () => {
  const context: RecommendationContext = {
    current,
    feedback: { liked: ["far"], disliked: ["good"] },
    limit: 4,
  };
  const result = rankRecommendations(tracks, context);
  assert.equal(result[0].track.id, "same");
  assert.ok(result.find((item) => item.track.id === "far")?.score !== undefined);
  assert.match(result.find((item) => item.track.id === "far")?.explanation ?? "", /liked/);
});

test("empty recommendation input returns limited explanation", () => {
  const result = rankRecommendations([], { current, limit: 5 });
  assert.deepEqual(result, []);
});
