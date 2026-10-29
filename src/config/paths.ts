import path from "node:path";

export const DEFAULT_LIBRARY_ROOT = "/home/hari007/Music";

export function resolveLibraryRoot(configured?: string): string {
  return path.resolve(configured ?? DEFAULT_LIBRARY_ROOT);
}
