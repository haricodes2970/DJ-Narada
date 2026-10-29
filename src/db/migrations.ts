export type Migration = {
  version: number;
  name: string;
  up: string;
};

/**
 * Source-controlled schema migrations.
 *
 * Keep migrations append-only. Runtime databases are local-only and ignored by
 * Git; this file is the canonical schema history.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_library_schema",
    up: `
      CREATE TABLE tracks (
        id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL UNIQUE,
        content_hash TEXT,
        file_size INTEGER NOT NULL,
        mtime_ms REAL,
        title TEXT NOT NULL,
        artist TEXT,
        album TEXT,
        duration_seconds REAL,
        format TEXT,
        scan_status TEXT NOT NULL DEFAULT 'present'
          CHECK (scan_status IN ('present', 'missing', 'error')),
        error_message TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_tracks_content_hash ON tracks(content_hash);
      CREATE INDEX idx_tracks_scan_status ON tracks(scan_status);
      CREATE INDEX idx_tracks_canonical_path ON tracks(canonical_path);

      CREATE TABLE artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE track_artists (
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'primary',
        display_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (track_id, artist_id, role)
      );

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        normalized_label TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        parent_tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL
      );

      CREATE TABLE track_tags (
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        confidence REAL,
        confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
        PRIMARY KEY (track_id, tag_id, source)
      );

      CREATE TABLE analysis_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        algorithm TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        values_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error_message TEXT
      );

      CREATE TABLE playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE playlist_tracks (
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (playlist_id, position)
      );

      CREATE TABLE play_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        played_seconds REAL,
        session_id TEXT,
        skip_reason TEXT
      );

      CREATE TABLE feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        value REAL,
        note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        to_track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        bpm_delta REAL,
        beat_alignment REAL,
        overlap_seconds REAL,
        result TEXT,
        feedback REAL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        uri TEXT NOT NULL,
        title TEXT,
        license TEXT,
        permission TEXT,
        acquired_at TEXT NOT NULL
      );

      CREATE TABLE scan_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        files_seen INTEGER NOT NULL,
        present INTEGER NOT NULL,
        missing INTEGER NOT NULL,
        errors INTEGER NOT NULL,
        added INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        unchanged INTEGER NOT NULL,
        duplicates INTEGER NOT NULL,
        warnings_json TEXT NOT NULL
      );

      CREATE INDEX idx_scan_runs_root_started ON scan_runs(root, started_at);

    `,
  },
  {
    version: 2,
    name: "analysis_source_hash",
    up: `
      ALTER TABLE analysis_runs ADD COLUMN source_hash TEXT;
      CREATE INDEX idx_analysis_runs_lookup
        ON analysis_runs(track_id, algorithm, algorithm_version, source_hash);
    `,
  },
  {
    version: 3,
    name: "category_stars",
    up: `
      CREATE TABLE category_stars (
        category_path TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `,
  },
];
