import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { run, type MainDependencies } from "../../src/cli/main.js";
import type { ProbeResult, ScanResult, Track } from "../../src/library/types.js";

class BufferWriter {
  isTTY = false;
  chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  get text(): string {
    return this.chunks.join("");
  }
}

function track(overrides: Partial<Track> & Pick<Track, "id" | "path" | "title">): Track {
  return { sizeBytes: 1, ...overrides };
}

const tracks: Track[] = [
  track({
    id: "/music/hiphop/nanchaku.mp3",
    path: "/music/hiphop/nanchaku.mp3",
    title: "Nanchaku",
    artist: "Seedhe Maut",
    album: "Nayaab",
    durationSeconds: 222,
  }),
  track({
    id: "/music/focus/deep-work.mp3",
    path: "/music/focus/deep-work.mp3",
    title: "Deep Work",
    artist: "Ambient Lab",
    durationSeconds: 61,
  }),
];

type TestDependencies = MainDependencies & {
  stdout: BufferWriter;
  stderr: BufferWriter;
};

function dependencies(overrides: Partial<TestDependencies> = {}): TestDependencies {
  const scan: ScanResult = {
    files: tracks.map((item) => item.path),
    warnings: [{ path: "/music/secret", message: "permission denied" }],
  };
  return {
    scanLibrary: async () => scan,
    probeTrack: async (filePath): Promise<ProbeResult> => {
      const found = tracks.find((item) => item.path === filePath);
      return found === undefined
        ? { warning: { path: filePath, message: "probe failed" } }
        : { track: found };
    },
    stdout: new BufferWriter(),
    stderr: new BufferWriter(),
    isTTY: false,
    ...overrides,
  };
}

test("--help prints usage and exits zero", async () => {
  const deps = dependencies();
  const code = await run(["--help"], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /Usage:/);
  assert.match(deps.stdout.text, /narada scan/);
  assert.match(deps.stdout.text, /narada search/);
  assert.match(deps.stdout.text, /read-only/i);
  assert.equal(deps.stderr.text, "");
});

test("scan prints discovered tracks and warnings", async () => {
  const deps = dependencies();
  const code = await run(["scan"], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /Tracks: 2/);
  assert.match(deps.stdout.text, /Nanchaku/);
  assert.match(deps.stdout.text, /Seedhe Maut/);
  assert.match(deps.stdout.text, /3:42/);
  assert.match(deps.stderr.text, /permission denied/);
});

test("scan uses the configured library root", async () => {
  let receivedRoot = "";
  const deps = dependencies({
    scanLibrary: async (options) => {
      receivedRoot = options.root;
      return { files: [], warnings: [] };
    },
  });
  const code = await run(["--library", "/tmp/narada-fixture", "scan"], deps);
  assert.equal(code, 0);
  assert.equal(receivedRoot, "/tmp/narada-fixture");
  assert.match(deps.stdout.text, /Tracks: 0/);
});

test("search filters by query", async () => {
  const deps = dependencies();
  const code = await run(["search", "seedhe"], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /Nanchaku/);
  assert.doesNotMatch(deps.stdout.text, /Deep Work/);
});

test("search with no matches explains the result", async () => {
  const deps = dependencies();
  const code = await run(["search", "no-such-track"], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /No tracks matched/);
});

test("argument errors go to stderr with exit code 2", async () => {
  const deps = dependencies();
  const code = await run(["search"], deps);
  assert.equal(code, 2);
  assert.match(deps.stderr.text, /Missing search query/);
  assert.match(deps.stderr.text, /Usage:/);
});

test("unknown commands go to stderr with exit code 2", async () => {
  const deps = dependencies();
  const code = await run(["dance"], deps);
  assert.equal(code, 2);
  assert.match(deps.stderr.text, /Unknown command/);
});

test("probe failures do not fail the scan command", async () => {
  const deps = dependencies({
    probeTrack: async (filePath) => ({
      warning: { path: filePath, message: "ffprobe unavailable" },
    }),
  });
  const code = await run(["scan"], deps);
  assert.equal(code, 0);
  assert.match(deps.stderr.text, /ffprobe unavailable/);
  assert.match(deps.stdout.text, /Tracks: 0/);
});

test("library scan prints a database summary", async () => {
  const deps = dependencies({
    libraryScan: async () => ({
      root: "/music",
      databasePath: "/tmp/narada.db",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      filesSeen: 2,
      present: 2,
      missing: 0,
      markedMissing: 0,
      errors: 0,
      added: 2,
      updated: 0,
      unchanged: 0,
      duplicates: [],
      warnings: [],
      scanRunId: 1,
    }),
  });
  const code = await run(["library", "scan"], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /Database: \/tmp\/narada\.db/);
  assert.match(deps.stdout.text, /Tracks: 2/);
  assert.match(deps.stdout.text, /Added: 2/);
});

test("library status reports a missing database", async () => {
  const deps = dependencies({
    libraryStatus: async () => ({
      databasePath: "/tmp/missing.db",
      exists: false,
      schemaVersion: 0,
      counts: { total: 0, present: 0, missing: 0, errors: 0, duplicates: 0 },
      duplicates: [],
      tracks: [],
    }),
  });
  const code = await run(["library", "status"], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /No library database/);
});

test("library duplicates prints duplicate groups", async () => {
  const deps = dependencies({
    libraryDuplicates: async () => [
      {
        contentHash: "abcdef1234567890",
        tracks: [
          { id: "/music/a.mp3", path: "/music/a.mp3", sizeBytes: 1, title: "A", scanStatus: "present", firstSeenAt: "", lastSeenAt: "", updatedAt: "" },
          { id: "/music/b.mp3", path: "/music/b.mp3", sizeBytes: 1, title: "B", scanStatus: "present", firstSeenAt: "", lastSeenAt: "", updatedAt: "" },
        ],
      },
    ],
  });
  const code = await run(["library", "duplicates"], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /Duplicate content groups: 1/);
  assert.match(deps.stdout.text, /\/music\/a\.mp3/);
  assert.match(deps.stdout.text, /\/music\/b\.mp3/);
});

test("analyze reports analyzed, cached and failed tracks", async () => {
  const seen: Track[][] = [];
  const deps = dependencies({
    libraryStatus: async () => ({
      databasePath: "/tmp/narada.db",
      exists: true,
      schemaVersion: 2,
      counts: { total: 2, present: 2, missing: 0, errors: 0, duplicates: 0 },
      duplicates: [],
      tracks: [
        { id: "/music/a.mp3", path: "/music/a.mp3", sizeBytes: 1, title: "A", contentHash: "ha", scanStatus: "present", firstSeenAt: "", lastSeenAt: "", updatedAt: "" },
        { id: "/music/b.mp3", path: "/music/b.mp3", sizeBytes: 1, title: "B", contentHash: "hb", scanStatus: "present", firstSeenAt: "", lastSeenAt: "", updatedAt: "" },
      ],
    }),
    analyzeTracks: async (tracks) => {
      seen.push([...tracks]);
      return {
        total: 2,
        analyzed: 1,
        cached: 1,
        failed: 0,
        aborted: false,
        warnings: [],
      };
    },
  });
  const code = await run(["analyze"], deps);
  assert.equal(code, 0);
  assert.match(deps.stdout.text, /Analyzed: 1 · Cached: 1 · Failed: 0/);
  assert.deepEqual(seen[0].map((item) => item.contentHash), ["ha", "hb"]);
});

test("analyze returns a failure code when a track cannot be analyzed", async () => {
  const deps = dependencies({
    libraryStatus: async () => ({
      databasePath: "/tmp/narada.db",
      exists: true,
      schemaVersion: 2,
      counts: { total: 1, present: 1, missing: 0, errors: 0, duplicates: 0 },
      duplicates: [],
      tracks: [{ id: "/music/a.mp3", path: "/music/a.mp3", sizeBytes: 1, title: "A", scanStatus: "present", firstSeenAt: "", lastSeenAt: "", updatedAt: "" }],
    }),
    analyzeTracks: async () => ({
      total: 1,
      analyzed: 0,
      cached: 0,
      failed: 1,
      aborted: false,
      warnings: [{ path: "/music/a.mp3", message: "bad audio" }],
    }),
  });
  const code = await run(["library", "analyze"], deps);
  assert.equal(code, 1);
  assert.match(deps.stderr.text, /bad audio/);
});

test("console command routes to the console runner", async () => {
  const calls: Array<{ libraryRoot: string; demo: boolean }> = [];
  const deps = dependencies({
    consoleRunner: async (options) => {
      calls.push(options);
      return 0;
    },
  });
  const code = await run(["--library", "/tmp/music", "console"], deps);
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ libraryRoot: "/tmp/music", demo: false }]);
});

test("demo command enables the synthetic clock", async () => {
  const calls: Array<{ libraryRoot: string; demo: boolean }> = [];
  const deps = dependencies({
    consoleRunner: async (options) => {
      calls.push(options);
      return 0;
    },
  });
  const code = await run(["demo"], deps);
  assert.equal(code, 0);
  assert.equal(calls[0]?.demo, true);
});

test("console without a runner is a clear error", async () => {
  const deps = dependencies({ consoleRunner: undefined });
  const code = await run(["console"], deps);
  assert.equal(code, 2);
  assert.match(deps.stderr.text, /unavailable/);
});

test("no arguments in a non-TTY prints help and exits two", async () => {
  const deps = dependencies();
  const code = await run([], deps);
  assert.equal(code, 2);
  assert.match(deps.stdout.text, /Usage:/);
});

test("compiled entry point has a node shebang and bin mapping", async () => {
  const entry = await fs.readFile(path.resolve("dist/src/index.js"), "utf8");
  assert.equal(entry.split("\n")[0], "#!/usr/bin/env node");
  const manifest = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  assert.equal(manifest.bin?.narada, "dist/src/index.js");
});
