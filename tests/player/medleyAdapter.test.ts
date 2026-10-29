import assert from "node:assert/strict";
import test from "node:test";

import { MedleyAdapter, planMedley } from "../../src/player/medleyAdapter.js";
import type { Track } from "../../src/library/types.js";

function track(id: string, title: string, artist?: string): Track {
  return { id, path: `/music/${id}.mp3`, title, artist, sizeBytes: 1 };
}

test("deduplicates by id and orders deterministically by title", () => {
  const plan = planMedley([
    track("c", "Charlie", "A"),
    track("a", "Alpha", "B"),
    track("a", "Alpha", "B"),
    track("b", "Bravo", "C"),
  ]);
  assert.deepEqual(
    plan.tracks.map((entry) => entry.id),
    ["a", "b", "c"],
  );
});

test("respects maxTracks", () => {
  const plan = planMedley(
    [track("a", "Alpha"), track("b", "Bravo"), track("c", "Charlie")],
    { maxTracks: 2 },
  );
  assert.equal(plan.tracks.length, 2);
  assert.deepEqual(
    plan.tracks.map((entry) => entry.id),
    ["a", "b"],
  );
});

test("separates consecutive artists when possible", () => {
  const plan = planMedley(
    [
      track("a1", "Alpha 1", "Same"),
      track("a2", "Alpha 2", "Same"),
      track("b1", "Bravo 1", "Other"),
    ],
    { avoidSameArtist: true },
  );
  assert.deepEqual(
    plan.tracks.map((entry) => entry.id),
    ["a1", "b1", "a2"],
  );
});

test("marks a plan limited when fewer than two distinct tracks exist", () => {
  const plan = planMedley([track("a", "Alpha", "Solo")]);
  assert.equal(plan.limited, true);
  assert.equal(plan.tracks.length, 1);
});

test("empty input yields an empty limited plan", () => {
  const plan = planMedley([]);
  assert.deepEqual(plan.tracks, []);
  assert.equal(plan.limited, true);
});

test("non-positive maxTracks yields an empty limited plan", () => {
  const plan = planMedley([track("a", "Alpha"), track("b", "Bravo")], { maxTracks: 0 });
  assert.deepEqual(plan.tracks, []);
  assert.equal(plan.limited, true);
});

test("adapter navigates the plan within bounds", () => {
  const adapter = new MedleyAdapter([track("a", "Alpha"), track("b", "Bravo")]);
  assert.equal(adapter.current()?.id, "a");
  assert.equal(adapter.next()?.id, "b");
  assert.equal(adapter.next()?.id, "b");
  assert.equal(adapter.previous()?.id, "a");
  assert.equal(adapter.previous()?.id, "a");
});
