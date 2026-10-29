import type { DatabaseSync } from "node:sqlite";
import type { StoredTrack } from "../db/tracks.js";

export type PlayEventInput = {
  trackId?: string;
  startedAt?: string;
  playedSeconds?: number;
  sessionId?: string;
  skipReason?: string;
};

export type FeedbackInput = {
  trackId?: string;
  kind: string;
  value?: number;
  note?: string;
  createdAt?: string;
};

export function recordPlayEvent(db: DatabaseSync, input: PlayEventInput): number {
  const result = db.prepare(`
    INSERT INTO play_events (track_id, started_at, played_seconds, session_id, skip_reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.trackId ?? null, input.startedAt ?? new Date().toISOString(), input.playedSeconds ?? null, input.sessionId ?? null, input.skipReason ?? null);
  return Number(result.lastInsertRowid);
}

export function recordFeedback(db: DatabaseSync, input: FeedbackInput): number {
  const result = db.prepare(`
    INSERT INTO feedback (track_id, kind, value, note, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.trackId ?? null, input.kind, input.value ?? null, input.note ?? null, input.createdAt ?? new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function createPlaylist(db: DatabaseSync, name: string): number {
  const now = new Date().toISOString();
  const result = db.prepare("INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)").run(name, now, now);
  return Number(result.lastInsertRowid);
}

export function addPlaylistTrack(db: DatabaseSync, playlistId: number, trackId: string): void {
  const row = db.prepare("SELECT COALESCE(MAX(position), -1) AS position FROM playlist_tracks WHERE playlist_id = ?").get(playlistId) as Record<string, unknown>;
  const position = Number(row.position) + 1;
  db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)").run(playlistId, trackId, position, new Date().toISOString());
  db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), playlistId);
}

export function listPlaylistTracks(db: DatabaseSync, playlistId: number): StoredTrack[] {
  const rows = db.prepare(`
    SELECT t.* FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ? ORDER BY pt.position
  `).all(playlistId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id), path: String(row.canonical_path), contentHash: typeof row.content_hash === "string" ? row.content_hash : undefined,
    sizeBytes: Number(row.file_size), mtimeMs: typeof row.mtime_ms === "number" ? row.mtime_ms : undefined,
    title: String(row.title), artist: typeof row.artist === "string" ? row.artist : undefined,
    album: typeof row.album === "string" ? row.album : undefined, durationSeconds: typeof row.duration_seconds === "number" ? row.duration_seconds : undefined,
    format: typeof row.format === "string" ? row.format : undefined, scanStatus: String(row.scan_status) as StoredTrack["scanStatus"],
    errorMessage: typeof row.error_message === "string" ? row.error_message : undefined,
    firstSeenAt: String(row.first_seen_at), lastSeenAt: String(row.last_seen_at), updatedAt: String(row.updated_at),
  }));
}
