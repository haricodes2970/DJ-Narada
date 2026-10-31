import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { resolveDatabasePath } from "../config/paths.js";
import { closeDatabase, openDatabase } from "../db/database.js";
import { buildCatalog } from "../library/catalog.js";
import { CategoryStarRepository } from "../library/categoryStars.js";
import { ALL_TRACKS_CATEGORY, buildCategories, sortCategories, type LibraryCategory } from "../library/categories.js";
import { probeTrack } from "../library/metadata.js";
import { DEFAULT_AUDIO_EXTENSIONS, scanLibrary } from "../library/scanner.js";
import type { ScanWarning, Track } from "../library/types.js";

/** First-level folders that hold application data, never music. */
export const NON_MUSIC_FOLDERS = new Set(["DJ", "data", "logs", "node_modules", ".git"]);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEB_ROOT = path.resolve(MODULE_DIR, "../../../web");
export const DJ_TRANSITIONS_DIR = path.resolve(MODULE_DIR, "../../../web/assets/dj/transitions");

export type LibrarySnapshot = {
  root: string;
  tracks: Track[];
  warnings: ScanWarning[];
  categories: LibraryCategory[];
};

export type NaradaServerOptions = {
  libraryRoot: string;
  host?: string;
  port?: number;
  /** Pass null to disable token auth (tests only). */
  token?: string | null;
  databasePath?: string;
  database?: DatabaseSync;
  loadLibrary?: (root: string) => Promise<LibrarySnapshot>;
  assetRoot?: string;
  /** Directory containing index.html, app.js, styles.css, assets/. */
  staticRoot?: string;
};

export type NaradaServer = {
  url: string;
  host: string;
  port: number;
  token: string | undefined;
  refresh(): Promise<LibrarySnapshot>;
  close(): Promise<void>;
};

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

async function defaultLoadLibrary(root: string): Promise<LibrarySnapshot> {
  const scan = await scanLibrary({ root });
  const catalog = await buildCatalog(scan, (filePath) => probeTrack(filePath));
  let folders: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    folders = entries
      .filter((entry) => entry.isDirectory() && !NON_MUSIC_FOLDERS.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    folders = [];
  }
  return {
    root,
    tracks: catalog.tracks,
    warnings: catalog.warnings,
    categories: buildCategories(root, catalog.tracks, folders),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readBody(req: http.IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function parseRange(header: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (start < 0 || end >= size || start > end) return undefined;
  return { start, end };
}

/**
 * Local Narada service.
 *
 * Binds to loopback, serves the library as JSON, streams audio with HTTP range
 * support so a browser can seek, and stores stars in SQLite.
 */
export async function startNaradaServer(options: NaradaServerOptions): Promise<NaradaServer> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token === null ? undefined : options.token ?? randomBytes(18).toString("base64url");
  const loadLibrary = options.loadLibrary ?? defaultLoadLibrary;
  const staticRoot = path.resolve(options.staticRoot ?? DEFAULT_WEB_ROOT);
  const ownsDatabase = options.database === undefined;
  const db = options.database ?? await openDatabase(options.databasePath ?? resolveDatabasePath());
  const stars = new CategoryStarRepository(db);
  let snapshot = await loadLibrary(options.libraryRoot);
  let trackPaths = new Set(snapshot.tracks.map((track) => track.path));

  const withStars = (value: LibrarySnapshot): LibrarySnapshot => {
    const starred = new Set(stars.list());
    return { ...value, categories: sortCategories(value.categories.map((category) => ({ ...category, starred: starred.has(category.path) }))) };
  };

  snapshot = withStars(snapshot);

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (token === undefined) return true;
    const header = req.headers["x-narada-token"];
    if (typeof header === "string" && header === token) return true;
    return url.searchParams.get("token") === token;
  };

  const serveAudio = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    const requested = url.searchParams.get("path") ?? "";
    if (requested.length === 0) {
      json(res, 400, { error: "Missing path" });
      return;
    }
    const resolved = path.resolve(requested);
    if (!trackPaths.has(resolved) || !isInside(path.resolve(options.libraryRoot), resolved)) {
      json(res, 404, { error: "Unknown track" });
      return;
    }
    if (!DEFAULT_AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      json(res, 404, { error: "Unsupported audio" });
      return;
    }
    let size: number;
    try {
      size = (await fs.stat(resolved)).size;
    } catch {
      json(res, 404, { error: "File missing" });
      return;
    }
    const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
    const rangeHeader = req.headers.range;
    const range = typeof rangeHeader === "string" ? parseRange(rangeHeader, size) : undefined;
    if (range !== undefined) {
      res.writeHead(206, {
        "content-type": type,
        "content-length": range.end - range.start + 1,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "accept-ranges": "bytes",
      });
      createReadStream(resolved, { start: range.start, end: range.end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "content-type": type,
      "content-length": size,
      "accept-ranges": "bytes",
    });
    createReadStream(resolved).pipe(res);
  };

  const serveWeb = async (res: http.ServerResponse, url: URL): Promise<void> => {
    let relative = decodeURIComponent(url.pathname);
    if (relative === "" || relative === "/") relative = "/index.html";
    const filePath = path.resolve(staticRoot, `.${relative}`);
    if (!isInside(staticRoot, filePath)) {
      json(res, 404, { error: "Not found" });
      return;
    }
    let body: Buffer;
    try {
      body = await fs.readFile(filePath);
    } catch {
      json(res, 404, { error: "Not found" });
      return;
    }
    const isIndex = path.basename(filePath) === "index.html";
    if (isIndex && token !== undefined) {
      body = Buffer.from(body.toString("utf8").replaceAll("__NARADA_TOKEN__", token));
    }
    res.writeHead(200, {
      "content-type": STATIC_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": isIndex ? "no-store" : "public, max-age=3600",
    });
    res.end(body);
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (req.method === "GET") await serveWeb(res, url);
        else json(res, 405, { error: "Method not allowed" });
        return;
      }
      if (!authorized(req, url)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, 200, {
          ok: true,
          root: snapshot.root,
          tracks: snapshot.tracks.length,
          categories: snapshot.categories.length,
          warnings: snapshot.warnings.length,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/library") {
        json(res, 200, {
          root: snapshot.root,
          tracks: snapshot.tracks,
          warnings: snapshot.warnings,
          categories: snapshot.categories.map((category) => ({
            id: category.id,
            name: category.name,
            path: category.path,
            trackCount: category.trackCount,
            starred: category.starred,
          })),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/tracks") {
        const categoryId = url.searchParams.get("category");
        const category = categoryId === null
          ? undefined
          : snapshot.categories.find((item) => item.id === categoryId);
        json(res, 200, { tracks: (category?.tracks ?? snapshot.tracks) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/audio") {
        await serveAudio(req, res, url);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/stars") {
        json(res, 200, { stars: stars.list() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/stars") {
        const body = await readBody(req) as { path?: unknown } | undefined;
        const target = typeof body?.path === "string" ? path.resolve(body.path) : "";
        const category = snapshot.categories.find((item) => item.path === target && item.id !== ALL_TRACKS_CATEGORY);
        if (category === undefined) {
          json(res, 400, { error: "Unknown category" });
          return;
        }
        const starred = stars.toggle(target);
        snapshot = withStars(snapshot);
        json(res, 200, { path: target, starred, stars: stars.list() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/dj/transitions") {
        let files: string[];
        try {
          files = await fs.readdir(DJ_TRANSITIONS_DIR);
        } catch {
          files = [];
        }
        const transitions = files
          .filter((f) => /\.(m4a|mp3|wav|ogg)$/i.test(f))
          .map((f) => ({ name: f, path: `/api/dj/transition?file=${encodeURIComponent(f)}` }));
        json(res, 200, { transitions });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/dj/transition") {
        const file = url.searchParams.get("file");
        if (typeof file !== "string" || file.length === 0) {
          json(res, 400, { error: "Missing file" });
          return;
        }
        const resolved = path.resolve(DJ_TRANSITIONS_DIR, file);
        if (!isInside(DJ_TRANSITIONS_DIR, resolved)) {
          json(res, 403, { error: "Forbidden" });
          return;
        }
        let size: number;
        try {
          size = (await fs.stat(resolved)).size;
        } catch {
          json(res, 404, { error: "Transition not found" });
          return;
        }
        const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "audio/mpeg";
        const rangeHeader = req.headers.range;
        const range = typeof rangeHeader === "string" ? parseRange(rangeHeader, size) : undefined;
        if (range !== undefined) {
          res.writeHead(206, {
            "content-type": type,
            "content-length": range.end - range.start + 1,
            "content-range": `bytes ${range.start}-${range.end}/${size}`,
            "accept-ranges": "bytes",
          });
          createReadStream(resolved, { start: range.start, end: range.end }).pipe(res);
          return;
        }
        res.writeHead(200, {
          "content-type": type,
          "content-length": size,
          "accept-ranges": "bytes",
        });
        createReadStream(resolved).pipe(res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        const fresh = await loadLibrary(options.libraryRoot);
        trackPaths = new Set(fresh.tracks.map((track) => track.path));
        snapshot = withStars(fresh);
        json(res, 200, { tracks: snapshot.tracks.length, categories: snapshot.categories.length });
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;

  return {
    url: `http://${host}:${port}`,
    host,
    port,
    token,
    refresh: async () => {
      const fresh = await loadLibrary(options.libraryRoot);
      trackPaths = new Set(fresh.tracks.map((track) => track.path));
      snapshot = withStars(fresh);
      return snapshot;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownsDatabase) closeDatabase(db);
    },
  };
}
