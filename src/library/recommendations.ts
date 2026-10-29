import type { Track } from "./types.js";

export type RecommendationFeedback = {
  liked?: readonly string[];
  disliked?: readonly string[];
};

export type RecommendationContext = {
  current?: Track;
  recentTrackIds?: readonly string[];
  feedback?: RecommendationFeedback;
  limit?: number;
};

export type Recommendation = {
  track: Track;
  score: number;
  explanation: string;
};

function compatibility(current: Track | undefined, candidate: Track): { score: number; reasons: string[] } {
  if (current === undefined) return { score: 0.5, reasons: ["no current-track constraint"] };
  let score = 0;
  const reasons: string[] = [];
  if (current.bpm !== undefined && candidate.bpm !== undefined) {
    const delta = Math.abs(current.bpm - candidate.bpm);
    const bpmScore = Math.max(0, 1 - delta / 80);
    score += bpmScore * 0.55;
    reasons.push(`${Math.round(delta)} BPM gap`);
  }
  if (current.energy !== undefined && candidate.energy !== undefined) {
    const energyScore = 1 - Math.abs(current.energy - candidate.energy);
    score += energyScore * 0.35;
    reasons.push("energy-compatible");
  }
  if (current.artist !== undefined && candidate.artist === current.artist) {
    score -= 0.18;
    reasons.push("same artist penalty");
  }
  return { score, reasons };
}

export function rankRecommendations(tracks: readonly Track[], context: RecommendationContext = {}): Recommendation[] {
  const recent = new Set(context.recentTrackIds ?? []);
  const liked = new Set(context.feedback?.liked ?? []);
  const disliked = new Set(context.feedback?.disliked ?? []);
  const recommendations = tracks
    .filter((track) => track.id !== context.current?.id && !recent.has(track.id))
    .map((track) => {
      const fit = compatibility(context.current, track);
      let score = fit.score;
      const reasons = [...fit.reasons];
      if (liked.has(track.id)) { score += 0.3; reasons.push("liked previously"); }
      if (disliked.has(track.id)) { score -= 0.45; reasons.push("disliked previously"); }
      return { track, score, explanation: reasons.join(" · ") || "available in library" };
    })
    .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title));
  return recommendations.slice(0, Math.max(0, context.limit ?? recommendations.length));
}
