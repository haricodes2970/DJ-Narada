import path from "node:path";

import type { Track } from "./types.js";

export const ALL_TRACKS_CATEGORY = "__all__";

export type LibraryCategory = {
  id: string;
  name: string;
  path: string;
  trackCount: number;
  starred: boolean;
  tracks: Track[];
};

function isInside(folderPath: string, trackPath: string): boolean {
  const relative = path.relative(folderPath, trackPath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

export function buildCategories(root: string, tracks: readonly Track[], folders: readonly string[] = []): LibraryCategory[] {
  const folderNames = new Set(folders);
  for (const track of tracks) {
    const relative = path.relative(root, track.path);
    const first = relative.split(path.sep)[0];
    if (first && first !== ".") folderNames.add(first);
  }
  const byName = new Map<string, Track[]>();
  for (const folder of folderNames) {
    const folderPath = path.join(root, folder);
    byName.set(folder, tracks.filter((track) => isInside(folderPath, track.path)));
  }
  const categories: LibraryCategory[] = [{ id: ALL_TRACKS_CATEGORY, name: "ALL TRACKS", path: root, trackCount: tracks.length, starred: false, tracks: [...tracks] }];
  for (const [name, categoryTracks] of byName) {
    categories.push({ id: name, name, path: path.join(root, name), trackCount: categoryTracks.length, starred: false, tracks: categoryTracks });
  }
  return sortCategories(categories);
}

export function sortCategories(categories: readonly LibraryCategory[]): LibraryCategory[] {
  return [...categories].sort((a, b) => {
    if (a.id === ALL_TRACKS_CATEGORY) return -1;
    if (b.id === ALL_TRACKS_CATEGORY) return 1;
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    return b.trackCount - a.trackCount || a.name.localeCompare(b.name);
  });
}

export function toggleCategoryStar(categories: readonly LibraryCategory[], id: string): LibraryCategory[] {
  return sortCategories(categories.map((category) => category.id === id ? { ...category, starred: !category.starred } : category));
}
