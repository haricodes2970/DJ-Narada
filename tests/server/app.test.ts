import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, closeDatabase } from "../../src/db/database.js";
import { buildCategories, type LibraryCategory } from "../../src/library/categories.js";
import type { Track } from "../../src/library/types.js";
import { startNaradaServer, type LibrarySnapshot } from "../../src/server/app.js";

const AUDIO_BYTES = Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000fake-audio-payload-0123456789");

async function fixture(): Promise<{
  root: string;
  tracks: Track[];
  categories: LibraryCategory[];
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narada-server-"));
  await fs.mkdir(path.join(root, "SeedheMauth"), { recursive: true });
  await fs.mkdir(path.join(root, "EmptyFolder"), { recursive: true });
  const filePath = path.join(root, "SeedheMauth", "101.mp3");
  await fs.writeFile(filePath, AUDIO_BYTES);
  const tracks: Track[] = [{ id: filePath, path: filePath, title: "101", artist: "Seedhe Maut", sizeBytes: AUDIO_BYTES.length }];
  const categories = buildCategories(root, tracks, ["SeedheMauth", "EmptyFolder"]);
  return {
    root,
    tracks,
    categories,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); },
  };
}

async function startWithFixture(options: { token?: string | null } = {}) {
  const data = await fixture();
  const db = await openDatabase(":memory:");
  const loadLibrary = async (root: string): Promise<LibrarySnapshot> => ({
    root,
    tracks: data.tracks,
    warnings: [],
    categories: buildCategories(root, data.tracks, ["SeedheMauth", "EmptyFolder"]),
  });
  const server = await startNaradaServer({
    libraryRoot: data.root,
    database: db,
    token: options.token ?? null,
    loadLibrary,
  });
  return {
    ...data,
    server,
    db,
    close: async () => {
      await server.close();
      closeDatabase(db);
      await data.cleanup();
    },
  };
}

test("health and library expose counts, categories, and empty folders", async () => {
  const context = await startWithFixture();
  try {
    const health = await (await fetch(`${context.server.url}/api/health`)).json() as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.tracks, 1);
    assert.equal(health.categories, 3);

    const library = await (await fetch(`${context.server.url}/api/library`)).json() as {
      categories: Array<{ id: string; trackCount: number; starred: boolean }>;
      tracks: Array<{ title: string }>;
    };
    assert.equal(library.tracks[0]?.title, "101");
    const empty = library.categories.find((category) => category.id === "EmptyFolder");
    assert.deepEqual(empty, { id: "EmptyFolder", name: "EmptyFolder", path: path.join(context.root, "EmptyFolder"), trackCount: 0, starred: false });
  } finally {
    await context.close();
  }
});

test("audio streams the whole file and honours byte ranges", async () => {
  const context = await startWithFixture();
  try {
    const url = `${context.server.url}/api/audio?path=${encodeURIComponent(context.tracks[0].path)}`;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal((await full.arrayBuffer()).byteLength, AUDIO_BYTES.length);

    const partial = await fetch(url, { headers: { range: "bytes=0-9" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 0-9/${AUDIO_BYTES.length}`);
    assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), AUDIO_BYTES.subarray(0, 10).toString());
  } finally {
    await context.close();
  }
});

test("audio rejects paths outside the catalog", async () => {
  const context = await startWithFixture();
  try {
    const outside = await fetch(`${context.server.url}/api/audio?path=${encodeURIComponent("/etc/passwd")}`);
    assert.equal(outside.status, 404);
    const traversal = await fetch(`${context.server.url}/api/audio?path=${encodeURIComponent(path.join(context.root, "..", "..", "etc", "passwd"))}`);
    assert.equal(traversal.status, 404);
  } finally {
    await context.close();
  }
});

test("token auth protects the API when configured", async () => {
  const context = await startWithFixture({ token: "secret-token" });
  try {
    const denied = await fetch(`${context.server.url}/api/library`);
    assert.equal(denied.status, 401);
    const header = await fetch(`${context.server.url}/api/library`, { headers: { "x-narada-token": "secret-token" } });
    assert.equal(header.status, 200);
    const query = await fetch(`${context.server.url}/api/library?token=secret-token`);
    assert.equal(query.status, 200);
  } finally {
    await context.close();
  }
});

test("starring a category persists through SQLite and reorders categories", async () => {
  const context = await startWithFixture();
  try {
    const target = path.join(context.root, "EmptyFolder");
    const response = await fetch(`${context.server.url}/api/stars`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { starred: boolean }).starred, true);

    const library = await (await fetch(`${context.server.url}/api/library`)).json() as {
      categories: Array<{ id: string; starred: boolean }>;
    };
    const starred = library.categories.find((category) => category.id === "EmptyFolder");
    assert.equal(starred?.starred, true);
    assert.equal(library.categories[0]?.id, "EmptyFolder");

    const stars = await (await fetch(`${context.server.url}/api/stars`)).json() as { stars: string[] };
    assert.deepEqual(stars.stars, [target]);
  } finally {
    await context.close();
  }
});
