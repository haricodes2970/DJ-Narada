import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import type { ProbeOptions, ProbeResult, Track } from "./types.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;
const TERMINATION_BOUND_MS = 1000;

type ProbeJson = {
  format?: { format_name?: unknown; duration?: unknown; tags?: Record<string, unknown> };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fallbackTrack(filePath: string, title: string, sizeBytes: number): Track {
  return { id: filePath, path: filePath, title, sizeBytes };
}

export function probeTrackWithHelper(
  filePath: string,
  options: ProbeOptions = {},
  helperScript?: string,
): Promise<ProbeResult> {
  return inspect(filePath).then((inspected) => {
    if ("warning" in inspected && inspected.warning && !("track" in inspected)) return inspected;
    const { canonicalPath, sizeBytes, fallback } = inspected as { canonicalPath: string; sizeBytes: number; fallback: Track };
    const executable = options.executable ?? "ffprobe";
    const args = helperScript === undefined
      ? ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", canonicalPath]
      : [helperScript, canonicalPath];
    return runProbe(executable, args, fallback, canonicalPath, {
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    });
  });
}

async function inspect(filePath: string): Promise<ProbeResult | { canonicalPath: string; sizeBytes: number; fallback: Track }> {
  try {
    const canonicalPath = await fs.realpath(filePath);
    const stats = await fs.stat(canonicalPath);
    const title = path.basename(canonicalPath, path.extname(canonicalPath));
    return { canonicalPath, sizeBytes: stats.size, fallback: fallbackTrack(canonicalPath, title, stats.size) };
  } catch (error) {
    return { warning: { path: filePath, message: `Unable to inspect track: ${errorMessage(error)}` } };
  }
}

function runProbe(
  executable: string,
  args: readonly string[],
  fallback: Track,
  canonicalPath: string,
  limits: { timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number },
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => terminate("ffprobe timed out"), limits.timeoutMs);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let boundTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (boundTimer !== undefined) clearTimeout(boundTimer);
      timeout = graceTimer = boundTimer = undefined;
    };
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const terminate = (message: string): void => {
      if (settled || terminating) return;
      terminating = true;
      if (!child.kill("SIGTERM")) {
        finish({ track: fallback, warning: { path: canonicalPath, message: `${message}; cleanup failed` } });
        return;
      }
      child.once("close", () => finish({ track: fallback, warning: { path: canonicalPath, message } }));
      graceTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        boundTimer = setTimeout(() => finish({ track: fallback, warning: { path: canonicalPath, message: `${message}; cleanup failed` } }), TERMINATION_BOUND_MS);
      }, TERMINATION_GRACE_MS);
    };
    const warning = (message: string): void => finish({ track: fallback, warning: { path: canonicalPath, message } });

    child.stdout.on("data", (chunk: string) => {
      if (settled || terminating) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > limits.maxStdoutBytes) terminate("ffprobe stdout exceeded configured limit");
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled || terminating) return;
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > limits.maxStderrBytes) terminate("ffprobe stderr exceeded configured limit");
    });
    child.on("error", (error) => warning(`Unable to run ffprobe: ${errorMessage(error)}`));
    child.on("close", (code) => {
      if (settled || terminating) return;
      if (code !== 0) return warning(`ffprobe failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`);
      let parsed: ProbeJson;
      try { parsed = JSON.parse(stdout) as ProbeJson; } catch { return warning("ffprobe returned malformed JSON"); }
      const format = typeof parsed.format?.format_name === "string" ? parsed.format.format_name : undefined;
      const tags = parsed.format?.tags ?? {};
      const rawDuration = parsed.format?.duration;
      const durationValue = Number(rawDuration);
      const durationSeconds = Number.isFinite(durationValue) && durationValue >= 0 ? durationValue : undefined;
      const invalidDuration = rawDuration !== undefined && durationSeconds === undefined;
      const title = fallback.title;
      const track: Track = {
        ...fallback,
        title: typeof tags.title === "string" && tags.title.length > 0 ? tags.title : title,
        artist: typeof tags.artist === "string" ? tags.artist : undefined,
        album: typeof tags.album === "string" ? tags.album : undefined,
        durationSeconds,
        format,
      };
      finish({ track, warning: invalidDuration ? { path: canonicalPath, message: "ffprobe returned invalid duration" } : undefined });
    });
  });
}
