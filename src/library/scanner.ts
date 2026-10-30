import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runNativeScanner } from "./protocol.js";
import type { ScanOptions, ScanResult } from "./types.js";

/**
 * Native scanner location resolved from this module, never from process.cwd().
 *
 * A cwd-relative helper path silently produced zero tracks whenever Narada was
 * launched from outside the project directory.
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCAN_HELPER = path.resolve(MODULE_DIR, "../../native/narada-scan");

export const DEFAULT_EXCLUDED_ROOT = "/home/hari007/Music/DJ";
export const DEFAULT_AUDIO_EXTENSIONS = new Set([
  ".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".wma",
  ".aiff", ".aif", ".alac", ".ape", ".wv", ".mka", ".mp2", ".amr",
  ".ac3", ".dts", ".mid", ".midi", ".caf", ".3gp", ".3g2", ".webm",
  ".ra", ".rm", ".tta", ".dsf", ".dff",
]);

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isExcluded(candidate: string, exclusions: Iterable<string>): boolean {
  for (const excluded of exclusions) if (isWithin(candidate, excluded)) return true;
  return false;
}

async function canonicalize(candidate: string): Promise<string> {
  return fs.realpath(candidate);
}

export async function scanLibrary(options: ScanOptions): Promise<ScanResult> {
  const warnings: { path: string; message: string }[] = [];
  const extensionSet = new Set(
    [...(options.supportedExtensions ?? DEFAULT_AUDIO_EXTENSIONS)].map((extension) => extension.toLowerCase()),
  );
  const requestedRoot = path.resolve(options.root);
  const requestedExclusions = [DEFAULT_EXCLUDED_ROOT, ...(options.excludedRoots ?? [])]
    .map((root) => path.resolve(root));
  let root: string;
  try {
    root = await canonicalize(requestedRoot);
  } catch (error) {
    return { files: [], warnings: [{ path: requestedRoot, message: `Unable to resolve scan root: ${errorMessage(error)}` }] };
  }
  const exclusions = new Set<string>();
  for (const exclusion of requestedExclusions) {
    try { exclusions.add(await canonicalize(exclusion)); }
    catch (error) { warnings.push({ path: exclusion, message: `Unable to resolve exclusion: ${errorMessage(error)}` }); }
  }
  if (isExcluded(root, exclusions)) return { files: [], warnings: [{ path: root, message: "Scan root is inside an excluded path" }] };
  return runNativeScanner({
    root,
    exclusions,
    extensionSet,
    helper: process.env.NARADA_SCAN_HELPER ?? DEFAULT_SCAN_HELPER,
    initialWarnings: warnings,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
