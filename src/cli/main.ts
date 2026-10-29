import { ArgumentError, parseArgs } from "./commands.js";
import { DEFAULT_LIBRARY_ROOT } from "../config/paths.js";
import { buildCatalog } from "../library/catalog.js";
import { probeTrack } from "../library/metadata.js";
import { scanLibrary } from "../library/scanner.js";
import { searchTracks } from "../library/search.js";
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
};

export const HELP_TEXT = `Narada DJ — terminal-native local DJ

Usage:
  narada --help
  narada scan
  narada search "query"
  narada --library /path scan
  narada --library /path search "query"
  narada console               interactive console (TTY only)
  narada demo                  console with a synthetic demo clock (TTY only)
  narada                       same as narada console

Commands:
  scan      Scan the library and list discovered tracks
  search    Search title, artist, album, filename, and path
  console   Open the Narada terminal console
  demo      Open the console with synthetic playback and animation

Options:
  --library <path>   Music library root (default: /home/hari007/Music)
  --help             Show this help

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

async function runScan(root: string, deps: MainDependencies): Promise<number> {
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
