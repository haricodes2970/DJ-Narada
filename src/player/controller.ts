import type { Track } from "../library/types.js";
import type { PlaybackBackend, PlaybackState } from "./types.js";

export type PlaybackControllerEvent =
  | { type: "track"; track: Track; index: number }
  | { type: "state"; state: PlaybackState }
  | { type: "queue"; queue: Track[] }
  | { type: "volume"; volume: number }
  | { type: "error"; message: string };

export type PlaybackControllerOptions = {
  backend: PlaybackBackend;
  queue?: readonly Track[];
  volume?: number;
  autoAdvance?: boolean;
  now?: () => number;
  onEvent?: (event: PlaybackControllerEvent) => void;
};

export type PlaybackControllerState = {
  queue: Track[];
  index: number;
  track?: Track;
  status: PlaybackState;
  error?: string;
  volume: number;
  positionSeconds: number;
  durationSeconds: number;
};

function clampVolume(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * Owns queue navigation, playback state and elapsed time.
 *
 * The backend owns exactly one loaded track. This controller is the only place
 * that decides what plays next, so a natural end, a skip, and a queue edit all
 * converge on the same path.
 */
export class PlaybackController {
  private readonly backend: PlaybackBackend;
  private readonly autoAdvance: boolean;
  private readonly now: () => number;
  private readonly handlers = new Set<(event: PlaybackControllerEvent) => void>();
  private readonly unsubscribeBackend: (() => void) | undefined;
  private queue: Track[] = [];
  private index = -1;
  private status: PlaybackState = "idle";
  private error: string | undefined;
  private volume: number;
  private positionSeconds = 0;
  private durationSeconds = 0;
  private startedAt: number | undefined;

  constructor(options: PlaybackControllerOptions) {
    this.backend = options.backend;
    this.autoAdvance = options.autoAdvance ?? true;
    this.now = options.now ?? (() => Date.now());
    this.volume = clampVolume(options.volume ?? 70);
    this.queue = [...(options.queue ?? [])];
    if (this.queue.length > 0) this.index = 0;
    if (options.onEvent !== undefined) this.handlers.add(options.onEvent);
    this.unsubscribeBackend = this.backend.onEvent?.((event) => {
      if (event.type === "ended") void this.handleEnded();
      else if (event.type === "error") this.handleError(event.message);
    });
  }

  get current(): Track | undefined {
    return this.queue[this.index];
  }

  get upNext(): Track[] {
    if (this.index < 0) return [...this.queue];
    return this.queue.slice(this.index + 1);
  }

  getState(): PlaybackControllerState {
    return {
      queue: [...this.queue],
      index: this.index,
      track: this.current,
      status: this.status,
      error: this.error,
      volume: this.volume,
      positionSeconds: this.position(),
      durationSeconds: this.durationSeconds,
    };
  }

  onEvent(handler: (event: PlaybackControllerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  setQueue(tracks: readonly Track[], startIndex = 0): void {
    this.queue = [...tracks];
    this.index = this.queue.length === 0 ? -1 : Math.max(0, Math.min(startIndex, this.queue.length - 1));
    this.positionSeconds = 0;
    this.durationSeconds = this.current?.durationSeconds ?? 0;
    this.startedAt = undefined;
    this.emit({ type: "queue", queue: [...this.queue] });
    if (this.queue.length === 0) {
      this.status = "stopped";
      this.emit({ type: "state", state: this.status });
    }
  }

  async playIndex(index: number): Promise<void> {
    if (index < 0 || index >= this.queue.length) return;
    this.index = index;
    const track = this.queue[index];
    this.positionSeconds = 0;
    this.durationSeconds = track.durationSeconds ?? 0;
    this.startedAt = this.now();
    this.status = "playing";
    this.error = undefined;
    this.emit({ type: "track", track, index });
    this.emit({ type: "state", state: this.status });
    try {
      await this.backend.load(track);
      await this.backend.play();
      await this.backend.setVolume(this.volume);
    } catch (error) {
      this.handleError(error instanceof Error ? error.message : String(error));
    }
  }

  async playTrack(track: Track): Promise<void> {
    const index = this.queue.findIndex((candidate) => candidate.id === track.id);
    if (index >= 0) {
      await this.playIndex(index);
      return;
    }
    this.queue = [...this.queue, track];
    this.emit({ type: "queue", queue: [...this.queue] });
    await this.playIndex(this.queue.length - 1);
  }

  async next(): Promise<void> {
    if (this.queue.length === 0) return;
    const nextIndex = (this.index + 1) % this.queue.length;
    await this.playIndex(nextIndex);
  }

  async previous(): Promise<void> {
    if (this.queue.length === 0) return;
    if (this.position() > 3) {
      await this.playIndex(this.index);
      return;
    }
    const previousIndex = (this.index - 1 + this.queue.length) % this.queue.length;
    await this.playIndex(previousIndex);
  }

  async pause(): Promise<void> {
    if (this.status !== "playing") return;
    this.positionSeconds = this.position();
    this.startedAt = undefined;
    this.status = "paused";
    await this.backend.pause();
    this.emit({ type: "state", state: this.status });
  }

  async resume(): Promise<void> {
    if (this.status !== "paused") return;
    this.startedAt = this.now();
    this.status = "playing";
    await this.backend.resume();
    this.emit({ type: "state", state: this.status });
  }

  async togglePause(): Promise<void> {
    if (this.status === "playing") await this.pause();
    else if (this.status === "paused") await this.resume();
    else if (this.current !== undefined) await this.playIndex(this.index);
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    this.positionSeconds = 0;
    this.startedAt = undefined;
    await this.backend.stop();
    this.emit({ type: "state", state: this.status });
  }

  async setVolume(percent: number): Promise<void> {
    this.volume = clampVolume(percent);
    await this.backend.setVolume(this.volume);
    this.emit({ type: "volume", volume: this.volume });
  }

  async close(): Promise<void> {
    this.unsubscribeBackend?.();
    this.handlers.clear();
    await this.backend.close();
    this.status = "idle";
    this.startedAt = undefined;
  }

  private position(): number {
    let position = this.positionSeconds;
    if (this.status === "playing" && this.startedAt !== undefined) {
      position += (this.now() - this.startedAt) / 1000;
    }
    if (this.durationSeconds > 0) position = Math.min(position, this.durationSeconds);
    return Math.max(0, position);
  }

  private async handleEnded(): Promise<void> {
    this.positionSeconds = this.durationSeconds;
    this.startedAt = undefined;
    if (this.autoAdvance && this.queue.length > 1) {
      await this.next();
      return;
    }
    this.status = "stopped";
    this.emit({ type: "state", state: this.status });
  }

  private handleError(message: string): void {
    this.error = message;
    this.status = "error";
    this.startedAt = undefined;
    this.emit({ type: "error", message });
    this.emit({ type: "state", state: this.status });
  }

  private emit(event: PlaybackControllerEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
