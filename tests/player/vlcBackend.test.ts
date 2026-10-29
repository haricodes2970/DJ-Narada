import assert from "node:assert/strict";
import test from "node:test";

import { ChildProcessRegistry } from "../../src/process/childRegistry.js";
import type { Track } from "../../src/library/types.js";
import { VlcBackend, type SpawnVlc, type VlcProcess } from "../../src/player/vlcBackend.js";
import type { BackendEvent } from "../../src/player/types.js";

const track: Track = {
  id: "/music/a.mp3",
  path: "/music/a.mp3",
  title: "A",
  durationSeconds: 120,
  sizeBytes: 1,
};

class FakeProcess {
  pid = 1234;
  stdin = {
    writes: [] as string[],
    write: (chunk: string) => {
      this.stdin.writes.push(chunk);
      return true;
    },
    end: () => {
      this.stdin.ended = true;
    },
    ended: false,
  };
  stdout = { on: () => this.stdout };
  stderr = { on: () => this.stderr };
  killed: string | number | undefined;
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

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

function setup(options: { audioOutput?: string } = {}) {
  const fake = new FakeProcess();
  const registry = new ChildProcessRegistry();
  let args: string[] = [];
  const spawn: SpawnVlc = (_executable, spawnArgs) => {
    args = spawnArgs;
    return fake as unknown as VlcProcess;
  };
  const backend = new VlcBackend({
    spawn,
    registry,
    audioOutput: options.audioOutput,
    startupTimeoutMs: 100,
    stopGraceMs: 1,
    initialVolume: 60,
  });
  return { backend, fake, registry, getArgs: () => args };
}

test("VlcBackend spawns an owned RC process and sends initial volume", async () => {
  const { backend, fake, registry, getArgs } = setup({ audioOutput: "dummy" });
  const events: BackendEvent[] = [];
  backend.onEvent((event) => events.push(event));

  const loading = backend.load(track);
  fake.emit("spawn");
  await loading;

  const args = getArgs();
  assert.equal(args[0], "-I");
  assert.equal(args[1], "rc");
  assert.ok(args.includes("--aout"));
  assert.ok(args.includes("dummy"));
  assert.ok(args.includes(track.path));
  assert.equal(backend.getState(), "playing");
  await backend.play();
  assert.ok(fake.stdin.writes.includes("play\n"));
  assert.equal(registry.size(), 1);
  assert.ok(fake.stdin.writes.some((write) => write === "volume 154\n"));
  assert.ok(events.some((event) => event.type === "state" && event.state === "playing"));
});

test("VlcBackend pauses, resumes and changes volume through RC", async () => {
  const { backend, fake } = setup();
  const loading = backend.load(track);
  fake.emit("spawn");
  await loading;
  fake.stdin.writes.length = 0;

  await backend.pause();
  assert.equal(backend.getState(), "paused");
  assert.deepEqual(fake.stdin.writes, ["pause\n"]);

  await backend.resume();
  assert.equal(backend.getState(), "playing");
  assert.deepEqual(fake.stdin.writes, ["pause\n", "pause\n"]);

  await backend.setVolume(70);
  assert.ok(fake.stdin.writes.includes("volume 179\n"));
});

test("VlcBackend reports natural end and unregisters the child", async () => {
  const { backend, fake, registry } = setup();
  const events: BackendEvent[] = [];
  backend.onEvent((event) => events.push(event));
  const loading = backend.load(track);
  fake.emit("spawn");
  await loading;

  fake.emit("exit", 0, null);
  assert.equal(backend.getState(), "stopped");
  assert.equal(registry.size(), 0);
  assert.ok(events.some((event) => event.type === "ended"));
});

test("VlcBackend rejects when the process fails before spawn", async () => {
  const { backend, fake } = setup();
  const events: BackendEvent[] = [];
  backend.onEvent((event) => events.push(event));
  const loading = backend.load(track);
  fake.emit("error", new Error("no vlc"));
  await assert.rejects(loading, /no vlc/);
  assert.equal(backend.getState(), "error");
  assert.ok(events.some((event) => event.type === "error"));
});

test("VlcBackend stop is idempotent and sends stop/quit", async () => {
  const { backend, fake, registry } = setup();
  const loading = backend.load(track);
  fake.emit("spawn");
  await loading;
  fake.stdin.writes.length = 0;

  await backend.stop();
  assert.equal(backend.getState(), "stopped");
  assert.equal(registry.size(), 0);
  assert.ok(fake.stdin.writes.includes("stop\nquit\n"));
  await backend.stop();
  assert.equal(backend.getState(), "stopped");
});

test("VlcBackend close clears state and unregisters", async () => {
  const { backend, fake, registry } = setup();
  const loading = backend.load(track);
  fake.emit("spawn");
  await loading;
  await backend.close();
  assert.equal(backend.getState(), "idle");
  assert.equal(registry.size(), 0);
  assert.equal(backend.getCurrent(), undefined);
});
