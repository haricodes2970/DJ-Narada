import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function withFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narada-native-scanner-"));
  try { return await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function runHelper(root: string, exclusions: string[] = [], testArguments: string[] = []): Promise<{ code: number | null; records: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const args = testArguments.length > 0
      ? [root, ...testArguments, ...exclusions]
      : [root, ...exclusions];
    const child = spawn(path.resolve("dist/native/narada-scan-test"), args, {
      shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      try { resolve({ code, records: output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) }); }
      catch (error) { reject(error); }
    });
  });
}

test("native helper skips symlinks and preserves DJ boundary", async () => {
  await withFixture(async (root) => {
    await fs.mkdir(path.join(root, "inside"));
    await fs.mkdir(path.join(root, "DJ"));
    await fs.mkdir(path.join(root, "DJ-other"));
    await fs.writeFile(path.join(root, "inside", "ok.mp3"), "ok");
    await fs.writeFile(path.join(root, "DJ", "private.mp3"), "private");
    await fs.writeFile(path.join(root, "DJ-other", "allowed.mp3"), "allowed");
    await fs.symlink(path.join(root, "inside"), path.join(root, "link-inside"));
    await fs.symlink("/tmp", path.join(root, "link-outside"));

    const result = await runHelper(root, [path.join(root, "DJ")]);
    const files = result.records.filter((record) => record.type === "file").map((record) => record.path).sort();
    const warnings = result.records.filter((record) => record.type === "warning");

    assert.deepEqual(files, [path.join(root, "DJ-other", "allowed.mp3"), path.join(root, "inside", "ok.mp3")]);
    assert.equal(warnings.filter((record) => record.code === "SYMLINK_SKIPPED").length, 2);
  });
});

test("production helper ignores test-only replacement and failure flags", async () => {
  await withFixture(async (root) => {
    const victim = path.join(root, "victim");
    await fs.mkdir(victim);
    await fs.writeFile(path.join(victim, "ok.mp3"), "ok");
    const child = spawn(path.resolve("dist/native/narada-scan"), [root], {
      shell: false, env: { ...process.env, NARADA_TEST_FAIL_READDIR: victim }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    assert.ok(output.includes(path.join(victim, "ok.mp3")));
    assert.ok(!output.includes("Injected test failure"));
  });
});

test("test-only replacement hook rejects replaced directory symlink", async () => {
  await withFixture(async (root) => {
    const victim = path.join(root, "victim");
    await fs.mkdir(victim);
    await fs.writeFile(path.join(victim, "hidden.mp3"), "hidden");
    const result = await runHelper(root, [], ["--test-replace-dir", victim, "/tmp"]);
    assert.ok(!result.records.some((record) => record.type === "file" && record.path === path.join(victim, "hidden.mp3")));
    assert.ok(result.records.some((record) => record.path === victim && record.code === "OPEN_FAILED"));
  });
});

test("test-only replacement hook rejects replaced file symlink", async () => {
  await withFixture(async (root) => {
    const replaced = path.join(root, "replaced.mp3");
    await fs.writeFile(replaced, "original");
    await fs.writeFile(path.join(root, "neighbor.mp3"), "neighbor");
    const result = await runHelper(root, [], ["--test-replace-file", replaced, "/tmp"]);
    assert.deepEqual(result.records.filter((record) => record.type === "file").map((record) => record.path), [path.join(root, "neighbor.mp3")]);
    assert.ok(result.records.some((record) => record.path === replaced && record.code === "OPEN_FAILED"));
  });
});

test("native helper rejects file symlink and accepts hard link inside root", async () => {
  await withFixture(async (root) => {
    await fs.writeFile(path.join(root, "real.mp3"), "real");
    await fs.link(path.join(root, "real.mp3"), path.join(root, "hard.mp3"));
    await fs.symlink(path.join(root, "real.mp3"), path.join(root, "link.mp3"));
    const result = await runHelper(root);
    const files = result.records.filter((record) => record.type === "file").map((record) => record.path).sort();
    assert.deepEqual(files, [path.join(root, "hard.mp3"), path.join(root, "real.mp3")]);
    assert.ok(result.records.some((record) => record.path === path.join(root, "link.mp3") && record.code === "SYMLINK_SKIPPED"));
  });
});

test("native helper reports disappearing file and continues siblings", async () => {
  await withFixture(async (root) => {
    const missing = path.join(root, "missing.mp3");
    await fs.writeFile(missing, "missing");
    await fs.writeFile(path.join(root, "visible.mp3"), "visible");
    const result = await runHelper(root, [], ["--test-disappear", missing]);
    assert.ok(result.records.some((record) => record.type === "file" && record.path === path.join(root, "visible.mp3")));
    assert.ok(result.records.some((record) => record.path === missing && record.code === "LSTAT_FAILED"));
  });
});

test("native helper reports disappearing directory and continues siblings", async () => {
  await withFixture(async (root) => {
    const missing = path.join(root, "missing-dir");
    await fs.mkdir(missing);
    await fs.writeFile(path.join(missing, "hidden.mp3"), "hidden");
    await fs.writeFile(path.join(root, "visible.mp3"), "visible");
    const result = await runHelper(root, [], ["--test-disappear", missing]);
    assert.ok(result.records.some((record) => record.type === "file" && record.path === path.join(root, "visible.mp3")));
    assert.ok(result.records.some((record) => record.path === missing && record.code === "LSTAT_FAILED"));
  });
});

test("mount-boundary policy is exercised only when isolated mount setup is permitted", async (context) => {
  await withFixture(async (root) => {
    const mountPoint = path.join(root, "mount-point");
    const source = path.join(root, "mount-source");
    await fs.mkdir(mountPoint);
    await fs.mkdir(source);
    const mount = spawn("mount", ["--bind", source, mountPoint], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const code = await new Promise<number | null>((resolve) => mount.on("close", resolve));
    if (code !== 0) {
      context?.diagnostic?.(`Skipped: bind mount unavailable in test environment (mount exit ${code})`);
      return;
    }
    try {
      await fs.writeFile(path.join(source, "mounted.mp3"), "mounted");
      const result = await runHelper(root);
      assert.ok(!result.records.some((record) => record.path === path.join(mountPoint, "mounted.mp3")));
    } finally {
      const unmount = spawn("umount", [mountPoint], { shell: false, stdio: ["ignore", "ignore", "ignore"] });
      await new Promise<void>((resolve) => unmount.on("close", () => resolve()));
    }
  });
});

test("native helper reports deterministic post-readdir stream error", async () => {
  await withFixture(async (root) => {
    const failed = path.join(root, "failed");
    await fs.mkdir(failed);
    await fs.writeFile(path.join(root, "visible.mp3"), "visible");
    const result = await runHelper(root, [], ["--test-stream-error", failed]);
    assert.ok(result.records.some((record) => record.path === failed && record.code === "READDIR_FAILED" && /Input\/output error|EIO/i.test(String(record.message))));
    assert.ok(result.records.some((record) => record.type === "file" && record.path === path.join(root, "visible.mp3")));
  });
});

test("native helper recovers from deterministic readdir failure", async () => {
  await withFixture(async (root) => {
    await fs.mkdir(path.join(root, "failed"));
    await fs.writeFile(path.join(root, "failed", "hidden.mp3"), "hidden");
    await fs.writeFile(path.join(root, "visible.mp3"), "visible");

    const result = await runHelper(root, [], ["--test-fail-readdir", path.join(root, "failed")]);
    const files = result.records.filter((record) => record.type === "file").map((record) => record.path);
    const failure = result.records.find((record) => record.path === path.join(root, "failed"));

    assert.deepEqual(files, [path.join(root, "visible.mp3")]);
    assert.equal(failure?.code, "READDIR_FAILED");
    assert.match(String(failure?.message), /Injected test failure/);
  });
});
