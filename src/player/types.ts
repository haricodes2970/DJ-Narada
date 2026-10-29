import type { Track } from "../library/types.js";

export type PlaybackState = "idle" | "playing" | "paused" | "stopped" | "error";

export type BackendEvent =
  | { type: "ended"; track: Track }
  | { type: "error"; message: string; track?: Track }
  | { type: "state"; state: PlaybackState };

export type BackendEventHandler = (event: BackendEvent) => void;

/**
 * Playback backend contract from `docs/PHASE_2_SPEC.md`.
 *
 * A backend controls only the currently loaded track. Queue navigation
 * (`next`/`previous`) belongs to `PlaybackController`, not the backend.
 */
export interface PlaybackBackend {
  load(track: Track): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  setVolume(percent: number): Promise<void>;
  getState(): PlaybackState;
  onEvent?(handler: BackendEventHandler): () => void;
  close(): Promise<void>;
}
