import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashFile } from "../../src/library/hash.js";

test("hashFile returns the sha256 of file content", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "narada-hash-"));
  try {
    const file = path.join(directory, "hello.txt");
    await fs.writeFile(file, "hello");
    assert.equal(await hashFile(file), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("hashFile supports alternate algorithms", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "narada-hash-"));
  try {
    const file = path.join(directory, "hello.txt");
    await fs.writeFile(file, "hello");
    assert.equal(await hashFile(file, { algorithm: "md5" }), "5d41402abc4b2a76b9719d911017c592");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("hashFile rejects missing files", async () => {
  await assert.rejects(() => hashFile("/definitely/not/here.mp3"));
});
