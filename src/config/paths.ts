import path from "node:path";

export const DEFAULT_LIBRARY_ROOT = "/home/hari007/Music";
export const DEFAULT_DATABASE_PATH = path.resolve("data/narada.db");

export function resolveLibraryRoot(configured?: string): string {
  return path.resolve(configured ?? DEFAULT_LIBRARY_ROOT);
}

export function resolveDatabasePath(configured?: string): string {
  return path.resolve(configured ?? process.env.NARADA_DB ?? DEFAULT_DATABASE_PATH);
}
