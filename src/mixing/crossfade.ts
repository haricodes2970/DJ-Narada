import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Track } from "../library/types.js";

export type CrossfadeCurve = "tri" | "qsin" | "esin" | "hsin" | "log" | "exp" | "lins" | "nofade";

export type CrossfadeSettings = {
  enabled?: boolean;
  durationSeconds?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  curve?: CrossfadeCurve;
};

export type NormalizedCrossfadeSettings = {
  enabled: boolean;
  durationSeconds: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  curve: CrossfadeCurve;
};

export type CrossfadePlan = {
  enabled: boolean;
  from: Track;
  to: Track;
  durationSeconds: number;
  overlapStartSeconds: number;
  curve: CrossfadeCurve;
  reason: string;
};

export type CrossfadeCacheStats = {
  fromMtimeMs?: number;
  toMtimeMs?: number;
};

export type FfmpegProcess = {
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string | number): boolean;
};

export type SpawnFfmpeg = (
  executable: string,
  args: string[],
  options: { stdio: ["ignore", "ignore", "pipe"] },
) => FfmpegProcess;

export type CrossfadeRenderOptions = {
  ffmpegPath?: string;
  cacheDir?: string;
  spawn?: SpawnFfmpeg;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CrossfadeRenderSuccess = {
  ok: true;
  path: string;
  cached: boolean;
  durationSeconds: number;
  plan: CrossfadePlan;
};

export type CrossfadeRenderFailure = {
  ok: false;
  reason: string;
  plan: CrossfadePlan;
};

export type CrossfadeRenderResult = CrossfadeRenderSuccess | CrossfadeRenderFailure;

const DEFAULT_CURVE: CrossfadeCurve = "tri";
const DEFAULT_DURATION = 6;
const DEFAULT_MIN_DURATION = 0.5;
const DEFAULT_MAX_DURATION = 30;
const CACHE_VERSION = 1;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function normalizeCrossfadeSettings(settings: CrossfadeSettings = {}): NormalizedCrossfadeSettings {
  const minDurationSeconds = clamp(finiteOr(settings.minDurationSeconds, DEFAULT_MIN_DURATION), 0.1, 60);
  const maxDurationSeconds = clamp(
    finiteOr(settings.maxDurationSeconds, DEFAULT_MAX_DURATION),
    minDurationSeconds,
    120,
  );
  return {
    enabled: settings.enabled ?? true,
    durationSeconds: clamp(finiteOr(settings.durationSeconds, DEFAULT_DURATION), minDurationSeconds, maxDurationSeconds),
    minDurationSeconds,
    maxDurationSeconds,
    curve: settings.curve ?? DEFAULT_CURVE,
  };
}

/**
 * Plan a safe, fixed-length crossfade.
 *
 * This is intentionally conservative: the overlap can never consume more than
 * half of either track, and unknown durations fall back to the configured
 * duration. Beat-grid alignment is a later layer, not a prerequisite for a
 * clean equal-power blend.
 */
export function planCrossfade(
  from: Track,
  to: Track,
  settings: CrossfadeSettings = {},
): CrossfadePlan {
  const normalized = normalizeCrossfadeSettings(settings);
  const disabled = (reason: string): CrossfadePlan => ({
    enabled: false,
    from,
    to,
    durationSeconds: 0,
    overlapStartSeconds: 0,
    curve: normalized.curve,
    reason,
  });

  if (!normalized.enabled) return disabled("crossfade disabled");
  if (from.id === to.id || from.path === to.path) return disabled("cannot crossfade a track into itself");

  const available = Math.min(
    from.durationSeconds === undefined ? normalized.maxDurationSeconds : from.durationSeconds,
    to.durationSeconds === undefined ? normalized.maxDurationSeconds : to.durationSeconds,
  );
  const durationSeconds = Math.min(normalized.durationSeconds, normalized.maxDurationSeconds, available / 2);
  if (durationSeconds < normalized.minDurationSeconds) {
    return disabled("tracks are too short for the configured crossfade");
  }

  return {
    enabled: true,
    from,
    to,
    durationSeconds,
    overlapStartSeconds: from.durationSeconds === undefined
      ? 0
      : Math.max(0, from.durationSeconds - durationSeconds),
    curve: normalized.curve,
    reason: `${durationSeconds.toFixed(2)}s ${normalized.curve} crossfade`,
  };
}

export function crossfadeCacheKey(plan: CrossfadePlan, stats: CrossfadeCacheStats = {}): string {
  const payload = {
    version: CACHE_VERSION,
    from: {
      path: plan.from.path,
      sizeBytes: plan.from.sizeBytes,
      durationSeconds: plan.from.durationSeconds ?? null,
      contentHash: plan.from.contentHash ?? null,
      mtimeMs: stats.fromMtimeMs ?? null,
    },
    to: {
      path: plan.to.path,
      sizeBytes: plan.to.sizeBytes,
      durationSeconds: plan.to.durationSeconds ?? null,
      contentHash: plan.to.contentHash ?? null,
      mtimeMs: stats.toMtimeMs ?? null,
    },
    durationSeconds: plan.durationSeconds,
    overlapStartSeconds: plan.overlapStartSeconds,
    curve: plan.curve,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function crossfadeArgs(plan: CrossfadePlan, outputPath: string): string[] {
  if (!plan.enabled) throw new Error(`Cannot render disabled crossfade: ${plan.reason}`);
  const duration = plan.durationSeconds.toFixed(3);
  const inputFrom = plan.from.durationSeconds === undefined
    ? ["-sseof", `-${duration}`, "-t", duration, "-i", plan.from.path]
    : ["-ss", plan.overlapStartSeconds.toFixed(3), "-t", duration, "-i", plan.from.path];
  const inputTo = ["-t", duration, "-i", plan.to.path];
  const filter = [
    "[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]",
    "[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1]",
    `[a0][a1]acrossfade=d=${duration}:c1=${plan.curve}:c2=${plan.curve}[out]`,
  ].join(";");
  return [
    "-y",
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    ...inputFrom,
    ...inputTo,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

const defaultSpawn: SpawnFfmpeg = (executable, args, options) =>
  spawn(executable, args, options) as unknown as FfmpegProcess;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function renderCrossfade(
  plan: CrossfadePlan,
  options: CrossfadeRenderOptions = {},
): Promise<CrossfadeRenderResult> {
  if (!plan.enabled) return { ok: false, reason: plan.reason, plan };

  let fromStat;
  let toStat;
  try {
    [fromStat, toStat] = await Promise.all([fs.stat(plan.from.path), fs.stat(plan.to.path)]);
  } catch (error) {
    return { ok: false, reason: `source unavailable: ${errorMessage(error)}`, plan };
  }

  const cacheDir = options.cacheDir ?? path.resolve("cache/transitions");
  const cachePath = path.join(
    cacheDir,
    `${crossfadeCacheKey(plan, { fromMtimeMs: fromStat.mtimeMs, toMtimeMs: toStat.mtimeMs })}.wav`,
  );

  try {
    const cachedStat = await fs.stat(cachePath);
    if (cachedStat.size > 44) {
      return { ok: true, path: cachePath, cached: true, durationSeconds: plan.durationSeconds, plan };
    }
  } catch {
    // Cache miss.
  }

  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `cannot create cache directory: ${errorMessage(error)}`, plan };
  }

  const temporaryPath = path.join(
    cacheDir,
    `.${path.basename(cachePath, ".wav")}.${process.pid}.${Date.now()}.tmp.wav`,
  );
  const executable = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const spawnFfmpeg = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const args = crossfadeArgs(plan, temporaryPath);

  return new Promise<CrossfadeRenderResult>((resolve) => {
    let settled = false;
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = async (result: CrossfadeRenderResult): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (!result.ok) await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      resolve(result);
    };

    const abort = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      void finish({ ok: false, reason: "crossfade render aborted", plan });
    };

    if (options.signal?.aborted) {
      resolve({ ok: false, reason: "crossfade render aborted", plan });
      return;
    }

    let child: FfmpegProcess;
    try {
      child = spawnFfmpeg(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ ok: false, reason: `cannot start ffmpeg: ${errorMessage(error)}`, plan });
      return;
    }

    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      void finish({ ok: false, reason: `ffmpeg timed out after ${timeoutMs}ms`, plan });
    }, timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
    });
    child.on("error", (error) => {
      void finish({ ok: false, reason: `ffmpeg failed: ${error.message}`, plan });
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        void fs.rename(temporaryPath, cachePath)
          .then(() => finish({ ok: true, path: cachePath, cached: false, durationSeconds: plan.durationSeconds, plan }))
          .catch((error) => finish({ ok: false, reason: `cannot store crossfade: ${errorMessage(error)}`, plan }));
        return;
      }
      const detail = stderr.trim() || `ffmpeg exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
      void finish({ ok: false, reason: detail, plan });
    });
  });
}
