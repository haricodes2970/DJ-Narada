import { ArgumentError, parseArgs } from "./commands.js";
import { DEFAULT_LIBRARY_ROOT, resolveDatabasePath } from "../config/paths.js";
import type { DuplicateGroup } from "../db/tracks.js";
import { storedTrackToTrack } from "../db/tracks.js";
import { analyzeTracksWithCache, type AnalyzeTracksSummary } from "../analysis/cache.js";
import { buildCatalog } from "../library/catalog.js";
import { probeTrack } from "../library/metadata.js";
import { scanLibrary } from "../library/scanner.js";
import { searchTracks } from "../library/search.js";
import {
  libraryDuplicates,
  libraryStatus,
  scanLibraryToDatabase,
  type LibraryScanSummary,
  type LibraryStatusSummary,
} from "../library/libraryService.js";
import type { ProbeOptions, ProbeResult, ScanOptions, ScanResult, Track } from "../library/types.js";

export type OutputStream = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

export type MainDependencies = {
  scanLibrary: (options: ScanOptions) => Promise<ScanResult>;
  probeTrack: (filePath: string, options?: ProbeOptions) => Promise<ProbeResult>;
  stdout: OutputStream;
  stderr: OutputStream;
  isTTY: boolean;
  interactive?: () => Promise<void>;
  consoleRunner?: (options: { libraryRoot: string; demo: boolean }) => Promise<number>;
  databasePath?: string;
  libraryScan?: (options: { root: string; databasePath?: string }) => Promise<LibraryScanSummary>;
  libraryStatus?: (options: { databasePath?: string; root?: string; includeTracks?: boolean }) => Promise<LibraryStatusSummary>;
  libraryDuplicates?: (options: { databasePath?: string; root?: string }) => Promise<DuplicateGroup[]>;
  analyzeTracks?: (tracks: readonly Track[], options: { databasePath?: string }) => Promise<AnalyzeTracksSummary>;
};

export const HELP_TEXT = `Narada DJ — terminal-native local DJ

Usage:
  narada --help
  narada scan
  narada search "query"
  narada --library /path scan
  narada --library /path search "query"
  narada library scan
  narada library status
  narada library duplicates
  narada library analyze
  narada analyze
  narada console               interactive console (TTY only)
  narada demo                  console with a synthetic demo clock (TTY only)
  narada                       same as narada console

Commands:
  scan      Scan into SQLite and print a summary (alias of library scan)
  search    Search title, artist, album, filename, and path
  library   scan | status | duplicates | analyze
  analyze   Analyze present tracks and cache audio features
  console   Open the Narada terminal console
  demo      Open the console with synthetic playback and animation

Options:
  --library <path>   Music library root (default: /home/hari007/Music)
  --help             Show this help

Environment:
  NARADA_DB          SQLite database path (default: ./data/narada.db)

Safety:
  Read-only. Narada never moves, renames, deletes, or rewrites audio files.
`;

async function defaultConsoleRunner(options: { libraryRoot: string; demo: boolean }): Promise<number> {
  const { runConsole } = await import("../ui/console.js");
  return runConsole({ libraryRoot: options.libraryRoot, demo: options.demo });
}

function defaultDependencies(): MainDependencies {
  return {
    scanLibrary,
    probeTrack,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    consoleRunner: defaultConsoleRunner,
    databasePath: resolveDatabasePath(),
    libraryScan: (options) => scanLibraryToDatabase(options),
    libraryStatus: (options) => libraryStatus(options),
    libraryDuplicates: (options) => libraryDuplicates(options),
    analyzeTracks: (tracks, options) => analyzeTracksWithCache(tracks, { databasePath: options.databasePath }),
  };
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatTrack(track: Track, index: number): string {
  const details = [track.artist, track.album, formatDuration(track.durationSeconds)]
    .filter((value): value is string => value !== undefined && value.length > 0);
  const suffix = details.length > 0 ? ` — ${details.join(" · ")}` : "";
  return `${String(index + 1).padStart(3)}. ${track.title}${suffix}\n`;
}

function writeWarnings(deps: MainDependencies, warnings: readonly { path: string; message: string }[]): void {
  for (const warning of warnings) {
    deps.stderr.write(`warning: ${warning.path}: ${warning.message}\n`);
  }
}

async function catalogFor(root: string, deps: MainDependencies): Promise<{
  tracks: Track[];
  warnings: { path: string; message: string }[];
}> {
  const scan = await deps.scanLibrary({ root });
  const catalog = await buildCatalog(scan, (filePath) => deps.probeTrack(filePath));
  return catalog;
}

function writeDuplicates(deps: MainDependencies, groups: readonly DuplicateGroup[]): void {
  if (groups.length === 0) return;
  deps.stdout.write(`\nDuplicate content groups: ${groups.length}\n`);
  for (const group of groups) {
    deps.stdout.write(`  ${group.contentHash.slice(0, 16)}…\n`);
    for (const track of group.tracks) deps.stdout.write(`    - ${track.path}\n`);
  }
}

function writeScanSummary(deps: MainDependencies, summary: LibraryScanSummary): void {
  deps.stdout.write(`Library: ${summary.root}\n`);
  deps.stdout.write(`Database: ${summary.databasePath}\n`);
  deps.stdout.write(`Tracks: ${summary.present}\n`);
  deps.stdout.write(`Added: ${summary.added} · Updated: ${summary.updated} · Unchanged: ${summary.unchanged}\n`);
  deps.stdout.write(`Missing: ${summary.missing} (newly marked ${summary.markedMissing}) · Errors: ${summary.errors} · Duplicate groups: ${summary.duplicates.length}\n`);
  deps.stdout.write(`Warnings: ${summary.warnings.length}\n`);
  writeDuplicates(deps, summary.duplicates);
  writeWarnings(deps, summary.warnings);
}

async function runScan(root: string, deps: MainDependencies): Promise<number> {
  if (deps.libraryScan !== undefined) {
    const summary = await deps.libraryScan({ root, databasePath: deps.databasePath });
    writeScanSummary(deps, summary);
    return 0;
  }
  const catalog = await catalogFor(root, deps);
  deps.stdout.write(`Library: ${root}\n`);
  deps.stdout.write(`Tracks: ${catalog.tracks.length}\n`);
  deps.stdout.write(`Warnings: ${catalog.warnings.length}\n`);
  if (catalog.tracks.length > 0) {
    deps.stdout.write("\n");
    for (let index = 0; index < catalog.tracks.length; index += 1) {
      deps.stdout.write(formatTrack(catalog.tracks[index], index));
    }
  }
  writeWarnings(deps, catalog.warnings);
  return 0;
}

async function runAnalyze(root: string, deps: MainDependencies): Promise<number> {
  if (deps.libraryStatus === undefined || deps.analyzeTracks === undefined) {
    deps.stderr.write("Analysis support is unavailable in this build.\n");
    return 2;
  }
  const status = await deps.libraryStatus({ databasePath: deps.databasePath, root, includeTracks: true });
  if (!status.exists) {
    deps.stdout.write(`No library database at ${status.databasePath}. Run: narada library scan\n`);
    return 0;
  }
  const tracks = status.tracks.map(storedTrackToTrack);
  if (tracks.length === 0) {
    deps.stdout.write("No present tracks to analyze.\n");
    return 0;
  }
  deps.stdout.write(`Analyzing ${tracks.length} track(s)…\n`);
  const summary = await deps.analyzeTracks(tracks, { databasePath: deps.databasePath });
  deps.stdout.write(`Analyzed: ${summary.analyzed} · Cached: ${summary.cached} · Failed: ${summary.failed}\n`);
  writeWarnings(deps, summary.warnings);
  return summary.failed > 0 ? 1 : 0;
}

async function runLibrary(
  action: "scan" | "status" | "duplicates" | "analyze",
  root: string,
  deps: MainDependencies,
): Promise<number> {
  if (action === "scan") {
    if (deps.libraryScan === undefined) {
      deps.stderr.write("Library database support is unavailable in this build.\n");
      return 2;
    }
    const summary = await deps.libraryScan({ root, databasePath: deps.databasePath });
    writeScanSummary(deps, summary);
    return 0;
  }

  if (action === "analyze") return runAnalyze(root, deps);

  if (action === "duplicates") {
    if (deps.libraryDuplicates === undefined) {
      deps.stderr.write("Library database support is unavailable in this build.\n");
      return 2;
    }
    const groups = await deps.libraryDuplicates({ databasePath: deps.databasePath, root });
    if (groups.length === 0) deps.stdout.write("No duplicate content found.\n");
    else writeDuplicates(deps, groups);
    return 0;
  }

  if (deps.libraryStatus === undefined) {
    deps.stderr.write("Library database support is unavailable in this build.\n");
    return 2;
  }
  const status = await deps.libraryStatus({ databasePath: deps.databasePath, root });
  if (!status.exists) {
    deps.stdout.write(`No library database at ${status.databasePath}. Run: narada library scan\n`);
    return 0;
  }
  deps.stdout.write(`Database: ${status.databasePath}\n`);
  deps.stdout.write(`Schema: v${status.schemaVersion}\n`);
  deps.stdout.write(`Tracks: ${status.counts.present} present · ${status.counts.missing} missing · ${status.counts.errors} errors · ${status.counts.total} total\n`);
  deps.stdout.write(`Duplicate groups: ${status.duplicates.length}\n`);
  if (status.lastScan !== undefined) {
    deps.stdout.write(`Last scan: ${status.lastScan.finishedAt} · ${status.lastScan.filesSeen} files · ${status.lastScan.added} added · ${status.lastScan.updated} updated · ${status.lastScan.unchanged} unchanged\n`);
  } else {
    deps.stdout.write("Last scan: none\n");
  }
  writeDuplicates(deps, status.duplicates);
  return 0;
}

async function runSearch(root: string, query: string, deps: MainDependencies): Promise<number> {
  const catalog = await catalogFor(root, deps);
  const matches = searchTracks(catalog.tracks, query);
  if (matches.length === 0) {
    deps.stdout.write(`No tracks matched "${query}".\n`);
  } else {
    deps.stdout.write(`Found ${matches.length} track(s) for "${query}".\n\n`);
    for (let index = 0; index < matches.length; index += 1) {
      deps.stdout.write(formatTrack(matches[index], index));
    }
  }
  writeWarnings(deps, catalog.warnings);
  return 0;
}

/**
 * Run one CLI invocation.
 *
 * All I/O and subprocess work is injectable so integration tests never scan a
 * personal library or invoke a real media tool.
 */
export async function run(
  argv: readonly string[],
  dependencies: MainDependencies = defaultDependencies(),
): Promise<number> {
  if (argv.length === 0) {
    if (dependencies.isTTY && dependencies.consoleRunner !== undefined) {
      return dependencies.consoleRunner({ libraryRoot: DEFAULT_LIBRARY_ROOT, demo: false });
    }
    if (dependencies.isTTY && dependencies.interactive !== undefined) {
      await dependencies.interactive();
      return 0;
    }
    dependencies.stdout.write(HELP_TEXT);
    return 2;
  }

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof ArgumentError) {
      dependencies.stderr.write(`error: ${error.message}\n\n`);
      dependencies.stderr.write(HELP_TEXT);
      return 2;
    }
    throw error;
  }

  switch (options.command) {
    case "help":
      dependencies.stdout.write(HELP_TEXT);
      return 0;
    case "scan":
      return runScan(options.libraryRoot, dependencies);
    case "search":
      return runSearch(options.libraryRoot, options.query, dependencies);
    case "library":
      return runLibrary(options.action, options.libraryRoot, dependencies);
    case "analyze":
      return runAnalyze(options.libraryRoot, dependencies);
    case "console":
    case "demo": {
      if (dependencies.consoleRunner === undefined) {
        dependencies.stderr.write("Interactive console is unavailable in this build.\n");
        return 2;
      }
      return dependencies.consoleRunner({
        libraryRoot: options.libraryRoot,
        demo: options.command === "demo",
      });
    }
  }
}
