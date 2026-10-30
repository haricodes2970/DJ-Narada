import os from "node:os";
import path from "node:path";

export const DEFAULT_LIBRARY_ROOT = "/home/hari007/Music";
export const DEFAULT_DATABASE_PATH = path.resolve("data/narada.db");

/**
 * Stable per-user data directory, independent of the current working directory.
 *
 * The terminal CLI still defaults to ./data (historical behaviour); the local
 * service uses this path so stars, history, and playlists survive any launch
 * directory.
 */
export function resolveDataDirectory(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "narada");
}

export function resolvePersistentDatabasePath(env: Record<string, string | undefined> = process.env): string {
  return path.join(resolveDataDirectory(env), "narada.db");
}

export function resolveLibraryRoot(configured?: string): string {
  return path.resolve(configured ?? DEFAULT_LIBRARY_ROOT);
}

export function resolveDatabasePath(configured?: string): string {
  return path.resolve(configured ?? process.env.NARADA_DB ?? DEFAULT_DATABASE_PATH);
}
