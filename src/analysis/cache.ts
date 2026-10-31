import type { DatabaseSync } from "node:sqlite";

import { resolveDatabasePath } from "../config/paths.js";
import { closeDatabase, openDatabase } from "../db/database.js";
import type { Track } from "../library/types.js";
import { normalizeAudioFeatures } from "./features.js";
import { probeAudio } from "./probeWorker.js";
import type { AudioFeatures, AudioProbeOptions, AudioProbeResult, AudioProbeWarning } from "./types.js";

export const DEFAULT_ANALYSIS_ALGORITHM = "librosa-baseline";
export const DEFAULT_ANALYSIS_VERSION = "1";

export type AnalysisRecordInput = {
  trackId: string;
  algorithm: string;
  algorithmVersion: string;
  sourceHash?: string;
  features: AudioFeatures;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type AnalysisFailureInput = {
  trackId: string;
  algorithm: string;
  algorithmVersion: string;
  sourceHash?: string;
  errorMessage: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

/**
 * Small repository for the existing analysis_runs table.
 *
 * Cache hits are keyed by track, algorithm, algorithm version and source hash.
 * A changed file therefore misses the cache without deleting history.
 */
export class AnalysisRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(
    trackId: string,
    algorithm: string,
    algorithmVersion: string,
    sourceHash?: string,
  ): AudioFeatures | undefined {
    const row = this.db
      .prepare(`
        SELECT values_json FROM analysis_runs
        WHERE track_id = ? AND algorithm = ? AND algorithm_version = ?
          AND source_hash IS ? AND error_message IS NULL
        ORDER BY id DESC LIMIT 1
      `)
      .get(trackId, algorithm, algorithmVersion, sourceHash ?? null);
    if (row === undefined) return undefined;
    const values = (row as Record<string, unknown>).values_json;
    if (typeof values !== "string") return undefined;
    try {
      return normalizeAudioFeatures(JSON.parse(values));
    } catch {
      return undefined;
    }
  }

  /** Latest successful features for a track regardless of source hash. Used
      when the caller has no content hash (e.g. streams built by probe only). */
  getLatest(trackId: string, algorithm: string, algorithmVersion: string): AudioFeatures | undefined {
    const row = this.db
      .prepare(`
        SELECT values_json FROM analysis_runs
        WHERE track_id = ? AND algorithm = ? AND algorithm_version = ?
          AND error_message IS NULL
        ORDER BY id DESC LIMIT 1
      `)
      .get(trackId, algorithm, algorithmVersion);
    if (row === undefined) return undefined;
    const values = (row as Record<string, unknown>).values_json;
    if (typeof values !== "string") return undefined;
    try {
      return normalizeAudioFeatures(JSON.parse(values));
    } catch {
      return undefined;
    }
  }

  record(input: AnalysisRecordInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO analysis_runs (
          track_id, algorithm, algorithm_version, source_hash, values_json,
          started_at, finished_at, duration_ms, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        input.trackId,
        input.algorithm,
        input.algorithmVersion,
        input.sourceHash ?? null,
        JSON.stringify(input.features),
        input.startedAt,
        input.finishedAt,
        input.durationMs,
      );
    return Number(result.lastInsertRowid);
  }

  recordFailure(input: AnalysisFailureInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO analysis_runs (
          track_id, algorithm, algorithm_version, source_hash, values_json,
          started_at, finished_at, duration_ms, error_message
        ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)
      `)
      .run(
        input.trackId,
        input.algorithm,
        input.algorithmVersion,
        input.sourceHash ?? null,
        input.startedAt,
        input.finishedAt,
        input.durationMs,
        input.errorMessage,
      );
    return Number(result.lastInsertRowid);
  }
}

export type AnalyzeTrackOptions = {
  database?: DatabaseSync;
  databasePath?: string;
  algorithm?: string;
  algorithmVersion?: string;
  probe?: (filePath: string, options?: AudioProbeOptions) => Promise<AudioProbeResult>;
  probeOptions?: AudioProbeOptions;
  signal?: AbortSignal;
  now?: () => Date;
};

export type AnalyzeTrackSuccess = {
  ok: true;
  features: AudioFeatures;
  cached: boolean;
  sourceHash?: string;
  cacheError?: string;
};

export type AnalyzeTrackFailure = {
  ok: false;
  warning: AudioProbeWarning;
  cached: false;
};

export type AnalyzeTrackResult = AnalyzeTrackSuccess | AnalyzeTrackFailure;

export type AnalyzeTracksSummary = {
  total: number;
  analyzed: number;
  cached: number;
  failed: number;
  aborted: boolean;
  warnings: AudioProbeWarning[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function analyzeTrackWithCache(
  track: Track,
  options: AnalyzeTrackOptions = {},
): Promise<AnalyzeTrackResult> {
  const databasePath = options.databasePath ?? resolveDatabasePath();
  const ownsDatabase = options.database === undefined;
  const db = options.database ?? await openDatabase(databasePath);
  const repository = new AnalysisRepository(db);
  const algorithm = options.algorithm ?? DEFAULT_ANALYSIS_ALGORITHM;
  const algorithmVersion = options.algorithmVersion ?? DEFAULT_ANALYSIS_VERSION;
  const sourceHash = track.contentHash;
  const now = options.now ?? (() => new Date());

  try {
    const cached = repository.get(track.id, algorithm, algorithmVersion, sourceHash);
    if (cached !== undefined) {
      return { ok: true, features: cached, cached: true, sourceHash };
    }

    const started = Date.now();
    const startedAt = now().toISOString();
    const probe = options.probe ?? probeAudio;
    const probeOptions: AudioProbeOptions = {
      ...options.probeOptions,
      signal: options.signal ?? options.probeOptions?.signal,
    };
    const result = await probe(track.path, probeOptions);
    const finishedAt = now().toISOString();
    const durationMs = Math.max(0, Date.now() - started);

    if (!result.ok) {
      if (options.signal?.aborted !== true) {
        try {
          repository.recordFailure({
            trackId: track.id,
            algorithm,
            algorithmVersion,
            sourceHash,
            errorMessage: result.warning.message,
            startedAt,
            finishedAt,
            durationMs,
          });
        } catch {
          // Failure history is useful but never blocks the caller.
        }
      }
      return { ok: false, warning: result.warning, cached: false };
    }

    let cacheError: string | undefined;
    try {
      repository.record({
        trackId: track.id,
        algorithm,
        algorithmVersion,
        sourceHash,
        features: result.features,
        startedAt,
        finishedAt,
        durationMs,
      });
    } catch (error) {
      cacheError = errorMessage(error);
    }
    return { ok: true, features: result.features, cached: false, sourceHash, cacheError };
  } finally {
    if (ownsDatabase) closeDatabase(db);
  }
}

export type AnalyzeTracksOptions = AnalyzeTrackOptions & {
  concurrency?: number;
  onProgress?: (done: number, total: number, track: Track, result: AnalyzeTrackResult) => void;
};

export async function analyzeTracksWithCache(
  tracks: readonly Track[],
  options: AnalyzeTracksOptions = {},
): Promise<AnalyzeTracksSummary> {
  const databasePath = options.databasePath ?? resolveDatabasePath();
  const ownsDatabase = options.database === undefined;
  const db = options.database ?? await openDatabase(databasePath);
  const summary: AnalyzeTracksSummary = {
    total: tracks.length,
    analyzed: 0,
    cached: 0,
    failed: 0,
    aborted: false,
    warnings: [],
  };
  let done = 0;

  try {
    await mapWithConcurrency(tracks, options.concurrency ?? 2, async (track) => {
      if (options.signal?.aborted === true) {
        summary.aborted = true;
        return;
      }
      const result = await analyzeTrackWithCache(track, { ...options, database: db, databasePath });
      if (result.ok) {
        if (result.cached) summary.cached += 1;
        else summary.analyzed += 1;
      } else {
        summary.failed += 1;
        summary.warnings.push(result.warning);
      }
      done += 1;
      options.onProgress?.(done, tracks.length, track, result);
    });
  } finally {
    if (ownsDatabase) closeDatabase(db);
  }

  return summary;
}
