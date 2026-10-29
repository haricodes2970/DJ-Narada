import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalog } from "../../src/library/catalog.js";
import { searchTracks } from "../../src/library/search.js";
import type { Track } from "../../src/library/types.js";

function track(overrides: Partial<Track> & Pick<Track, "id" | "path" | "title">): Track {
  return {
    sizeBytes: 1,
    ...overrides,
  };
}

const tracks: Track[] = [
  track({
    id: "/music/hiphop/seedhe-maut-nanchaku.mp3",
    path: "/music/hiphop/seedhe-maut-nanchaku.mp3",
    title: "Nanchaku",
    artist: "Seedhe Maut",
    album: "Nayaab",
  }),
  track({
    id: "/music/desi/arijit-tum-hi-ho.mp3",
    path: "/music/desi/arijit-tum-hi-ho.mp3",
    title: "Tum Hi Ho",
    artist: "Arijit Singh",
    album: "Aashiqui 2",
  }),
  track({
    id: "/music/focus/deep-work.mp3",
    path: "/music/focus/deep-work.mp3",
    title: "Deep Work",
    artist: "Ambient Lab",
  }),
];

test("empty query returns every track in input order", () => {
  assert.deepEqual(searchTracks(tracks, ""), tracks);
  assert.deepEqual(searchTracks(tracks, "   "), tracks);
});

test("matches title case-insensitively", () => {
  assert.deepEqual(searchTracks(tracks, "nAnChAkU"), [tracks[0]]);
});

test("matches artist", () => {
  assert.deepEqual(searchTracks(tracks, "seedhe"), [tracks[0]]);
});

test("matches album", () => {
  assert.deepEqual(searchTracks(tracks, "aashiqui"), [tracks[1]]);
});

test("matches filename without extension", () => {
  assert.deepEqual(searchTracks(tracks, "tum-hi-ho"), [tracks[1]]);
});

test("matches full path segments", () => {
  assert.deepEqual(searchTracks(tracks, "focus"), [tracks[2]]);
});

test("keeps deterministic input order for multi-match queries", () => {
  const result = searchTracks(tracks, "music");
  assert.deepEqual(result.map((item) => item.id), tracks.map((item) => item.id));
});

test("does not return duplicate track ids", () => {
  const duplicated = [...tracks, tracks[0]];
  const result = searchTracks(duplicated, "nayaab");
  assert.deepEqual(result.map((item) => item.id), [tracks[0].id]);
});

test("returns an empty list when nothing matches", () => {
  assert.deepEqual(searchTracks(tracks, "no-such-track"), []);
});

test("buildCatalog probes every file and retains warnings", async () => {
  const probed: string[] = [];
  const result = await buildCatalog(
    {
      files: ["/music/a.mp3", "/music/b.mp3"],
      warnings: [{ path: "/music", message: "scan warning" }],
    },
    async (filePath) => {
      probed.push(filePath);
      if (filePath.endsWith("b.mp3")) {
        return { warning: { path: filePath, message: "probe warning" } };
      }
      return {
        track: track({ id: filePath, path: filePath, title: "A" }),
      };
    },
  );

  assert.deepEqual(probed, ["/music/a.mp3", "/music/b.mp3"]);
  assert.deepEqual(result.tracks.map((item) => item.id), ["/music/a.mp3"]);
  assert.deepEqual(result.warnings.map((warning) => warning.message), [
    "scan warning",
    "probe warning",
  ]);
});

test("buildCatalog keeps input order even when probes resolve out of order", async () => {
  const result = await buildCatalog(
    { files: ["/music/one.mp3", "/music/two.mp3", "/music/three.mp3"], warnings: [] },
    async (filePath) => {
      if (filePath.endsWith("one.mp3")) await new Promise((resolve) => setTimeout(resolve, 20));
      return { track: track({ id: filePath, path: filePath, title: filePath }) };
    },
  );

  assert.deepEqual(result.tracks.map((item) => item.path), [
    "/music/one.mp3",
    "/music/two.mp3",
    "/music/three.mp3",
  ]);
});

test("buildCatalog tolerates a probe that throws", async () => {
  const result = await buildCatalog(
    { files: ["/music/broken.mp3"], warnings: [] },
    async (filePath) => {
      throw new Error(`boom: ${filePath}`);
    },
  );

  assert.deepEqual(result.tracks, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /boom/);
});
