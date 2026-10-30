import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_SCAN_HELPER, scanLibrary } from "../../src/library/scanner.js";

test("the native scanner helper is resolved from the module, not process.cwd()", () => {
  assert.ok(path.isAbsolute(DEFAULT_SCAN_HELPER));
  assert.doesNotMatch(DEFAULT_SCAN_HELPER, /^dist[\\/]/);
  assert.equal(path.basename(DEFAULT_SCAN_HELPER), "narada-scan");
});

test("scanning works from an unrelated working directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narada-cwd-"));
  const originalCwd = process.cwd();
  try {
    await fs.writeFile(path.join(root, "track.mp3"), Buffer.from("ID3fake"));
    await fs.mkdir(path.join(root, "EmptyFolder"));
    process.chdir(os.tmpdir());
    const result = await scanLibrary({ root });
    assert.deepEqual(result.files, [path.join(root, "track.mp3")]);
    assert.deepEqual(result.warnings, []);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
  }
});
