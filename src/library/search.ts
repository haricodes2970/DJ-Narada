import path from "node:path";

import type { Track } from "./types.js";

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD");
}

function searchableText(track: Track): string {
  return [
    track.title,
    track.artist ?? "",
    track.album ?? "",
    path.basename(track.path, path.extname(track.path)),
    track.path,
  ]
    .map(normalize)
    .join("\n");
}

function dedupeById(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    unique.push(track);
  }
  return unique;
}

/**
 * Search title, artist, album, filename, and path.
 *
 * Matching is case-insensitive and every whitespace-separated query token must
 * appear somewhere in the track's searchable text. An empty query returns the
 * whole catalog in input order. Output order is always the input order.
 */
export function searchTracks(tracks: readonly Track[], query: string): Track[] {
  const unique = dedupeById(tracks);
  const tokens = normalize(query).split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return unique;

  return unique.filter((track) => {
    const haystack = searchableText(track);
    return tokens.every((token) => haystack.includes(token));
  });
}
