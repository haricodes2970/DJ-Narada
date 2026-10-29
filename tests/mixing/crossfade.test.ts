import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  crossfadeArgs,
  crossfadeCacheKey,
  normalizeCrossfadeSettings,
  planCrossfade,
  renderCrossfade,
  type CrossfadePlan,
  type FfmpegProcess,
  type SpawnFfmpeg,
} from "../../src/mixing/crossfade.js";
import type { Track } from "../../src/library/types.js";

const from: Track = {
  id: "/music/a.mp3",
  path: "/music/a.mp3",
  title: "A",
  durationSeconds: 180,
  sizeBytes: 100,
};
const to: Track = {
  id: "/music/b.mp3",
  path: "/music/b.mp3",
  title: "B",
  durationSeconds: 200,
  sizeBytes: 200,
};

class FakeFfmpeg {
  stderr = {
    listeners: [] as ((chunk: Buffer | string) => void)[],
    on: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      this.stderr.listeners.push(listener);
      return this.stderr;
    },
    emit: (chunk: Buffer | string) => {
      for (const listener of this.stderr.listeners) listener(chunk);
    },
  };
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  killed: string | number | undefined;

  on(event: string, listener: (...args: unknown[]) => void): this {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  kill(signal?: string | number): boolean {
    this.killed = signal;
    return true;
  }
}

function fakeSpawn(onSpawn: (args: string[], process: FakeFfmpeg) => void): { spawn: SpawnFfmpeg; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnFfmpeg = (_executable, args) => {
    calls.push(args);
    const process = new FakeFfmpeg();
    setTimeout(() => onSpawn(args, process), 0);
    return process as unknown as FfmpegProcess;
  };
  return { spawn, calls };
}

test("crossfade settings normalize and clamp", () => {
  const settings = normalizeCrossfadeSettings({ durationSeconds: 99, maxDurationSeconds: 12, curve: "qsin" });
  assert.equal(settings.enabled, true);
  assert.equal(settings.durationSeconds, 12);
  assert.equal(settings.curve, "qsin");
  assert.equal(normalizeCrossfadeSettings({ enabled: false }).enabled, false);
  assert.equal(normalizeCrossfadeSettings({ minDurationSeconds: 5, maxDurationSeconds: 2 }).maxDurationSeconds, 5);
});

test("planCrossfade is conservative and disabled for unsafe cases", () => {
  const plan = planCrossfade(from, to, { durationSeconds: 8 });
  assert.equal(plan.enabled, true);
  assert.equal(plan.durationSeconds, 8);
  assert.equal(plan.overlapStartSeconds, 172);

  const short = planCrossfade(
    { ...from, durationSeconds: 3 },
    { ...to, durationSeconds: 2 },
    { durationSeconds: 8, minDurationSeconds: 1 },
  );
  assert.equal(short.enabled, true);
  assert.equal(short.durationSeconds, 1);

  const tooShort = planCrossfade(
    { ...from, durationSeconds: 0.6 },
    { ...to, durationSeconds: 0.6 },
    { durationSeconds: 2, minDurationSeconds: 1 },
  );
  assert.equal(tooShort.enabled, false);
  assert.match(tooShort.reason, /too short/);

  assert.equal(planCrossfade(from, from).enabled, false);
  assert.equal(planCrossfade(from, to, { enabled: false }).enabled, false);
});

test("crossfadeArgs uses a bounded tail/head blend", () => {
  const plan = planCrossfade(from, to, { durationSeconds: 5, curve: "esin" });
  const args = crossfadeArgs(plan, "/tmp/out.wav");
  assert.deepEqual(args.slice(0, 5), ["-y", "-nostdin", "-hide_banner", "-v", "error"]);
  assert.ok(args.includes("-ss"));
  assert.ok(args.includes("175.000"));
  assert.ok(args.includes("5.000"));
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /acrossfade=d=5\.000:c1=esin:c2=esin/);
  assert.equal(args[args.length - 1], "/tmp/out.wav");
});

test("crossfadeArgs falls back to sseof for unknown duration", () => {
  const plan = planCrossfade({ ...from, durationSeconds: undefined }, to, { durationSeconds: 4 });
  const args = crossfadeArgs(plan, "/tmp/out.wav");
  assert.ok(args.includes("-sseof"));
  assert.ok(args.includes("-4.000"));
});

test("cache keys are deterministic and sensitive to transition settings", () => {
  const plan = planCrossfade(from, to, { durationSeconds: 5 });
  assert.equal(crossfadeCacheKey(plan), crossfadeCacheKey(plan));
  assert.notEqual(crossfadeCacheKey(plan), crossfadeCacheKey({ ...plan, curve: "log" }));
  assert.notEqual(crossfadeCacheKey(plan), crossfadeCacheKey({ ...plan, durationSeconds: 4 }));
  assert.notEqual(
    crossfadeCacheKey(plan, { fromMtimeMs: 1 }),
    crossfadeCacheKey(plan, { fromMtimeMs: 2 }),
  );
});

test("renderCrossfade stores a successful render and reuses the cache", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "narada-crossfade-"));
  try {
    const fromPath = path.join(directory, "from.mp3");
    const toPath = path.join(directory, "to.mp3");
    await fsp.writeFile(fromPath, "from");
    await fsp.writeFile(toPath, "to");
    const plan = planCrossfade({ ...from, path: fromPath }, { ...to, path: toPath }, { durationSeconds: 2 });
    const fake = fakeSpawn((args, process) => {
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(128));
      process.emit("exit", 0, null);
    });

    const first = await renderCrossfade(plan, { cacheDir: path.join(directory, "cache"), spawn: fake.spawn });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.cached, false);
    assert.equal(fs.existsSync(first.path), true);
    assert.equal(fake.calls.length, 1);

    const second = await renderCrossfade(plan, { cacheDir: path.join(directory, "cache"), spawn: fake.spawn });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.cached, true);
    assert.equal(fake.calls.length, 1);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("renderCrossfade returns an actionable fallback on ffmpeg failure", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "narada-crossfade-fail-"));
  try {
    const fromPath = path.join(directory, "from.mp3");
    const toPath = path.join(directory, "to.mp3");
    await fsp.writeFile(fromPath, "from");
    await fsp.writeFile(toPath, "to");
    const plan = planCrossfade({ ...from, path: fromPath }, { ...to, path: toPath }, { durationSeconds: 2 });
    const fake = fakeSpawn((_args, process) => {
      process.stderr.emit(Buffer.from("decoder exploded"));
      process.emit("exit", 1, null);
    });
    const result = await renderCrossfade(plan, { cacheDir: path.join(directory, "cache"), spawn: fake.spawn });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /decoder exploded/);
    assert.equal(fs.existsSync(path.join(directory, "cache")), true);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

function writeSineWav(filePath: string, seconds: number, frequency: number, sampleRate = 48_000): void {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.25;
    data.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

test("real ffmpeg renders a one-second crossfade", { timeout: 20_000 }, async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "narada-crossfade-real-"));
  try {
    const fromPath = path.join(directory, "from.wav");
    const toPath = path.join(directory, "to.wav");
    writeSineWav(fromPath, 2, 440);
    writeSineWav(toPath, 2, 660);
    const plan = planCrossfade(
      { id: fromPath, path: fromPath, title: "From", durationSeconds: 2, sizeBytes: fs.statSync(fromPath).size },
      { id: toPath, path: toPath, title: "To", durationSeconds: 2, sizeBytes: fs.statSync(toPath).size },
      { durationSeconds: 1 },
    );
    const result = await renderCrossfade(plan, { cacheDir: path.join(directory, "cache") });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(fs.statSync(result.path).size > 44, true);
    const probe = spawnSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      result.path,
    ], { encoding: "utf8" });
    assert.equal(probe.status, 0);
    const duration = Number(probe.stdout.trim());
    assert.ok(duration > 0.9 && duration < 1.2, `unexpected duration ${duration}`);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
