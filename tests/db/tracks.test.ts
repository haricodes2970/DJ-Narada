import assert from "node:assert/strict";
import test from "node:test";

import { closeDatabase, openDatabase } from "../../src/db/database.js";
import { TrackRepository } from "../../src/db/tracks.js";

async function withRepository<T>(fn: (repository: TrackRepository) => T | Promise<T>): Promise<T> {
  const db = await openDatabase(":memory:");
  try {
    return await fn(new TrackRepository(db));
  } finally {
    closeDatabase(db);
  }
}

function base(path: string, hash: string, size = 10, mtime = 1000) {
  return {
    id: path,
    path,
    contentHash: hash,
    sizeBytes: size,
    mtimeMs: mtime,
    title: path.split("/").at(-1) ?? path,
    artist: "Artist",
    album: "Album",
    durationSeconds: 120,
    format: "mp3",
  };
}

test("upsert inserts, preserves first seen, and updates metadata", async () => {
  await withRepository((repository) => {
    const first = repository.upsert(base("/music/a.mp3", "hash-a"), "2026-01-01T00:00:00.000Z");
    assert.equal(first.status, "inserted");
    assert.equal(first.track.firstSeenAt, "2026-01-01T00:00:00.000Z");

    const second = repository.upsert(
      { ...base("/music/a.mp3", "hash-b", 20, 2000), title: "Renamed" },
      "2026-01-02T00:00:00.000Z",
    );
    assert.equal(second.status, "updated");
    assert.equal(second.track.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(second.track.lastSeenAt, "2026-01-02T00:00:00.000Z");
    assert.equal(second.track.title, "Renamed");
    assert.equal(second.track.contentHash, "hash-b");
  });
});

test("duplicates group present tracks by content hash", async () => {
  await withRepository((repository) => {
    repository.upsert(base("/music/a.mp3", "same"));
    repository.upsert(base("/music/b.mp3", "same"));
    repository.upsert(base("/music/c.mp3", "different"));
    const groups = repository.duplicates();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].contentHash, "same");
    assert.deepEqual(groups[0].tracks.map((track) => track.path).sort(), ["/music/a.mp3", "/music/b.mp3"]);
    assert.equal(repository.counts().duplicates, 1);
  });
});

test("markMissingExcept only marks tracks under the scanned root", async () => {
  await withRepository((repository) => {
    repository.upsert(base("/music/a.mp3", "a"));
    repository.upsert(base("/music/nested/b.mp3", "b"));
    repository.upsert(base("/elsewhere/c.mp3", "c"));

    const missing = repository.markMissingExcept("/music", new Set(["/music/a.mp3"]));
    assert.equal(missing, 1);
    assert.equal(repository.getByPath("/music/a.mp3")?.scanStatus, "present");
    assert.equal(repository.getByPath("/music/nested/b.mp3")?.scanStatus, "missing");
    assert.equal(repository.getByPath("/elsewhere/c.mp3")?.scanStatus, "present");

    const counts = repository.counts();
    assert.equal(counts.present, 2);
    assert.equal(counts.missing, 1);
    assert.equal(repository.list().length, 2);
    assert.equal(repository.list({ includeMissing: true }).length, 3);
  });
});

test("missing tracks stay available and can return to present", async () => {
  await withRepository((repository) => {
    repository.upsert(base("/music/a.mp3", "a"));
    repository.markMissingExcept("/music", new Set());
    assert.equal(repository.getByPath("/music/a.mp3")?.scanStatus, "missing");
    repository.upsert(base("/music/a.mp3", "a", 10, 1000));
    assert.equal(repository.getByPath("/music/a.mp3")?.scanStatus, "present");
  });
});

test("scan runs are recorded and retrievable by root", async () => {
  await withRepository((repository) => {
    const id = repository.recordScanRun({
      root: "/music",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      filesSeen: 3,
      present: 2,
      missing: 1,
      errors: 0,
      added: 1,
      updated: 1,
      unchanged: 1,
      duplicates: 0,
      warnings: [{ path: "/music/x", message: "nope" }],
    });
    assert.ok(id > 0);
    const last = repository.lastScan("/music");
    assert.equal(last?.filesSeen, 3);
    assert.equal(last?.warnings[0].message, "nope");
    assert.equal(repository.lastScan("/other"), undefined);
  });
});
