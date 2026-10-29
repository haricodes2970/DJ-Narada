import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { libraryStatus, scanLibraryToDatabase } from "../../src/library/libraryService.js";
import type { Track } from "../../src/library/types.js";

function makeProbe(calls: string[]) {
  return async (filePath: string) => {
    calls.push(filePath);
    const title = path.basename(filePath, path.extname(filePath));
    const track: Track = { id: filePath, path: filePath, title, sizeBytes: 0 };
    return { track };
  };
}

test("incremental scan reuses unchanged files, updates changed files, and marks missing files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "narada-service-"));
  const dbPath = path.join(directory, "library.db");
  const first = path.join(directory, "first.mp3");
  const second = path.join(directory, "second.mp3");
  const files = [first, second];
  const probeCalls: string[] = [];
  let hashCalls = 0;
  let clock = 0;
  const now = () => new Date(1_700_000_000_000 + clock++ * 1000);
  const options = {
    root: directory,
    databasePath: dbPath,
    scan: async () => ({ files: [...files], warnings: [] }),
    probe: makeProbe(probeCalls),
    hashFile: async (filePath: string) => {
      hashCalls += 1;
      const { hashFile } = await import("../../src/library/hash.js");
      return hashFile(filePath);
    },
    now,
  };

  try {
    await fs.writeFile(first, "one");
    await fs.writeFile(second, "two");

    const initial = await scanLibraryToDatabase(options);
    assert.equal(initial.present, 2);
    assert.equal(initial.added, 2);
    assert.equal(initial.updated, 0);
    assert.equal(initial.unchanged, 0);
    assert.equal(probeCalls.length, 2);
    assert.equal(hashCalls, 2);

    const secondScan = await scanLibraryToDatabase(options);
    assert.equal(secondScan.present, 2);
    assert.equal(secondScan.added, 0);
    assert.equal(secondScan.updated, 0);
    assert.equal(secondScan.unchanged, 2);
    assert.equal(probeCalls.length, 2);
    assert.equal(hashCalls, 2);

    await fs.writeFile(first, "one changed");
    await fs.utimes(first, new Date(2026, 0, 2), new Date(2026, 0, 2));
    const changed = await scanLibraryToDatabase(options);
    assert.equal(changed.present, 2);
    assert.equal(changed.added, 0);
    assert.equal(changed.updated, 1);
    assert.equal(changed.unchanged, 1);
    assert.equal(hashCalls, 3);

    files.splice(files.indexOf(second), 1);
    const missing = await scanLibraryToDatabase(options);
    assert.equal(missing.present, 1);
    assert.equal(missing.missing, 1);
    assert.equal(missing.markedMissing, 1);

    const status = await libraryStatus({ databasePath: dbPath, includeTracks: true });
    assert.equal(status.exists, true);
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.counts.present, 1);
    assert.equal(status.counts.missing, 1);
    assert.equal(status.tracks.length, 2);
    assert.equal(status.lastScan?.filesSeen, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("scan reports duplicate content without deleting either copy", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "narada-duplicates-"));
  const dbPath = path.join(directory, "library.db");
  const first = path.join(directory, "a.mp3");
  const second = path.join(directory, "b.mp3");
  const files = [first, second];
  try {
    await fs.writeFile(first, "same bytes");
    await fs.writeFile(second, "same bytes");
    const summary = await scanLibraryToDatabase({
      root: directory,
      databasePath: dbPath,
      scan: async () => ({ files: [...files], warnings: [] }),
      probe: makeProbe([]),
    });
    assert.equal(summary.present, 2);
    assert.equal(summary.duplicates.length, 1);
    assert.equal(summary.duplicates[0].tracks.length, 2);

    const status = await libraryStatus({ databasePath: dbPath, includeTracks: true });
    assert.equal(status.counts.duplicates, 1);
    assert.equal(status.tracks.length, 2);
    assert.equal(await fs.readFile(first, "utf8"), "same bytes");
    assert.equal(await fs.readFile(second, "utf8"), "same bytes");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("force rescans and rehashes unchanged files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "narada-force-"));
  const dbPath = path.join(directory, "library.db");
  const file = path.join(directory, "a.mp3");
  let hashes = 0;
  const options = {
    root: directory,
    databasePath: dbPath,
    scan: async () => ({ files: [file], warnings: [] }),
    probe: makeProbe([]),
    hashFile: async (filePath: string) => {
      hashes += 1;
      const { hashFile } = await import("../../src/library/hash.js");
      return hashFile(filePath);
    },
  };
  try {
    await fs.writeFile(file, "content");
    await scanLibraryToDatabase(options);
    await scanLibraryToDatabase(options);
    assert.equal(hashes, 1);
    await scanLibraryToDatabase({ ...options, force: true });
    assert.equal(hashes, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
