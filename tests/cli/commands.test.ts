import assert from "node:assert/strict";
import test from "node:test";

import {
  ArgumentError,
  parseArgs,
  type CliOptions,
} from "../../src/cli/commands.js";
import { DEFAULT_LIBRARY_ROOT, resolveLibraryRoot } from "../../src/config/paths.js";

test("parses help without a command", () => {
  assert.deepEqual(parseArgs(["--help"]), { command: "help" });
});

test("parses scan with the default library root", () => {
  assert.deepEqual(parseArgs(["scan"]), {
    command: "scan",
    libraryRoot: DEFAULT_LIBRARY_ROOT,
  });
});

test("parses search query", () => {
  assert.deepEqual(parseArgs(["search", "Seedhe"]), {
    command: "search",
    query: "Seedhe",
    libraryRoot: DEFAULT_LIBRARY_ROOT,
  });
});

test("parses configurable library root before a command", () => {
  assert.deepEqual(parseArgs(["--library", "./fixtures/music", "scan"]), {
    command: "scan",
    libraryRoot: resolveLibraryRoot("./fixtures/music"),
  });
});

test("parses configurable library root before search", () => {
  assert.deepEqual(parseArgs(["--library", "/tmp/music", "search", "focus"]), {
    command: "search",
    query: "focus",
    libraryRoot: "/tmp/music",
  });
});

test("rejects search without a query", () => {
  assert.throws(
    () => parseArgs(["search"]),
    (error: unknown) =>
      error instanceof ArgumentError &&
      error.message === 'Missing search query. Usage: narada search "query"',
  );
});

test("rejects library without a path", () => {
  assert.throws(
    () => parseArgs(["--library"]),
    (error: unknown) =>
      error instanceof ArgumentError &&
      error.message === "Missing path after --library. Usage: narada --library /path scan",
  );
});

test("rejects unknown options", () => {
  assert.throws(
    () => parseArgs(["--verbose"]),
    (error: unknown) =>
      error instanceof ArgumentError && error.message === "Unknown option: --verbose",
  );
});

test("rejects unknown commands", () => {
  assert.throws(
    () => parseArgs(["play"]),
    (error: unknown) =>
      error instanceof ArgumentError && error.message === "Unknown command: play",
  );
});

test("parses console and demo commands", () => {
  assert.deepEqual(parseArgs(["console"]), {
    command: "console",
    libraryRoot: DEFAULT_LIBRARY_ROOT,
  });
  assert.deepEqual(parseArgs(["--library", "/tmp/music", "demo"]), {
    command: "demo",
    libraryRoot: "/tmp/music",
  });
});

test("rejects duplicate commands", () => {
  assert.throws(
    () => parseArgs(["scan", "search", "query"]),
    (error: unknown) =>
      error instanceof ArgumentError && error.message === "Only one command may be provided",
  );
});

test("resolves the default library root as an absolute path", () => {
  assert.equal(resolveLibraryRoot(), "/home/hari007/Music");
});

test("resolves a configured relative library root from the current directory", () => {
  assert.equal(resolveLibraryRoot("./fixtures/music"), "/home/hari007/Music/DJ/fixtures/music");
});

test("keeps parsed options limited to the Task 2 contract", () => {
  const options: CliOptions = parseArgs(["scan"]);
  assert.deepEqual(Object.keys(options).sort(), ["command", "libraryRoot"]);
});
