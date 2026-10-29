import assert from "node:assert/strict";
import test from "node:test";

import { buildCategories, sortCategories, type LibraryCategory } from "../../src/library/categories.js";
import type { Track } from "../../src/library/types.js";

const track = (id: string, path: string): Track => ({ id, path, title: id, sizeBytes: 1 });

test("builds first-level folder categories and all-tracks category", () => {
  const categories = buildCategories("/music", [
    track("a", "/music/SeedheMauth/a.mp3"),
    track("b", "/music/SeedheMauth/sub/b.mp3"),
    track("c", "/music/Kannada/c.mp3"),
  ], ["EmptyFolder"]);
  assert.deepEqual(categories.map((category) => [category.id, category.trackCount]), [
    ["SeedheMauth", 2], ["Kannada", 1], ["EmptyFolder", 0], ["__all__", 3],
  ]);
});

test("sorts starred categories first, then count descending, then name", () => {
  const categories: LibraryCategory[] = [
    { id: "z", name: "Z", path: "/music/Z", trackCount: 20, starred: false, tracks: [] },
    { id: "b", name: "B", path: "/music/B", trackCount: 2, starred: true, tracks: [] },
    { id: "a", name: "A", path: "/music/A", trackCount: 2, starred: true, tracks: [] },
    { id: "c", name: "C", path: "/music/C", trackCount: 10, starred: false, tracks: [] },
  ];
  assert.deepEqual(sortCategories(categories).map((category) => category.name), ["A", "B", "Z", "C"]);
});
