import assert from "node:assert/strict";
import test from "node:test";

import { applyMode, getModes } from "../../src/library/modes.js";
import type { Track } from "../../src/library/types.js";

function track(overrides: Partial<Track> & Pick<Track, "id" | "path" | "title">): Track {
  return { sizeBytes: 1, ...overrides };
}

const library: Track[] = [
  track({
    id: "/music/Hip-Hop/seedhe-maut-nanchaku.mp3",
    path: "/music/Hip-Hop/seedhe-maut-nanchaku.mp3",
    title: "Nanchaku",
    artist: "Seedhe Maut",
    album: "Nayaab",
  }),
  track({
    id: "/music/Hindi-Bollywood/arijit-tum-hi-ho.mp3",
    path: "/music/Hindi-Bollywood/arijit-tum-hi-ho.mp3",
    title: "Tum Hi Ho",
    artist: "Arijit Singh",
    album: "Aashiqui 2",
  }),
  track({
    id: "/music/Focus-Ambient/deep-work.mp3",
    path: "/music/Focus-Ambient/deep-work.mp3",
    title: "Deep Work",
    artist: "Ambient Lab",
  }),
  track({
    id: "/music/Other/gym-anthem.mp3",
    path: "/music/Other/gym-anthem.mp3",
    title: "Gym Anthem",
    artist: "Unknown",
  }),
  track({
    id: "/music/Other/mystery.mp3",
    path: "/music/Other/mystery.mp3",
    title: "Mystery",
  }),
];

test("exposes four deterministic listening modes", () => {
  assert.deepEqual(getModes().map((mode) => mode.id), [
    "hip-hop",
    "desi",
    "workout",
    "deep-focus",
  ]);
});

test("hip-hop mode matches path and metadata evidence", () => {
  const result = applyMode("hip-hop", library);
  assert.deepEqual(result.tracks.map((item) => item.title), ["Nanchaku"]);
  assert.equal(result.modeId, "hip-hop");
  assert.equal(result.limited, false);
  assert.ok(result.matchedRuleCount >= 1);
  assert.match(result.explanation, /hip-hop/i);
});

test("desi mode matches language and category terms", () => {
  const result = applyMode("desi", library);
  assert.deepEqual(result.tracks.map((item) => item.title), ["Tum Hi Ho"]);
  assert.equal(result.limited, false);
});

test("workout mode uses explicit metadata and path terms only", () => {
  const result = applyMode("workout", library);
  assert.deepEqual(result.tracks.map((item) => item.title), ["Gym Anthem"]);
  assert.equal(result.limited, false);
});

test("deep focus mode matches category and descriptive terms", () => {
  const result = applyMode("deep-focus", library);
  assert.deepEqual(result.tracks.map((item) => item.title), ["Deep Work"]);
  assert.equal(result.limited, false);
});

test("mode matching is case-insensitive", () => {
  const result = applyMode("hip-hop", [
    track({ id: "/music/X/a.mp3", path: "/music/X/a.mp3", title: "RAP GOD" }),
  ]);
  assert.deepEqual(result.tracks.map((item) => item.title), ["RAP GOD"]);
});

test("mode results never contain duplicate ids", () => {
  const result = applyMode("desi", [library[1], library[1]]);
  assert.deepEqual(result.tracks.map((item) => item.id), [library[1].id]);
});

test("unmatched mode is limited with an actionable explanation", () => {
  const result = applyMode("deep-focus", [library[4]]);
  assert.deepEqual(result.tracks, []);
  assert.equal(result.limited, true);
  assert.match(result.explanation, /insufficient|limited|no .*match/i);
});

test("unknown mode is limited and does not throw", () => {
  const result = applyMode("polka", library);
  assert.deepEqual(result.tracks, []);
  assert.equal(result.limited, true);
  assert.match(result.explanation, /unknown/i);
});

test("mode explanations never claim audio analysis", () => {
  for (const mode of getModes()) {
    const result = applyMode(mode.id, library);
    assert.doesNotMatch(result.explanation, /bpm|energy|mood|machine learning|neural/i);
  }
});
