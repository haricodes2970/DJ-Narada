import type { ScanWarning, Track } from "../library/types.js";

export type PlaybackStatus = "playing" | "paused" | "stopped" | "loading" | "error";
export type Overlay = "none" | "help" | "modes" | "search" | "info";
export type Panel = "library" | "queue";

export type ConsoleState = {
  libraryRoot: string;
  tracks: Track[];
  filtered: Track[];
  queue: Track[];
  queueIndex: number;
  libraryIndex: number;
  queueSelection: number;
  panel: Panel;
  modeId: string;
  query: string;
  searchDraft: string;
  overlay: Overlay;
  overlayIndex: number;
  playback: PlaybackStatus;
  position: number;
  duration: number;
  volume: number;
  energy: number;
  beat: number;
  tick: number;
  transition: number;
  message: string;
  warnings: ScanWarning[];
  demo: boolean;
  bpm: number;
  modeCounts: Record<string, number>;
};

export type CreateStateInput = {
  libraryRoot: string;
  tracks: Track[];
  warnings?: ScanWarning[];
  demo?: boolean;
};

export function createConsoleState(input: CreateStateInput): ConsoleState {
  const tracks = [...input.tracks];
  return {
    libraryRoot: input.libraryRoot,
    tracks,
    filtered: tracks,
    queue: tracks,
    queueIndex: 0,
    libraryIndex: 0,
    queueSelection: 0,
    panel: "library",
    modeId: "all",
    query: "",
    searchDraft: "",
    overlay: "none",
    overlayIndex: 0,
    playback: tracks.length > 0 ? "playing" : "stopped",
    position: 0,
    duration: tracks[0]?.durationSeconds ?? 0,
    volume: 70,
    energy: 0.55,
    beat: 0,
    tick: 0,
    transition: 0,
    message: "",
    warnings: input.warnings ?? [],
    demo: input.demo ?? false,
    bpm: 0,
    modeCounts: {},
  };
}

export function currentTrack(state: ConsoleState): Track | undefined {
  return state.queue[state.queueIndex];
}

export function selectedLibraryTrack(state: ConsoleState): Track | undefined {
  return state.filtered[state.libraryIndex];
}

export function selectedQueueTrack(state: ConsoleState): Track | undefined {
  return state.queue[state.queueSelection];
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

export function syntheticBpm(track: Track | undefined): number {
  if (track === undefined) return 0;
  if (track.bpm !== undefined && Number.isFinite(track.bpm) && track.bpm > 0) return Math.round(track.bpm);
  let hash = 0;
  for (const character of `${track.title}${track.artist ?? ""}`) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return 76 + (hash % 56);
}

export function syntheticEnergy(track: Track | undefined, tick: number): number {
  if (track === undefined) return 0;
  if (track.energy !== undefined && Number.isFinite(track.energy)) return Math.max(0, Math.min(1, track.energy));
  let hash = 0;
  for (const character of track.id) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  const base = 0.35 + (hash % 40) / 100;
  return Math.min(1, base + Math.abs(Math.sin(tick / 7 + (hash % 10))) * 0.35);
}
