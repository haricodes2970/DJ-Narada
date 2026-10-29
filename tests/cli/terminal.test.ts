import assert from "node:assert/strict";
import test from "node:test";

import {
  ChildProcessRegistry,
  KeyParser,
  TerminalSession,
  mapKey,
  type OwnedChild,
  type TerminalInput,
  type TerminalOutput,
} from "../../src/cli/terminal.js";

class FakeInput implements TerminalInput {
  isTTY: boolean;
  isRaw = false;
  rawModes: boolean[] = [];
  listeners = new Set<(chunk: string | Buffer) => void>();
  resumed = 0;
  paused = 0;

  constructor(isTTY: boolean) {
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
    this.isRaw = mode;
  }

  resume(): void {
    this.resumed += 1;
  }

  pause(): void {
    this.paused += 1;
  }

  on(_event: "data", listener: (chunk: string | Buffer) => void): void {
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (chunk: string | Buffer) => void): void {
    this.listeners.delete(listener);
  }

  emit(chunk: string): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

class FakeOutput implements TerminalOutput {
  isTTY: boolean;
  columns = 120;
  rows = 40;
  chunks: string[] = [];

  constructor(isTTY: boolean) {
    this.isTTY = isTTY;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

class FakeChild implements OwnedChild {
  pid = 1;
  signals: string[] = [];
  alive = true;

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (!this.alive) return false;
    this.alive = false;
    return true;
  }
}

test("maps navigation and playback keys", () => {
  assert.equal(mapKey("j"), "down");
  assert.equal(mapKey("k"), "up");
  assert.equal(mapKey("\u001b[B"), "down");
  assert.equal(mapKey("\u001b[A"), "up");
  assert.equal(mapKey("g"), "top");
  assert.equal(mapKey("G"), "bottom");
  assert.equal(mapKey("\t"), "nextPanel");
  assert.equal(mapKey("\u001b[Z"), "previousPanel");
  assert.equal(mapKey("\r"), "select");
  assert.equal(mapKey("\n"), "select");
  assert.equal(mapKey(" "), "pause");
  assert.equal(mapKey("p"), "play");
  assert.equal(mapKey("n"), "next");
  assert.equal(mapKey("b"), "previous");
  assert.equal(mapKey("+"), "volumeUp");
  assert.equal(mapKey("-"), "volumeDown");
  assert.equal(mapKey("/"), "search");
  assert.equal(mapKey("m"), "mode");
  assert.equal(mapKey("r"), "rescan");
  assert.equal(mapKey("?"), "help");
  assert.equal(mapKey("q"), "quit");
  assert.equal(mapKey("\u0003"), "quit");
  assert.equal(mapKey("\u001b"), "back");
  assert.equal(mapKey("z"), "unknown");
});

test("key parser emits printable characters and control keys", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("jk"), ["j", "k"]);
  assert.deepEqual(parser.push("\u0003"), ["\u0003"]);
  assert.deepEqual(parser.push("\r"), ["\r"]);
});

test("key parser handles arrow sequences split across chunks", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b"), []);
  assert.deepEqual(parser.push("["), []);
  assert.deepEqual(parser.push("B"), ["\u001b[B"]);
});

test("key parser handles multiple keys in one chunk", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("j\u001b[Bk"), ["j", "\u001b[B", "k"]);
});

test("key parser preserves multi-byte unicode as single keys", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("é日"), ["é", "日"]);
});

test("non-TTY sessions never enter interactive mode", () => {
  const input = new FakeInput(false);
  const output = new FakeOutput(false);
  const session = new TerminalSession({ input, output });

  assert.equal(session.start(), false);
  assert.deepEqual(input.rawModes, []);
  assert.equal(output.text, "");

  session.render("hello");
  assert.equal(output.text, "hello\n");
});

test("TTY sessions enter raw mode and alternate screen", () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const session = new TerminalSession({ input, output });

  assert.equal(session.start(), true);
  assert.deepEqual(input.rawModes, [true]);
  assert.match(output.text, /\u001b\[\?1049h/);
  assert.match(output.text, /\u001b\[\?25l/);
});

test("close restores terminal state exactly once", () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const session = new TerminalSession({ input, output });

  session.start();
  session.close();
  session.close();

  assert.deepEqual(input.rawModes, [true, false]);
  assert.match(output.text, /\u001b\[\?25h/);
  assert.match(output.text, /\u001b\[\?1049l/);
});

test("close terminates only registered children", async () => {
  const registry = new ChildProcessRegistry();
  const owned = new FakeChild();
  const unrelated = new FakeChild();
  registry.register(owned);

  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const session = new TerminalSession({ input, output, registry });
  session.start();
  session.close();
  await registry.terminateOwned();

  assert.deepEqual(owned.signals, ["SIGTERM"]);
  assert.deepEqual(unrelated.signals, []);
});

test("unregistered children are never terminated", async () => {
  const registry = new ChildProcessRegistry();
  const child = new FakeChild();
  registry.register(child);
  registry.unregister(child);
  await registry.terminateOwned();
  assert.deepEqual(child.signals, []);
});

test("registry termination is idempotent", async () => {
  const registry = new ChildProcessRegistry();
  const child = new FakeChild();
  registry.register(child);
  await registry.terminateOwned();
  await registry.terminateOwned();
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("input handler receives mapped actions", () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const session = new TerminalSession({ input, output });
  const actions: string[] = [];
  session.onInput((action) => actions.push(action));
  session.start();
  input.emit("j");
  input.emit("\u001b[B");
  input.emit("q");
  assert.deepEqual(actions, ["down", "down", "quit"]);
});

test("close removes the input listener", () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const session = new TerminalSession({ input, output });
  const actions: string[] = [];
  session.onInput((action) => actions.push(action));
  session.start();
  session.close();
  input.emit("j");
  assert.deepEqual(actions, []);
});

test("terminal size is exposed for layout", () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  output.columns = 100;
  output.rows = 30;
  const session = new TerminalSession({ input, output });
  assert.deepEqual(session.size(), { columns: 100, rows: 30 });
});
