import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_AUDIO_PROBE_TIMEOUT_MS,
  DEFAULT_AUDIO_MAX_STDOUT_BYTES,
  DEFAULT_AUDIO_MAX_STDERR_BYTES,
  probeAudio,
} from "../../src/analysis/probeWorker.js";

async function withFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narada-worker-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function worker(root: string, name: string, body: string): Promise<string> {
  const file = path.join(root, name);
  await fs.writeFile(file, body);
  return file;
}

const VALID_FEATURES = {
  durationSeconds: 12.5,
  sampleRate: 22050,
  channels: 1,
  tempoBpm: 90,
  rmsEnergy: 0.1,
  spectralCentroidHz: 1200,
  zeroCrossingRate: 0.05,
};

test("parses valid worker JSON into typed features", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "track with space.mp3");
    await fs.writeFile(audio, "audio");
    const script = await worker(
      root,
      "ok.mjs",
      `process.stdout.write(JSON.stringify(${JSON.stringify({ ok: true, features: VALID_FEATURES })}));\n`,
    );
    const result = await probeAudio(audio, { executable: process.execPath, workerScript: script });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.features, VALID_FEATURES);
  });
});

test("malformed worker JSON returns a warning", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "broken.mp3");
    await fs.writeFile(audio, "audio");
    const script = await worker(root, "bad-json.mjs", "process.stdout.write('not-json');\n");
    const result = await probeAudio(audio, { executable: process.execPath, workerScript: script });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warning.message, /malformed JSON/);
  });
});

test("invalid feature shape returns a warning", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "shape.mp3");
    await fs.writeFile(audio, "audio");
    const script = await worker(root, "bad-shape.mjs", "process.stdout.write(JSON.stringify({ok:true,features:{durationSeconds:'x'}}));\n");
    const result = await probeAudio(audio, { executable: process.execPath, workerScript: script });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warning.message, /invalid feature/);
  });
});

test("worker-reported failure returns a warning", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "reported.mp3");
    await fs.writeFile(audio, "audio");
    const script = await worker(root, "reported.mjs", "process.stdout.write(JSON.stringify({ok:false,error:'decoder unavailable'}));\n");
    const result = await probeAudio(audio, { executable: process.execPath, workerScript: script });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warning.message, /decoder unavailable/);
  });
});

test("nonzero exit returns a warning", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "exit.mp3");
    await fs.writeFile(audio, "audio");
    const script = await worker(root, "exit.mjs", "process.stderr.write('boom'); process.exit(2);\n");
    const result = await probeAudio(audio, { executable: process.execPath, workerScript: script });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warning.message, /exit code 2/);
  });
});

test("missing executable returns a warning", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "missing.mp3");
    await fs.writeFile(audio, "audio");
    const started = Date.now();
    const result = await probeAudio(audio, { executable: "/nonexistent/python", workerScript: "/nonexistent/worker.py", timeoutMs: 500 });
    assert.ok(Date.now() - started < 2000);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warning.message, /Unable to run audio worker/);
  });
});

test("missing audio path returns a warning without spawning", async () => {
  const result = await probeAudio(path.join(os.tmpdir(), "narada-missing-audio-does-not-exist.mp3"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.warning.message, /Unable to inspect audio/);
});

test("timeout terminates the worker and returns a warning", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "hang.mp3");
    await fs.writeFile(audio, "audio");
    const script = await worker(root, "hang.mjs", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
    const result = await probeAudio(audio, { executable: process.execPath, workerScript: script, timeoutMs: 100 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warning.message, /timed out/);
  });
});

test("abort signal terminates the worker and returns a warning", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "abort.mp3");
    await fs.writeFile(audio, "audio");
    const script = await worker(root, "abort.mjs", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await probeAudio(audio, {
      executable: process.execPath,
      workerScript: script,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warning.message, /aborted/);
  });
});

test("stdout bound terminates the worker and returns a warning", async () => {
  await withFixture(async (root) => {
    const audio = path.join(root, "stdout.mp3");
    await fs.writeFile(audio, "audio");
    const script = await worker(
      root,
      "stdout.mjs",
      "process.on('SIGTERM', () => {}); while (true) { process.stdout.write('x'.repeat(400)); }\n",
    );
    const result = await probeAudio(audio, { executable: process.execPath, workerScript: script, maxStdoutBytes: 1024, timeoutMs: 2000 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warning.message, /stdout exceeded/);
  });
});

test("audio probe defaults match the scaffold contract", () => {
  assert.equal(DEFAULT_AUDIO_PROBE_TIMEOUT_MS, 30000);
  assert.equal(DEFAULT_AUDIO_MAX_STDOUT_BYTES, 256 * 1024);
  assert.equal(DEFAULT_AUDIO_MAX_STDERR_BYTES, 64 * 1024);
});
