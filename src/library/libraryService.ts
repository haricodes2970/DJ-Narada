import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_DATABASE_PATH, resolveDatabasePath } from "../config/paths.js";
import { closeDatabase, currentSchemaVersion, openDatabase } from "../db/database.js";
import { TrackRepository, type DuplicateGroup, type ScanRunRecord, type StoredTrack, type TrackCounts } from "../db/tracks.js";
import { hashFile as defaultHashFile } from "./hash.js";
import { probeTrack as defaultProbeTrack } from "./metadata.js";
import { scanLibrary as defaultScanLibrary } from "./scanner.js";
import type { ProbeResult, ScanOptions, ScanResult, ScanWarning, Track } from "./types.js";

export type LibraryScanOptions = {
  root: string;
  databasePath?: string;
  database?: DatabaseSync;
  force?: boolean;
  hash?: boolean;
  concurrency?: number;
  scan?: (options: ScanOptions) => Promise<ScanResult>;
  probe?: (filePath: string) => Promise<ProbeResult>;
  hashFile?: (filePath: string) => Promise<string>;
  now?: () => Date;
};

export type LibraryScanSummary = {
  root: string;
  databasePath: string;
  startedAt: string;
  finishedAt: string;
  filesSeen: number;
  present: number;
  missing: number;
  markedMissing: number;
  errors: number;
  added: number;
  updated: number;
  unchanged: number;
  duplicates: DuplicateGroup[];
  warnings: ScanWarning[];
  scanRunId: number;
};

export type LibraryStatusSummary = {
  databasePath: string;
  exists: boolean;
  schemaVersion: number;
  root?: string;
  counts: TrackCounts;
  duplicates: DuplicateGroup[];
  lastScan?: ScanRunRecord;
  tracks: StoredTrack[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return path.resolve(root);
  }
}

/**
 * Incremental, read-only library scan into SQLite.
 *
 * A file whose size and mtime match a previously hashed, present row is reused
 * without probing or hashing. Files that disappear are marked missing, never
 * deleted, so user history and playlists survive.
 */
export async function scanLibraryToDatabase(options: LibraryScanOptions): Promise<LibraryScanSummary> {
  const now = options.now ?? (() => new Date());
  const databasePath = options.databasePath ?? resolveDatabasePath();
  const ownsDatabase = options.database === undefined;
  const db = options.database ?? await openDatabase(databasePath);
  const repository = new TrackRepository(db);
  const scan = options.scan ?? defaultScanLibrary;
  const probe = options.probe ?? defaultProbeTrack;
  const hash = options.hashFile ?? defaultHashFile;
  const startedAt = now().toISOString();
  const warnings: ScanWarning[] = [];

  try {
    const scanResult = await scan({ root: options.root });
    warnings.push(...scanResult.warnings);
    const root = await canonicalRoot(options.root);
    const presentIds = new Set<string>();
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    await mapWithConcurrency(scanResult.files, options.concurrency ?? 4, async (filePath) => {
      let canonicalPath: string;
      let stats: Stats;
      try {
        canonicalPath = await fs.realpath(filePath);
        stats = await fs.stat(canonicalPath);
      } catch (error) {
        warnings.push({ path: filePath, message: `Unable to inspect track: ${errorMessage(error)}` });
        return;
      }

      const existing = repository.getByPath(canonicalPath);
      const canReuse = options.force !== true
        && existing !== undefined
        && existing.scanStatus === "present"
        && existing.contentHash !== undefined
        && existing.mtimeMs === stats.mtimeMs
        && existing.sizeBytes === stats.size;

      if (canReuse && existing !== undefined) {
        repository.touch(existing.id, now().toISOString());
        presentIds.add(existing.id);
        unchanged += 1;
        return;
      }

      let probeResult: ProbeResult;
      try {
        probeResult = await probe(canonicalPath);
      } catch (error) {
        probeResult = { warning: { path: canonicalPath, message: `Unable to probe track: ${errorMessage(error)}` } };
      }
      if (probeResult.warning !== undefined) warnings.push(probeResult.warning);
      if (probeResult.track === undefined) {
        if (existing !== undefined) {
          repository.markError(existing.id, probeResult.warning?.message ?? "Probe failed", now().toISOString());
          presentIds.add(existing.id);
        }
        return;
      }

      let contentHash: string | undefined;
      if (options.hash !== false) {
        try {
          contentHash = await hash(canonicalPath);
        } catch (error) {
          warnings.push({ path: canonicalPath, message: `Unable to hash track: ${errorMessage(error)}` });
        }
      }

      const track: Track = probeResult.track;
      const result = repository.upsert(
        {
          id: canonicalPath,
          path: canonicalPath,
          contentHash,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          title: track.title,
          artist: track.artist,
          album: track.album,
          durationSeconds: track.durationSeconds,
          format: track.format,
          scanStatus: "present",
        },
        now().toISOString(),
      );
      presentIds.add(result.track.id);
      if (result.status === "inserted") added += 1;
      else updated += 1;
    });

    const markedMissing = repository.markMissingExcept(root, presentIds, now().toISOString());
    const scoped = repository.list({ root, includeMissing: true });
    const present = scoped.filter((track) => track.scanStatus === "present").length;
    const missing = scoped.filter((track) => track.scanStatus === "missing").length;
    const errors = scoped.filter((track) => track.scanStatus === "error").length;
    const duplicates = repository.duplicates();
    const finishedAt = now().toISOString();
    const scanRunId = repository.recordScanRun({
      root,
      startedAt,
      finishedAt,
      filesSeen: scanResult.files.length,
      present,
      missing,
      errors,
      added,
      updated,
      unchanged,
      duplicates: duplicates.length,
      warnings,
    });

    return {
      root,
      databasePath,
      startedAt,
      finishedAt,
      filesSeen: scanResult.files.length,
      present,
      missing,
      markedMissing,
      errors,
      added,
      updated,
      unchanged,
      duplicates,
      warnings,
      scanRunId,
    };
  } finally {
    if (ownsDatabase) closeDatabase(db);
  }
}

export async function libraryStatus(options: {
  databasePath?: string;
  root?: string;
  database?: DatabaseSync;
  includeTracks?: boolean;
} = {}): Promise<LibraryStatusSummary> {
  const databasePath = options.databasePath ?? resolveDatabasePath();
  const exists = options.database !== undefined || databasePath === ":memory:" || await fs.access(databasePath).then(() => true).catch(() => false);
  if (!exists) {
    return {
      databasePath,
      exists: false,
      schemaVersion: 0,
      counts: { total: 0, present: 0, missing: 0, errors: 0, duplicates: 0 },
      duplicates: [],
      tracks: [],
    };
  }

  const ownsDatabase = options.database === undefined;
  const db = options.database ?? await openDatabase(databasePath);
  try {
    const repository = new TrackRepository(db);
    return {
      databasePath,
      exists: true,
      schemaVersion: currentSchemaVersion(db),
      root: options.root,
      counts: repository.counts(),
      duplicates: repository.duplicates(),
      lastScan: repository.lastScan(options.root),
      tracks: options.includeTracks === true ? repository.list({ root: options.root, includeMissing: true }) : [],
    };
  } finally {
    if (ownsDatabase) closeDatabase(db);
  }
}

export async function libraryDuplicates(options: {
  databasePath?: string;
  root?: string;
  database?: DatabaseSync;
} = {}): Promise<DuplicateGroup[]> {
  const databasePath = options.databasePath ?? resolveDatabasePath();
  const exists = options.database !== undefined || databasePath === ":memory:" || await fs.access(databasePath).then(() => true).catch(() => false);
  if (!exists) return [];
  const ownsDatabase = options.database === undefined;
  const db = options.database ?? await openDatabase(databasePath);
  try {
    const groups = new TrackRepository(db).duplicates();
    if (options.root === undefined) return groups;
    return groups
      .map((group) => ({
        ...group,
        tracks: group.tracks.filter((track) => {
          const relative = path.relative(options.root ?? "", track.path);
          return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
        }),
      }))
      .filter((group) => group.tracks.length > 1);
  } finally {
    if (ownsDatabase) closeDatabase(db);
  }
}

export { DEFAULT_DATABASE_PATH };
