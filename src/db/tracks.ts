import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type TrackScanStatus = "present" | "missing" | "error";

export type StoredTrack = {
  id: string;
  path: string;
  contentHash?: string;
  sizeBytes: number;
  mtimeMs?: number;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  format?: string;
  scanStatus: TrackScanStatus;
  errorMessage?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
};

export type TrackUpsert = {
  id: string;
  path: string;
  contentHash?: string;
  sizeBytes: number;
  mtimeMs?: number;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  format?: string;
  scanStatus?: TrackScanStatus;
  errorMessage?: string;
};

export type DuplicateGroup = {
  contentHash: string;
  tracks: StoredTrack[];
};

export type TrackCounts = {
  total: number;
  present: number;
  missing: number;
  errors: number;
  duplicates: number;
};

export type ScanRunInput = {
  root: string;
  startedAt: string;
  finishedAt: string;
  filesSeen: number;
  present: number;
  missing: number;
  errors: number;
  added: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  warnings: readonly { path: string; message: string }[];
};

export type ScanRunRecord = ScanRunInput & { id: number };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rowToTrack(row: Record<string, unknown>): StoredTrack {
  return {
    id: String(row.id),
    path: String(row.canonical_path),
    contentHash: optionalString(row.content_hash),
    sizeBytes: Number(row.file_size),
    mtimeMs: optionalNumber(row.mtime_ms),
    title: String(row.title),
    artist: optionalString(row.artist),
    album: optionalString(row.album),
    durationSeconds: optionalNumber(row.duration_seconds),
    format: optionalString(row.format),
    scanStatus: String(row.scan_status) as TrackScanStatus,
    errorMessage: optionalString(row.error_message),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    updatedAt: String(row.updated_at),
  };
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export class TrackRepository {
  constructor(private readonly db: DatabaseSync) {}

  getByPath(canonicalPath: string): StoredTrack | undefined {
    const row = this.db.prepare("SELECT * FROM tracks WHERE canonical_path = ?").get(canonicalPath);
    return row === undefined ? undefined : rowToTrack(row as Record<string, unknown>);
  }

  getById(id: string): StoredTrack | undefined {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id);
    return row === undefined ? undefined : rowToTrack(row as Record<string, unknown>);
  }

  upsert(input: TrackUpsert, now: string = new Date().toISOString()): { status: "inserted" | "updated"; track: StoredTrack } {
    const existing = this.getByPath(input.path);
    const scanStatus = input.scanStatus ?? "present";
    this.db
      .prepare(`
        INSERT INTO tracks (
          id, canonical_path, content_hash, file_size, mtime_ms, title, artist, album,
          duration_seconds, format, scan_status, error_message, first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          canonical_path = excluded.canonical_path,
          content_hash = excluded.content_hash,
          file_size = excluded.file_size,
          mtime_ms = excluded.mtime_ms,
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album,
          duration_seconds = excluded.duration_seconds,
          format = excluded.format,
          scan_status = excluded.scan_status,
          error_message = excluded.error_message,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `)
      .run(
        input.id,
        input.path,
        input.contentHash ?? null,
        input.sizeBytes,
        input.mtimeMs ?? null,
        input.title,
        input.artist ?? null,
        input.album ?? null,
        input.durationSeconds ?? null,
        input.format ?? null,
        scanStatus,
        input.errorMessage ?? null,
        existing?.firstSeenAt ?? now,
        now,
        now,
      );
    const track = this.getByPath(input.path);
    if (track === undefined) throw new Error(`Track disappeared after upsert: ${input.path}`);
    return { status: existing === undefined ? "inserted" : "updated", track };
  }

  touch(id: string, now: string = new Date().toISOString()): void {
    this.db.prepare("UPDATE tracks SET last_seen_at = ?, scan_status = 'present', error_message = NULL WHERE id = ?").run(now, id);
  }

  markError(id: string, message: string, now: string = new Date().toISOString()): void {
    this.db.prepare("UPDATE tracks SET scan_status = 'error', error_message = ?, last_seen_at = ?, updated_at = ? WHERE id = ?").run(
      message,
      now,
      now,
      id,
    );
  }

  markMissingExcept(root: string, presentIds: ReadonlySet<string>, now: string = new Date().toISOString()): number {
    const rows = this.db
      .prepare("SELECT id, canonical_path FROM tracks WHERE scan_status != 'missing'")
      .all()
      .map((row) => row as Record<string, unknown>);
    const missing = rows.filter((row) => isWithin(String(row.canonical_path), root) && !presentIds.has(String(row.id)));
    const update = this.db.prepare("UPDATE tracks SET scan_status = 'missing', updated_at = ? WHERE id = ?");
    for (const row of missing) update.run(now, String(row.id));
    return missing.length;
  }

  list(options: { root?: string; includeMissing?: boolean } = {}): StoredTrack[] {
    const rows = this.db.prepare("SELECT * FROM tracks ORDER BY canonical_path").all();
    return rows
      .map((row) => rowToTrack(row as Record<string, unknown>))
      .filter((track) => (options.includeMissing === true || track.scanStatus !== "missing"))
      .filter((track) => options.root === undefined || isWithin(track.path, options.root));
  }

  duplicates(): DuplicateGroup[] {
    const groups = new Map<string, StoredTrack[]>();
    for (const track of this.list({ includeMissing: false })) {
      if (track.contentHash === undefined) continue;
      const bucket = groups.get(track.contentHash) ?? [];
      bucket.push(track);
      groups.set(track.contentHash, bucket);
    }
    return [...groups.entries()]
      .filter(([, tracks]) => tracks.length > 1)
      .map(([contentHash, tracks]) => ({ contentHash, tracks }))
      .sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  }

  counts(): TrackCounts {
    const rows = this.db.prepare("SELECT scan_status, COUNT(*) AS count FROM tracks GROUP BY scan_status").all();
    const byStatus = new Map<string, number>();
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      byStatus.set(String(record.scan_status), Number(record.count));
    }
    const present = byStatus.get("present") ?? 0;
    const missing = byStatus.get("missing") ?? 0;
    const errors = byStatus.get("error") ?? 0;
    return {
      total: present + missing + errors,
      present,
      missing,
      errors,
      duplicates: this.duplicates().length,
    };
  }

  recordScanRun(input: ScanRunInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO scan_runs (
          root, started_at, finished_at, files_seen, present, missing, errors,
          added, updated, unchanged, duplicates, warnings_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.root,
        input.startedAt,
        input.finishedAt,
        input.filesSeen,
        input.present,
        input.missing,
        input.errors,
        input.added,
        input.updated,
        input.unchanged,
        input.duplicates,
        JSON.stringify(input.warnings),
      );
    return Number(result.lastInsertRowid);
  }

  lastScan(root?: string): ScanRunRecord | undefined {
    const row = root === undefined
      ? this.db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get()
      : this.db.prepare("SELECT * FROM scan_runs WHERE root = ? ORDER BY id DESC LIMIT 1").get(root);
    if (row === undefined) return undefined;
    const record = row as Record<string, unknown>;
    return {
      id: Number(record.id),
      root: String(record.root),
      startedAt: String(record.started_at),
      finishedAt: String(record.finished_at),
      filesSeen: Number(record.files_seen),
      present: Number(record.present),
      missing: Number(record.missing),
      errors: Number(record.errors),
      added: Number(record.added),
      updated: Number(record.updated),
      unchanged: Number(record.unchanged),
      duplicates: Number(record.duplicates),
      warnings: JSON.parse(String(record.warnings_json)) as { path: string; message: string }[],
    };
  }
}
