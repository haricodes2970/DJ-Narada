import { resolveLibraryRoot, DEFAULT_LIBRARY_ROOT } from "../config/paths.js";

export type CliOptions =
  | { command: "help" }
  | { command: "scan"; libraryRoot: string }
  | { command: "search"; query: string; libraryRoot: string }
  | { command: "console"; libraryRoot: string }
  | { command: "demo"; libraryRoot: string }
  | { command: "library"; action: "scan" | "status" | "duplicates"; libraryRoot: string };

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let index = 0;
  let configuredLibraryRoot: string | undefined;

  if (argv[index] === "--help") {
    if (argv.length !== 1) {
      throw new ArgumentError("--help cannot be combined with another argument");
    }
    return { command: "help" };
  }

  if (argv[index] === "--library") {
    const configuredPath = argv[index + 1];
    if (configuredPath === undefined || configuredPath.startsWith("-")) {
      throw new ArgumentError(
        "Missing path after --library. Usage: narada --library /path scan",
      );
    }
    configuredLibraryRoot = configuredPath;
    index += 2;
  }

  const command = argv[index];
  if (command === undefined) {
    throw new ArgumentError("Missing command. Use --help for usage");
  }

  const libraryRoot = resolveLibraryRoot(configuredLibraryRoot ?? DEFAULT_LIBRARY_ROOT);

  if (command === "scan") {
    if (index + 1 < argv.length) {
      throw new ArgumentError("Only one command may be provided");
    }
    return { command, libraryRoot };
  }

  if (command === "search") {
    const query = argv[index + 1];
    if (query === undefined || query.length === 0) {
      throw new ArgumentError('Missing search query. Usage: narada search "query"');
    }
    if (index + 2 < argv.length) {
      throw new ArgumentError("Only one command may be provided");
    }
    return { command, query, libraryRoot };
  }

  if (command === "console" || command === "demo") {
    if (index + 1 < argv.length) {
      throw new ArgumentError("Only one command may be provided");
    }
    return { command, libraryRoot };
  }

  if (command === "library") {
    const action = argv[index + 1];
    if (action !== "scan" && action !== "status" && action !== "duplicates") {
      throw new ArgumentError("Missing library action. Usage: narada library scan|status|duplicates");
    }
    if (index + 2 < argv.length) {
      throw new ArgumentError("Only one command may be provided");
    }
    return { command: "library", action, libraryRoot };
  }

  if (command.startsWith("-")) {
    throw new ArgumentError(`Unknown option: ${command}`);
  }
  throw new ArgumentError(`Unknown command: ${command}`);
}
