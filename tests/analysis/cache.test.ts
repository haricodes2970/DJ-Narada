import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { AnalysisRepository, analyzeTrackWithCache, analyzeTracksWithCache } from "../../src/analysis/cache.js";
import { bpmFromFeatures, energyFromFeatures, liveEnergy } from "../../src/analysis/features.js";
import { closeDatabase, openDatabase } from "../../src/db/database.js";
import { TrackRepository } from "../../src/db/tracks.js";
import type { Track } from "../../src/library/types.js";
import type { AudioFeatures, AudioProbeResult } from "../../src/analysis/types.js";

const features: AudioFeatures = {
  durationSeconds: 120,
  sampleRate: 22050,
  channels: 1,
  tempoBpm: 128,
  rmsEnergy: 0.12,
  spectralCentroidHz: 2200,
  zeroCrossingRate: 0.08,
};

function track(id: string, contentHash = "hash-a"): Track {
  return {
    id,
    path: `/music/${id}.mp3`,
    title: id,
    durationSeconds: 120,
    contentHash,
    sizeBytes: 1000,
  };
}

function storeTrack(db: DatabaseSync, value: Track): void {
  new TrackRepository(db).upsert({
    id: value.id,
    path: value.path,
    contentHash: value.contentHash,
    sizeBytes: value.sizeBytes,
    title: value.title,
    durationSeconds: value.durationSeconds,
  });
}

function fakeProbe(result: AudioProbeResult, calls: { count: number }): () => Promise<AudioProbeResult> {
  return async () => {
    calls.count += 1;
    return result;
  };
}

test("analysis cache stores and reuses features by source hash", async () => {
  const db = await openDatabase(":memory:");
  try {
    const calls = { count: 0 };
    const probe = fakeProbe({ ok: true, features }, calls);
    storeTrack(db, track("a"));
    const first = await analyzeTrackWithCache(track("a"), { database: db, probe });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.cached, false);
    assert.equal(calls.count, 1);

    const second = await analyzeTrackWithCache(track("a"), { database: db, probe });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.cached, true);
    assert.deepEqual(second.features, features);
    assert.equal(calls.count, 1);

    const changed = await analyzeTrackWithCache(track("a", "hash-b"), { database: db, probe });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.equal(changed.cached, false);
    assert.equal(calls.count, 2);
  } finally {
    closeDatabase(db);
  }
});

test("analysis failures are recorded but never used as cache hits", async () => {
  const db = await openDatabase(":memory:");
  try {
    const calls = { count: 0 };
    const probe = fakeProbe({ ok: false, warning: { path: "/music/a.mp3", message: "decoder unavailable" } }, calls);
    storeTrack(db, track("a"));
    const first = await analyzeTrackWithCache(track("a"), { database: db, probe });
    assert.equal(first.ok, false);
    if (first.ok) return;
    assert.match(first.warning.message, /decoder unavailable/);

    const second = await analyzeTrackWithCache(track("a"), { database: db, probe });
    assert.equal(second.ok, false);
    assert.equal(calls.count, 2);
    const rows = db.prepare("SELECT error_message FROM analysis_runs").all();
    assert.equal(rows.length, 2);
  } finally {
    closeDatabase(db);
  }
});

test("analysis cache records a source hash and ignores corrupt values", async () => {
  const db = await openDatabase(":memory:");
  try {
    storeTrack(db, track("a"));
    const repository = new AnalysisRepository(db);
    repository.record({
      trackId: "a",
      algorithm: "librosa-baseline",
      algorithmVersion: "1",
      sourceHash: "hash-a",
      features,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    });
    assert.deepEqual(repository.get("a", "librosa-baseline", "1", "hash-a"), features);
    assert.equal(repository.get("a", "librosa-baseline", "1", "other"), undefined);

    db.prepare("UPDATE analysis_runs SET values_json = 'not-json'").run();
    assert.equal(repository.get("a", "librosa-baseline", "1", "hash-a"), undefined);
  } finally {
    closeDatabase(db);
  }
});

test("batch analysis reports analyzed, cached and failed counts", async () => {
  const db = await openDatabase(":memory:");
  try {
    const probe = async (filePath: string): Promise<AudioProbeResult> => {
      return filePath.includes("/b.")
        ? { ok: false, warning: { path: filePath, message: "bad" } }
        : { ok: true, features };
    };
    const tracks = [track("a"), track("b"), track("c")];
    for (const value of tracks) storeTrack(db, value);
    const first = await analyzeTracksWithCache(tracks, { database: db, probe, concurrency: 2 });
    assert.deepEqual(
      { total: first.total, analyzed: first.analyzed, cached: first.cached, failed: first.failed },
      { total: 3, analyzed: 2, cached: 0, failed: 1 },
    );

    const second = await analyzeTracksWithCache(tracks, { database: db, probe, concurrency: 2 });
    assert.equal(second.cached, 2);
    assert.equal(second.failed, 1);
  } finally {
    closeDatabase(db);
  }
});

test("analysis can be aborted before probing", async () => {
  const db = await openDatabase(":memory:");
  try {
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    storeTrack(db, track("a"));
    const result = await analyzeTrackWithCache(track("a"), {
      database: db,
      signal: controller.signal,
      probe: async () => {
        called += 1;
        return { ok: false, warning: { path: "/music/a.mp3", message: "aborted" } };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(called, 1);
  } finally {
    closeDatabase(db);
  }
});

test("feature energy and bpm helpers are bounded", () => {
  const energy = energyFromFeatures(features);
  assert.ok(energy > 0 && energy <= 1);
  assert.equal(bpmFromFeatures(features), 128);
  assert.equal(bpmFromFeatures({ ...features, tempoBpm: 0 }), 0);
  assert.ok(liveEnergy(features, 0) <= 1);
  assert.ok(liveEnergy(features, 6) >= 0);
});
