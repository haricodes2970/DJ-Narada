import { spawn } from "node:child_process";
import path from "node:path";

import type { ScanResult, ScanWarning } from "./types.js";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 5000;
const TERMINATION_GRACE_MS = 250;
const TERMINATION_BOUND_MS = 1000;

type ProtocolOptions = {
  root: string;
  exclusions: ReadonlySet<string>;
  extensionSet: ReadonlySet<string>;
  helper: string;
  helperArguments?: readonly string[];
  helperArgumentsBeforeRoot?: boolean;
  initialWarnings?: readonly ScanWarning[];
};

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isExcluded(candidate: string, exclusions: Iterable<string>): boolean {
  for (const excluded of exclusions) if (isWithin(candidate, excluded)) return true;
  return false;
}

export function runNativeScanner(options: ProtocolOptions): Promise<ScanResult> {
  const warnings = [...(options.initialWarnings ?? [])];
  const files = new Set<string>();
  const helperArguments = options.helperArguments ?? [];
  const args = options.helperArgumentsBeforeRoot
    ? [...helperArguments, options.root, ...options.exclusions]
    : [options.root, ...helperArguments, ...options.exclusions];

  return new Promise((resolve) => {
    const child = spawn(options.helper, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => terminate("Native scanner timed out"), HELPER_TIMEOUT_MS,
    );
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let boundTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (boundTimer !== undefined) clearTimeout(boundTimer);
      timeout = undefined;
      graceTimer = undefined;
      boundTimer = undefined;
    };

    const finish = (result: ScanResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    const terminate = (message: string): void => {
      if (settled || terminating) return;
      terminating = true;
      if (!child.kill("SIGTERM")) {
        finish({ files: [], warnings: [...warnings, { path: options.root, message: `${message}; cleanup failed` }] });
        return;
      }
      graceTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        boundTimer = setTimeout(() => {
          finish({ files: [], warnings: [...warnings, { path: options.root, message: `${message}; cleanup failed` }] });
        }, TERMINATION_BOUND_MS);
      }, TERMINATION_GRACE_MS);
      child.once("close", () => {
        if (!settled) finish({ files: [], warnings: [...warnings, { path: options.root, message }] });
      });
    };

    const malformed = (): void => terminate("Native scanner returned malformed output");
    const oversized = (): void => terminate("Native scanner output exceeded safety limit");

    const addRecord = (line: string): void => {
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return oversized();
      try {
        const record = JSON.parse(line) as { type?: string; path?: string; code?: string; message?: string };
        if (record.type === "file" && typeof record.path === "string") {
          const candidate = path.resolve(record.path);
          if (isWithin(candidate, options.root) && !isExcluded(candidate, options.exclusions) &&
              options.extensionSet.has(path.extname(candidate).toLowerCase())) files.add(candidate);
        } else if (record.type === "warning" && typeof record.path === "string" && typeof record.message === "string") {
          warnings.push({ path: record.path, message: `${record.code ?? "SCAN_WARNING"}: ${record.message}` });
        } else malformed();
      } catch { malformed(); }
    };

    child.stdout.on("data", (chunk: string) => {
      if (settled || terminating) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > MAX_RECORD_BYTES * 2) return oversized();
      let newline: number;
      while (!terminating && (newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).replace(/\r$/, "");
        stdout = stdout.slice(newline + 1);
        if (line) addRecord(line);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) stderr = stderr.slice(0, MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      if (!terminating) finish({ files: [], warnings: [...warnings, { path: options.root, message: `Native scanner unavailable: ${errorMessage(error)}` }] });
    });
    child.on("close", (code) => {
      if (settled || terminating) return;
      if (stdout.length > 0) return malformed();
      if (code !== 0) return finish({ files: [], warnings: [...warnings, { path: options.root, message: `Native scanner failed (${code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}` }] });
      finish({ files: [...files].sort((left, right) => left.localeCompare(right)), warnings });
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
