import type { Track } from "../library/types.js";

/**
 * Phase 5 scaffold: deterministic, metadata-only medley planning.
 *
 * This module never inspects audio, never writes files, and never claims
 * beat-matching or transition quality. It only orders a set of tracks so a
 * future DJ engine has a stable, testable sequence to build on.
 */

export type MedleyOptions = {
  maxTracks?: number;
  avoidSameArtist?: boolean;
};

export type MedleyPlan = {
  tracks: Track[];
  limited: boolean;
  explanation: string;
};

const DEFAULT_MAX_TRACKS = 10;

function dedupe(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    unique.push(track);
  }
  return unique;
}

function compareTracks(a: Track, b: Track): number {
  const byTitle = a.title.localeCompare(b.title);
  if (byTitle !== 0) return byTitle;
  return a.id.localeCompare(b.id);
}

function separateArtists(tracks: readonly Track[]): Track[] {
  const remaining = [...tracks];
  const ordered: Track[] = [];
  let previousArtist: string | undefined;
  while (remaining.length > 0) {
    let pickIndex = 0;
    if (previousArtist !== undefined) {
      const alternative = remaining.findIndex((track) => track.artist !== previousArtist);
      if (alternative !== -1) pickIndex = alternative;
    }
    const [picked] = remaining.splice(pickIndex, 1);
    ordered.push(picked);
    previousArtist = picked.artist;
  }
  return ordered;
}

export function planMedley(tracks: readonly Track[], options: MedleyOptions = {}): MedleyPlan {
  const maxTracks = options.maxTracks ?? DEFAULT_MAX_TRACKS;
  if (!Number.isFinite(maxTracks) || maxTracks <= 0) {
    return { tracks: [], limited: true, explanation: "Medley limit is zero; no tracks selected." };
  }
  const unique = dedupe(tracks).sort(compareTracks);
  const selected = unique.slice(0, Math.floor(maxTracks));
  const ordered = options.avoidSameArtist === false ? selected : separateArtists(selected);
  const limited = ordered.length < 2;
  const explanation = limited
    ? "Fewer than two distinct tracks are available; medley planning is limited."
    : `Planned ${ordered.length} distinct track(s) from ${unique.length} candidate(s) using metadata only.`;
  return { tracks: ordered, limited, explanation };
}

export class MedleyAdapter {
  private readonly plan: MedleyPlan;
  private index = 0;

  constructor(tracks: readonly Track[], options: MedleyOptions = {}) {
    this.plan = planMedley(tracks, options);
  }

  getPlan(): MedleyPlan {
    return this.plan;
  }

  current(): Track | undefined {
    return this.plan.tracks[this.index];
  }

  next(): Track | undefined {
    if (this.index < this.plan.tracks.length - 1) this.index += 1;
    return this.current();
  }

  previous(): Track | undefined {
    if (this.index > 0) this.index -= 1;
    return this.current();
  }
}
