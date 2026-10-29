import { spawn } from "node:child_process";

import { ChildProcessRegistry } from "../process/childRegistry.js";
import type { Track } from "../library/types.js";
import type { BackendEvent, BackendEventHandler, PlaybackBackend, PlaybackState } from "./types.js";

export type VlcProcess = {
  pid?: number;
  stdin: { write(chunk: string): unknown; end?(): void } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string | number): boolean;
};

export type SpawnVlc = (
  executable: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"] },
) => VlcProcess;

export type VlcBackendOptions = {
  executable?: string;
  audioOutput?: string;
  spawn?: SpawnVlc;
  registry?: ChildProcessRegistry;
  startupTimeoutMs?: number;
  stopGraceMs?: number;
  initialVolume?: number;
};

function clampVolume(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function vlcVolume(percent: number): number {
  return Math.round((clampVolume(percent) / 100) * 256);
}

const defaultSpawn: SpawnVlc = (executable, args, options) =>
  spawn(executable, args, options) as unknown as VlcProcess;

/**
 * Headless VLC backend using the RC interface.
 *
 * Narada owns exactly one VLC child at a time and registers it with the shared
 * child registry. No other VLC process is discovered or signalled.
 */
export class VlcBackend implements PlaybackBackend {
  private readonly executable: string;
  private readonly audioOutput: string | undefined;
  private readonly spawnVlc: SpawnVlc;
  private readonly registry: ChildProcessRegistry;
  private readonly startupTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly handlers = new Set<BackendEventHandler>();
  private state: PlaybackState = "idle";
  private current: Track | undefined;
  private child: VlcProcess | undefined;
  private volume: number;
  private intentionalStop = false;
  private stderr = "";
  private stopTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: VlcBackendOptions = {}) {
    this.executable = options.executable ?? "cvlc";
    this.audioOutput = options.audioOutput;
    this.spawnVlc = options.spawn ?? defaultSpawn;
    this.registry = options.registry ?? new ChildProcessRegistry();
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5000;
    this.stopGraceMs = options.stopGraceMs ?? 300;
    this.volume = clampVolume(options.initialVolume ?? 70);
  }

  async load(track: Track): Promise<void> {
    this.stopChild();
    this.current = track;
    this.stderr = "";
    this.intentionalStop = false;
    this.state = "playing";
    this.emit({ type: "state", state: this.state });

    const args = [
      "-I", "rc",
      "--rc-fake-tty",
      "--no-video",
      "--no-osd",
      "--no-playlist-autostart",
      "--play-and-exit",
      ...(this.audioOutput === undefined ? [] : ["--aout", this.audioOutput]),
      track.path,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnVlc(this.executable, args, { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      this.registry.register(child);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.state = "error";
        this.emit({ type: "error", message: `VLC did not start within ${this.startupTimeoutMs}ms`, track });
        child.kill("SIGTERM");
        reject(new Error("VLC startup timed out"));
      }, this.startupTimeoutMs);

      child.stdout?.on("data", () => {
        // RC output is intentionally ignored; state is tracked explicitly.
      });
      child.stderr?.on("data", (chunk) => {
        this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4096);
      });
      child.on("spawn", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.write(`volume ${vlcVolume(this.volume)}\n`);
        resolve();
      });
      child.on("error", (error) => {
        if (settled) {
          this.fail(error.message);
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.fail(error.message);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        if (settled === false) {
          settled = true;
          clearTimeout(timer);
          const detail = this.stderr.trim() || `VLC exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
          this.fail(detail);
          reject(new Error(detail));
          return;
        }
        this.handleExit(code, signal);
      });
    });
  }

  async play(): Promise<void> {
    if (this.child !== undefined) {
      if (this.state === "paused") await this.resume();
      return;
    }
    if (this.current !== undefined) {
      await this.load(this.current);
      return;
    }
    throw new Error("No track loaded");
  }

  async pause(): Promise<void> {
    if (this.state !== "playing") return;
    this.write("pause\n");
    this.state = "paused";
    this.emit({ type: "state", state: this.state });
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    this.write("pause\n");
    this.state = "playing";
    this.emit({ type: "state", state: this.state });
  }

  async stop(): Promise<void> {
    this.stopChild();
    this.state = "stopped";
    this.emit({ type: "state", state: this.state });
  }

  async setVolume(percent: number): Promise<void> {
    this.volume = clampVolume(percent);
    this.write(`volume ${vlcVolume(this.volume)}\n`);
  }

  getState(): PlaybackState {
    return this.state;
  }

  getCurrent(): Track | undefined {
    return this.current;
  }

  getVolume(): number {
    return this.volume;
  }

  onEvent(handler: BackendEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.stopChild();
    this.state = "idle";
    this.current = undefined;
    this.handlers.clear();
  }

  private write(command: string): void {
    try {
      this.child?.stdin?.write(command);
    } catch {
      // A dead child will be reported by its exit handler.
    }
  }

  private stopChild(): void {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    this.intentionalStop = true;
    try {
      child.stdin?.write("stop\nquit\n");
      child.stdin?.end?.();
    } catch {
      // Best effort.
    }
    this.registry.unregister(child);
    if (this.stopTimer !== undefined) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = undefined;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }, this.stopGraceMs);
    this.stopTimer.unref?.();
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.stopTimer !== undefined) {
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    if (this.child !== undefined) this.registry.unregister(this.child);
    this.child = undefined;
    if (this.intentionalStop) {
      this.intentionalStop = false;
      return;
    }
    if (this.state === "error") return;
    if (code === 0 || signal === "SIGTERM" || code === null) {
      const track = this.current;
      this.state = "stopped";
      this.emit({ type: "state", state: this.state });
      if (track !== undefined) this.emit({ type: "ended", track });
      return;
    }
    const detail = this.stderr.trim() || `VLC exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
    this.fail(detail);
  }

  private fail(message: string): void {
    this.state = "error";
    this.emit({ type: "error", message, track: this.current });
  }

  private emit(event: BackendEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
