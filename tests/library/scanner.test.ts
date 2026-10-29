import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_AUDIO_EXTENSIONS,
  DEFAULT_EXCLUDED_ROOT,
  scanLibrary,
} from "../../src/library/scanner.js";

async function withFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narada-scanner-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function snapshot(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string): Promise<void> {
    const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      const relative = path.relative(root, childPath);
      const stats = await fs.lstat(childPath);
      entries.push(`${relative}|${stats.mode}|${stats.size}|${stats.mtimeMs}|${child.isSymbolicLink()}`);
      if (child.isDirectory()) await visit(childPath);
    }
  }
  await visit(root);
  return entries.join("\n");
}

test("discovers supported audio recursively and filters extensions case-insensitively", async () => {
  await withFixture(async (root) => {
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "song.MP3"), "audio");
    await fs.writeFile(path.join(root, "track.flac"), "audio");
    await fs.writeFile(path.join(root, "cover.jpg"), "image");

    const result = await scanLibrary({ root, excludedRoots: [] });

    assert.deepEqual(result.files, [
      path.join(root, "nested", "song.MP3"),
      path.join(root, "track.flac"),
    ]);
    assert.deepEqual(result.warnings, []);
  });
});

test("returns deterministic sorted paths and removes duplicate canonical paths", async () => {
  await withFixture(async (root) => {
    await fs.mkdir(path.join(root, "z"));
    await fs.mkdir(path.join(root, "a"));
    await fs.writeFile(path.join(root, "z", "z.mp3"), "z");
    await fs.writeFile(path.join(root, "a", "a.mp3"), "a");
    await fs.symlink(path.join(root, "a", "a.mp3"), path.join(root, "alias.mp3"));

    const result = await scanLibrary({ root, excludedRoots: [] });

    assert.deepEqual(result.files, [
      path.join(root, "a", "a.mp3"),
      path.join(root, "z", "z.mp3"),
    ]);
    assert.equal(new Set(result.files).size, result.files.length);
  });
});

test("keeps the application directory excluded when custom exclusions are empty", async () => {
  const result = await scanLibrary({
    root: DEFAULT_EXCLUDED_ROOT,
    excludedRoots: [],
  });

  assert.deepEqual(result.files, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.path, DEFAULT_EXCLUDED_ROOT);
  assert.match(result.warnings[0]?.message ?? "", /excluded/i);
});

test("keeps the application directory excluded when custom exclusions omit it", async () => {
  const result = await scanLibrary({
    root: DEFAULT_EXCLUDED_ROOT,
    excludedRoots: [path.dirname(DEFAULT_EXCLUDED_ROOT)],
  });

  assert.deepEqual(result.files, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.path, DEFAULT_EXCLUDED_ROOT);
});

test("excludes the complete DJ subtree but does not exclude DJ-other", async () => {
  await withFixture(async (root) => {
    const dj = path.join(root, "DJ");
    await fs.mkdir(path.join(dj, "nested"), { recursive: true });
    await fs.mkdir(path.join(root, "DJ-other"));
    await fs.writeFile(path.join(dj, "nested", "private.mp3"), "private");
    await fs.writeFile(path.join(root, "DJ-other", "allowed.mp3"), "allowed");

    const result = await scanLibrary({ root, excludedRoots: [dj] });

    assert.deepEqual(result.files, [path.join(root, "DJ-other", "allowed.mp3")]);
  });
});

test("returns an empty successful result when root equals or is inside an exclusion", async () => {
  await withFixture(async (root) => {
    const excluded = path.join(root, "DJ");
    await fs.mkdir(path.join(excluded, "nested"), { recursive: true });
    await fs.writeFile(path.join(excluded, "nested", "private.mp3"), "private");

    const exact = await scanLibrary({ root: excluded, excludedRoots: [excluded] });
    const descendant = await scanLibrary({
      root: path.join(excluded, "nested"),
      excludedRoots: [excluded],
    });

    assert.deepEqual(exact.files, []);
    assert.deepEqual(descendant.files, []);
    assert.equal(exact.warnings.length, 1);
    assert.equal(descendant.warnings.length, 1);
  });
});

test("does not follow symlinks, including links targeting the excluded subtree", async () => {
  await withFixture(async (root) => {
    const excluded = path.join(root, "DJ");
    await fs.mkdir(excluded);
    await fs.writeFile(path.join(excluded, "private.mp3"), "private");
    await fs.symlink(excluded, path.join(root, "linked-dj"));
    await fs.symlink(path.join(root, "missing.mp3"), path.join(root, "broken.mp3"));

    const result = await scanLibrary({ root, excludedRoots: [excluded] });

    assert.deepEqual(result.files, []);
    assert.equal(result.warnings.length, 2);
    assert.deepEqual(result.warnings.map((warning) => warning.path).sort(), [
      path.join(root, "broken.mp3"),
      path.join(root, "linked-dj"),
    ]);
    assert.ok(result.warnings.every((warning) => /symbolic link/i.test(warning.message)));
  });
});


test("handles missing roots without throwing", async () => {
  await withFixture(async (root) => {
    const missing = path.join(root, "does-not-exist");
    const result = await scanLibrary({ root: missing, excludedRoots: [] });

    assert.deepEqual(result.files, []);
    assert.equal(result.warnings.length, 1);
  });
});

test("does not write or modify fixture entries while scanning", async () => {
  await withFixture(async (root) => {
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "track.wav"), "audio");
    const before = await snapshot(root);

    await scanLibrary({ root, excludedRoots: [] });

    assert.equal(await snapshot(root), before);
  });
});

test("uses the documented supported extension set", () => {
  assert.deepEqual(DEFAULT_AUDIO_EXTENSIONS, new Set([
    ".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".wma",
    ".aiff", ".aif", ".alac", ".ape", ".wv", ".mka", ".mp2", ".amr",
    ".ac3", ".dts", ".mid", ".midi", ".caf", ".3gp", ".3g2", ".webm",
    ".ra", ".rm", ".tta", ".dsf", ".dff",
  ]));
});
