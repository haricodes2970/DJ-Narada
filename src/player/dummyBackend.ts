import type { Track } from "../library/types.js";
import type { BackendEvent, BackendEventHandler, PlaybackBackend, PlaybackState } from "./types.js";

/**
 * Deterministic backend for tests and for environments without an audio
 * device. It never spawns a process and never touches audio files.
 */
export class DummyBackend implements PlaybackBackend {
  private state: PlaybackState = "idle";
  private current: Track | undefined;
  private volume = 70;
  private readonly handlers = new Set<BackendEventHandler>();
  readonly calls: string[] = [];

  async load(track: Track): Promise<void> {
    this.current = track;
    this.state = "stopped";
    this.calls.push(`load:${track.id}`);
    this.emit({ type: "state", state: this.state });
  }

  async play(): Promise<void> {
    if (this.current === undefined) throw new Error("No track loaded");
    this.state = "playing";
    this.calls.push("play");
    this.emit({ type: "state", state: this.state });
  }

  async pause(): Promise<void> {
    if (this.state !== "playing") return;
    this.state = "paused";
    this.calls.push("pause");
    this.emit({ type: "state", state: this.state });
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    this.state = "playing";
    this.calls.push("resume");
    this.emit({ type: "state", state: this.state });
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    this.calls.push("stop");
    this.emit({ type: "state", state: this.state });
  }

  async setVolume(percent: number): Promise<void> {
    this.volume = Math.max(0, Math.min(100, Math.round(percent)));
    this.calls.push(`volume:${this.volume}`);
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

  /** Test hook: simulate the current track reaching its natural end. */
  finish(): void {
    if (this.current === undefined) return;
    const track = this.current;
    this.state = "stopped";
    this.calls.push("finish");
    this.emit({ type: "ended", track });
  }

  /** Test hook: simulate a decoder/backend failure. */
  fail(message: string): void {
    this.state = "error";
    this.calls.push(`fail:${message}`);
    this.emit({ type: "error", message, track: this.current });
  }

  async close(): Promise<void> {
    this.state = "idle";
    this.calls.push("close");
    this.handlers.clear();
  }

  private emit(event: BackendEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
