import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { normalizeAudioFeatures } from "./features.js";
import type { AudioFeatures, AudioProbeOptions, AudioProbeResult } from "./types.js";

export const DEFAULT_AUDIO_PROBE_TIMEOUT_MS = 30000;
export const DEFAULT_AUDIO_MAX_STDOUT_BYTES = 256 * 1024;
export const DEFAULT_AUDIO_MAX_STDERR_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;
const TERMINATION_BOUND_MS = 1000;

const DEFAULT_WORKER_SCRIPT = "python/audio_analysis/worker.py";

type WorkerJson = { ok?: unknown; features?: unknown; error?: unknown };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeAudio(filePath: string, options: AudioProbeOptions = {}): Promise<AudioProbeResult> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(filePath);
    await fs.stat(canonicalPath);
  } catch (error) {
    return { ok: false, warning: { path: filePath, message: `Unable to inspect audio: ${errorMessage(error)}` } };
  }
  const executable = options.executable ?? "python3";
  const workerScript = options.workerScript ?? path.resolve(DEFAULT_WORKER_SCRIPT);
  if (options.signal?.aborted) {
    return { ok: false, warning: { path: canonicalPath, message: "audio analysis aborted" } };
  }
  return runWorker(executable, [workerScript, canonicalPath], canonicalPath, {
    timeoutMs: options.timeoutMs ?? DEFAULT_AUDIO_PROBE_TIMEOUT_MS,
    maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_AUDIO_MAX_STDOUT_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_AUDIO_MAX_STDERR_BYTES,
    signal: options.signal,
  });
}

function runWorker(
  executable: string,
  args: readonly string[],
  canonicalPath: string,
  limits: { timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number; signal?: AbortSignal },
): Promise<AudioProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => terminate("audio worker timed out"), limits.timeoutMs);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let boundTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (boundTimer !== undefined) clearTimeout(boundTimer);
      timeout = graceTimer = boundTimer = undefined;
      limits.signal?.removeEventListener("abort", abort);
    };
    const finish = (result: AudioProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const warning = (message: string): void => finish({ ok: false, warning: { path: canonicalPath, message } });
    const abort = (): void => terminate("audio analysis aborted");
    const terminate = (message: string): void => {
      if (settled || terminating) return;
      terminating = true;
      if (!child.kill("SIGTERM")) {
        finish({ ok: false, warning: { path: canonicalPath, message: `${message}; cleanup failed` } });
        return;
      }
      child.once("close", () => finish({ ok: false, warning: { path: canonicalPath, message } }));
      graceTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        boundTimer = setTimeout(
          () => finish({ ok: false, warning: { path: canonicalPath, message: `${message}; cleanup failed` } }),
          TERMINATION_BOUND_MS,
        );
      }, TERMINATION_GRACE_MS);
    };

    child.stdout.on("data", (chunk: string) => {
      if (settled || terminating) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > limits.maxStdoutBytes) terminate("audio worker stdout exceeded configured limit");
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled || terminating) return;
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > limits.maxStderrBytes) terminate("audio worker stderr exceeded configured limit");
    });
    limits.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => warning(`Unable to run audio worker: ${errorMessage(error)}`));
    child.on("close", (code) => {
      if (settled || terminating) return;
      if (code !== 0) return warning(`audio worker failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`);
      let parsed: WorkerJson;
      try {
        parsed = JSON.parse(stdout) as WorkerJson;
      } catch {
        return warning("audio worker returned malformed JSON");
      }
      if (parsed.ok !== true) {
        const detail = typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : "unknown worker error";
        return warning(`audio worker reported failure: ${detail}`);
      }
      const features = normalizeAudioFeatures(parsed.features);
      if (features === undefined) return warning("audio worker returned invalid feature data");
      finish({ ok: true, features });
    });
  });
}
