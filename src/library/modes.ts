import path from "node:path";

import type { Track } from "./types.js";

export type ModeRule = {
  id: string;
  terms: readonly string[];
};

export type ListeningMode = {
  id: string;
  name: string;
  description: string;
  rules: readonly ModeRule[];
};

export type ModeResult = {
  modeId: string;
  tracks: Track[];
  matchedRuleCount: number;
  explanation: string;
  limited: boolean;
};

const MODES: readonly ListeningMode[] = [
  {
    id: "hip-hop",
    name: "Hip-Hop",
    description: "Path and metadata terms associated with hip-hop, rap, trap, and drill.",
    rules: [
      { id: "path", terms: ["hip hop", "hiphop", "hip-hop", "rap", "trap", "drill"] },
      { id: "metadata", terms: ["seedhe maut", "rap", "trap", "drill", "hip hop"] },
    ],
  },
  {
    id: "desi",
    name: "Desi",
    description: "Indian-language, category, and artist terms available in path or metadata.",
    rules: [
      {
        id: "language",
        terms: [
          "desi", "hindi", "bollywood", "kannada", "tamil", "telugu", "malayalam",
          "punjabi", "marathi", "bengali", "gujarati", "urdu", "indian", "indian pop",
        ],
      },
      { id: "metadata", terms: ["arijit", "bollywood", "desi", "indian"] },
    ],
  },
  {
    id: "workout",
    name: "Workout",
    description: "Explicit path and metadata terms for gym, cardio, and training playlists.",
    rules: [
      {
        id: "path",
        terms: ["workout", "gym", "fitness", "cardio", "running", "training", "hustle"],
      },
      {
        id: "metadata",
        terms: ["workout", "gym", "fitness", "cardio", "running", "training", "hustle"],
      },
    ],
  },
  {
    id: "deep-focus",
    name: "Deep Focus",
    description: "Ambient, classical, instrumental, study, and focus terms in path or metadata.",
    rules: [
      {
        id: "category",
        terms: [
          "focus", "ambient", "classical", "instrumental", "study", "concentration",
          "meditation", "piano", "lo fi", "lofi", "chill",
        ],
      },
      {
        id: "metadata",
        terms: ["ambient", "classical", "instrumental", "piano", "lofi", "lo fi", "focus"],
      },
    ],
  },
];

export function getModes(): readonly ListeningMode[] {
  return MODES;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function evidenceText(track: Track): string {
  const filename = path.basename(track.path, path.extname(track.path));
  return normalize([track.title, track.artist ?? "", track.album ?? "", filename, track.path].join(" "));
}

function hasTerm(haystack: string, term: string): boolean {
  const normalizedTerm = normalize(term);
  if (normalizedTerm.length === 0) return false;
  return ` ${haystack} `.includes(` ${normalizedTerm} `);
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
 * Apply a deterministic listening mode using path and metadata evidence only.
 *
 * No audio feature, BPM, energy, mood, language, or genre inference is used.
 * Unknown modes and zero-match modes return a limited result instead of
 * throwing so the CLI can explain the situation and continue.
 */
export function applyMode(modeId: string, tracks: readonly Track[]): ModeResult {
  const mode = MODES.find((candidate) => candidate.id === modeId);
  if (mode === undefined) {
    return {
      modeId,
      tracks: [],
      matchedRuleCount: 0,
      explanation: `Unknown listening mode "${modeId}". Available modes: ${MODES.map((item) => item.id).join(", ")}.`,
      limited: true,
    };
  }

  const unique = dedupeById(tracks);
  const matched = new Map<string, Track>();
  const matchedRules = new Set<string>();

  for (const track of unique) {
    const haystack = evidenceText(track);
    for (const rule of mode.rules) {
      if (rule.terms.some((term) => hasTerm(haystack, term))) {
        matched.set(track.id, track);
        matchedRules.add(rule.id);
      }
    }
  }

  const resultTracks = unique.filter((track) => matched.has(track.id));
  const limited = resultTracks.length === 0;
  const explanation = limited
    ? `No tracks matched ${mode.name} using path and metadata evidence; filtering is limited.`
    : `${mode.name}: matched ${resultTracks.length} track(s) across ${matchedRules.size} rule group(s) using path and metadata evidence; no audio analysis was used.`;

  return {
    modeId: mode.id,
    tracks: resultTracks,
    matchedRuleCount: matchedRules.size,
    explanation,
    limited,
  };
}
