import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { skip } from "node:test";

import { probeTrack } from "../../src/library/metadata.js";
import { probeTrackWithHelper, DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_MAX_STDOUT_BYTES, DEFAULT_MAX_STDERR_BYTES } from "../../src/library/metadata.internal.js";

async function withFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narada-metadata-"));
  try { return await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function helper(root: string, name: string, body: string): Promise<string> {
  const file = path.join(root, name);
  await fs.writeFile(file, body);
  return file;
}

async function waitForPidFile(file: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await fs.readFile(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch { /* helper has not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PID file not created: ${file}`);
}

async function assertExited(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolve) => { timer = setTimeout(resolve, 50); });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  throw new Error(`Process still alive: ${pid}`);
}

test("production argv is the fixed ffprobe array and shell is disabled", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "spaced file;quote.mp3");
    await fs.writeFile(audio, "audio");
    const argvFile = path.join(root, "argv.json");
    const source = path.join(root, "argv-bin.c");
    const executable = path.join(root, "argv-bin");
    await fs.writeFile(source, `#include <stdio.h>\n#include <stdlib.h>\nint main(int argc, char **argv) {\n  const char *file = getenv("NARADA_ARGV_FILE");\n  FILE *out = fopen(file, "w");\n  if (!out) return 2;\n  fputc('[', out);\n  for (int i = 1; i < argc; ++i) {\n    if (i > 1) fputc(',', out);\n    fputc('"', out);\n    for (const char *p = argv[i]; *p; ++p) {\n      if (*p == '\\\\' || *p == '"') fputc('\\\\', out);\n      fputc(*p, out);\n    }\n    fputc('"', out);\n  }\n  fputs("]", out);\n  fclose(out);\n  fputs("{\\"format\\":{\\"format_name\\":\\"mp3\\",\\"duration\\":\\"12.5\\",\\"tags\\":{\\"title\\":\\"Tagged\\",\\"artist\\":\\"Artist\\",\\"album\\":\\"Album\\"}}}", stdout);\n  return 0;\n}\n`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("cc", ["-std=c11", source, "-o", executable], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`cc exited ${code}`)));
    });
    const canonical = await fs.realpath(audio);
    const previous = process.env.NARADA_ARGV_FILE;
    process.env.NARADA_ARGV_FILE = argvFile;
    try {
      const recorded = await probeTrack(audio, { executable });
      assert.deepEqual(JSON.parse(await fs.readFile(argvFile, "utf8")), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", canonical]);
      assert.equal(recorded.track?.path, canonical);
      assert.equal(recorded.warning, undefined);
    } finally {
      if (previous === undefined) delete process.env.NARADA_ARGV_FILE;
      else process.env.NARADA_ARGV_FILE = previous;
    }
  });
});

test("malformed JSON preserves fallback track", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "broken name.mp3");
    await fs.writeFile(audio, "1234");
    const executable = await helper(root, "bad-json.mjs", "process.stdout.write('not-json');\n");
    const result = await probeTrackWithHelper(audio, { executable: process.execPath }, executable);
    const canonical = await fs.realpath(audio);
    assert.equal(result.track?.id, canonical);
    assert.equal(result.track?.title, "broken name");
    assert.equal(result.track?.sizeBytes, 4);
    assert.match(result.warning?.message ?? "", /malformed JSON/);
  });
});

test("missing tags keep filename title and omit artist and album", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "plain.flac");
    await fs.writeFile(audio, "x");
    const executable = await helper(root, "tags.mjs", "process.stdout.write(JSON.stringify({format:{format_name:'mp3'}}));\n");
    const result = await probeTrackWithHelper(audio, { executable: process.execPath }, executable);
    assert.equal(result.track?.title, "plain");
    assert.equal(result.track?.artist, undefined);
    assert.equal(result.track?.album, undefined);
    assert.equal(result.track?.format, "mp3");
    assert.equal(result.warning, undefined);
  });
});

test("invalid duration preserves the track and warns", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "fallback.wav");
    await fs.writeFile(audio, "1234");
    const executable = await helper(root, "duration.mjs", "process.stdout.write(JSON.stringify({format:{duration:'bad',tags:{}}}));\n");
    const result = await probeTrackWithHelper(audio, { executable: process.execPath }, executable);
    assert.equal(result.track?.title, "fallback");
    assert.equal(result.track?.sizeBytes, 4);
    assert.equal(result.track?.durationSeconds, undefined);
    assert.match(result.warning?.message ?? "", /invalid duration/);
  });
});

test("canonicalization failure returns a warning without a track", async () => {
  const result = await probeTrack(path.join(os.tmpdir(), "narada-missing-track-does-not-exist.mp3"));
  assert.equal(result.track, undefined);
  assert.match(result.warning?.message ?? "", /Unable to inspect track/);
});

const statFailure = process.getuid?.() === 0 ? skip : test;
statFailure("stat failure returns a warning without a track", async () => {
  await withFixture(async (root) => {
    const dir = path.join(root, "locked");
    const audio = path.join(dir, "hidden.mp3");
    await fs.mkdir(dir);
    await fs.writeFile(audio, "x");
    await fs.chmod(dir, 0);
    try {
      const result = await probeTrack(audio);
      assert.equal(result.track, undefined);
      assert.match(result.warning?.message ?? "", /Unable to inspect track/);
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });
});

test("missing executable preserves fallback track", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "missing-bin.mp3");
    await fs.writeFile(audio, "ab");
    const started = Date.now();
    const result = await probeTrack(audio, { executable: "/nonexistent/ffprobe", timeoutMs: 500 });
    assert.ok(Date.now() - started < 2000);
    assert.equal(result.track?.title, "missing-bin");
    assert.equal(result.track?.sizeBytes, 2);
    assert.match(result.warning?.message ?? "", /Unable to run ffprobe/);
  });
});

test("nonzero exit preserves fallback and the child has exited", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "failed.mp3");
    await fs.writeFile(audio, "z");
    const pidFile = path.join(root, "pid");
    const executable = await helper(root, "exit.mjs", `import fs from 'node:fs/promises'; await fs.writeFile(${JSON.stringify(pidFile)}, String(process.pid)); process.exit(1);\n`);
    const pidPromise = waitForPidFile(pidFile);
    const result = await probeTrackWithHelper(audio, { executable: process.execPath }, executable);
    assert.equal(result.track?.title, "failed");
    assert.equal(result.track?.sizeBytes, 1);
    assert.match(result.warning?.message ?? "", /exit code 1/);
    await assertExited(await pidPromise, 2000);
  });
});

test("stdout bound escalates to SIGKILL and preserves fallback", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "stdout.mp3");
    await fs.writeFile(audio, "q");
    const pidFile = path.join(root, "pid");
    const executable = await helper(root, "stdout.mjs", `import fs from 'node:fs/promises'; await fs.writeFile(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); while (true) { process.stdout.write('x'.repeat(400)); await new Promise((resolve) => setTimeout(resolve, 5)); }\n`);
    const pidPromise = waitForPidFile(pidFile);
    const result = await probeTrackWithHelper(audio, { executable: process.execPath, maxStdoutBytes: 1024, timeoutMs: 2000 }, executable);
    assert.equal(result.track?.title, "stdout");
    assert.match(result.warning?.message ?? "", /stdout exceeded configured limit/);
    await assertExited(await pidPromise);
  });
});

test("stderr bound escalates to SIGKILL and preserves fallback", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "stderr.mp3");
    await fs.writeFile(audio, "q");
    const pidFile = path.join(root, "pid");
    const executable = await helper(root, "stderr.mjs", `import fs from 'node:fs/promises'; await fs.writeFile(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); while (true) { process.stderr.write('y'.repeat(400)); await new Promise((resolve) => setTimeout(resolve, 5)); }\n`);
    const pidPromise = waitForPidFile(pidFile);
    const result = await probeTrackWithHelper(audio, { executable: process.execPath, maxStderrBytes: 1024, timeoutMs: 2000 }, executable);
    assert.equal(result.track?.title, "stderr");
    assert.match(result.warning?.message ?? "", /stderr exceeded configured limit/);
    await assertExited(await pidPromise);
  });
});

test("timeout escalates to SIGKILL and preserves fallback", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "hang.mp3");
    await fs.writeFile(audio, "q");
    const pidFile = path.join(root, "pid");
    const executable = await helper(root, "hang.mjs", `import fs from 'node:fs/promises'; await fs.writeFile(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`);
    const pidPromise = waitForPidFile(pidFile);
    const result = await probeTrackWithHelper(audio, { executable: process.execPath, timeoutMs: 100 }, executable);
    assert.equal(result.track?.title, "hang");
    assert.match(result.warning?.message ?? "", /timed out/);
    await assertExited(await pidPromise);
  });
});

test("probe defaults match the Phase 2 spec", () => {
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 5000);
  assert.equal(DEFAULT_MAX_STDOUT_BYTES, 1024 * 1024);
  assert.equal(DEFAULT_MAX_STDERR_BYTES, 64 * 1024);
});

skip("cleanup failure is not asserted: a live child that neither exits nor reports kill() false cannot be forced without mocking child_process", () => {});
