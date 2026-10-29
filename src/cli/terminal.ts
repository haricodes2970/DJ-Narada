export type CliAction =
  | "down"
  | "up"
  | "top"
  | "bottom"
  | "nextPanel"
  | "previousPanel"
  | "select"
  | "pause"
  | "play"
  | "next"
  | "previous"
  | "volumeUp"
  | "volumeDown"
  | "search"
  | "mode"
  | "rescan"
  | "help"
  | "quit"
  | "back"
  | "queue"
  | "shuffle"
  | "crossfade"
  | "info"
  | "diagnostics"
  | "unknown";

export interface TerminalInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume?(): void;
  pause?(): void;
  on(event: "data", listener: (chunk: string | Buffer) => void): void;
  off?(event: "data", listener: (chunk: string | Buffer) => void): void;
  removeListener?(event: "data", listener: (chunk: string | Buffer) => void): void;
}

export interface TerminalOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): boolean;
  on?(event: "resize", listener: () => void): void;
  off?(event: "resize", listener: () => void): void;
  removeListener?(event: "resize", listener: () => void): void;
}

export interface OwnedChild {
  pid?: number;
  kill(signal?: string | number): boolean;
}

export type TerminalSessionOptions = {
  input: TerminalInput;
  output: TerminalOutput;
  registry?: ChildProcessRegistry;
  installSignalHandlers?: boolean;
};

const ALT_SCREEN_ON = "\u001b[?1049h";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const ESCAPE_FLUSH_MS = 35;

const KEY_ACTIONS: Readonly<Record<string, CliAction>> = {
  j: "down",
  k: "up",
  g: "top",
  G: "bottom",
  "\t": "nextPanel",
  "\u001b[Z": "previousPanel",
  "\r": "select",
  "\n": "select",
  " ": "pause",
  p: "play",
  n: "next",
  b: "previous",
  "+": "volumeUp",
  "=": "volumeUp",
  "-": "volumeDown",
  _: "volumeDown",
  "/": "search",
  m: "mode",
  r: "rescan",
  "?": "help",
  q: "quit",
  "\u0003": "quit",
  "\u001b": "back",
  a: "queue",
  s: "shuffle",
  x: "crossfade",
  i: "info",
  d: "diagnostics",
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "nextPanel",
  "\u001b[D": "previousPanel",
  "\u001b[H": "top",
  "\u001b[F": "bottom",
};

export function mapKey(key: string): CliAction {
  return KEY_ACTIONS[key] ?? "unknown";
}

/**
 * Incremental terminal key parser.
 *
 * Escape sequences can arrive split across reads, so incomplete CSI/SS3
 * prefixes stay buffered until the final byte arrives. A lone Escape is
 * flushed by the session after a short delay.
 */
export class KeyParser {
  private buffer = "";

  push(chunk: string | Buffer): string[] {
    this.buffer += chunk.toString();
    const keys: string[] = [];

    while (this.buffer.length > 0) {
      if (this.buffer[0] === "\u001b") {
        if (this.buffer.length === 1) break;
        if (this.buffer[1] === "[") {
          let index = 2;
          while (index < this.buffer.length) {
            const code = this.buffer.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e) break;
            index += 1;
          }
          if (index >= this.buffer.length) break;
          keys.push(this.buffer.slice(0, index + 1));
          this.buffer = this.buffer.slice(index + 1);
          continue;
        }
        if (this.buffer[1] === "O") {
          if (this.buffer.length < 3) break;
          keys.push(this.buffer.slice(0, 3));
          this.buffer = this.buffer.slice(3);
          continue;
        }
        keys.push("\u001b");
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const codePoint = this.buffer.codePointAt(0);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      keys.push(character);
      this.buffer = this.buffer.slice(character.length);
    }

    return keys;
  }

  hasPendingEscape(): boolean {
    return this.buffer === "\u001b";
  }

  flush(): string[] {
    if (this.buffer.length === 0) return [];
    const pending = this.buffer;
    this.buffer = "";
    return [pending];
  }
}

/**
 * Tracks only child processes started by Narada.
 *
 * The registry never discovers processes by name or PID, so an unrelated VLC
 * session is untouchable even when it is running at the same time.
 */
export class ChildProcessRegistry {
  private readonly children = new Set<OwnedChild>();

  register(child: OwnedChild): void {
    this.children.add(child);
  }

  unregister(child: OwnedChild): void {
    this.children.delete(child);
  }

  async terminateOwned(): Promise<void> {
    const owned = [...this.children];
    this.children.clear();
    for (const child of owned) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may already have exited; cleanup is best-effort.
      }
    }
  }
}

export class TerminalSession {
  private readonly input: TerminalInput;
  private readonly output: TerminalOutput;
  private readonly registry: ChildProcessRegistry;
  private readonly installSignalHandlers: boolean;
  private readonly parser = new KeyParser();
  private inputHandler: ((action: CliAction) => void) | undefined;
  private readonly resizeHandlers = new Set<() => void>();
  private readonly dataListener = (chunk: string | Buffer): void => this.handleData(chunk);
  private readonly resizeListener = (): void => {
    for (const handler of this.resizeHandlers) handler();
  };
  private readonly signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private closed = false;

  constructor(options: TerminalSessionOptions) {
    this.input = options.input;
    this.output = options.output;
    this.registry = options.registry ?? new ChildProcessRegistry();
    this.installSignalHandlers = options.installSignalHandlers ?? true;
  }

  isInteractive(): boolean {
    return Boolean(this.input.isTTY && this.output.isTTY);
  }

  start(): boolean {
    if (this.started) return true;
    if (!this.isInteractive()) return false;
    this.started = true;
    this.closed = false;
    this.input.setRawMode?.(true);
    this.input.resume?.();
    this.output.write(`${ALT_SCREEN_ON}${HIDE_CURSOR}${CLEAR_SCREEN}`);
    this.input.on("data", this.dataListener);
    this.output.on?.("resize", this.resizeListener);
    if (this.installSignalHandlers) this.installSignals();
    return true;
  }

  render(frame: string): void {
    if (!this.started) {
      this.output.write(`${frame}\n`);
      return;
    }
    this.output.write(frame);
  }

  writeRaw(text: string): void {
    this.output.write(text);
  }

  onInput(handler: (action: CliAction) => void): void {
    this.inputHandler = handler;
  }

  onResize(handler: () => void): void {
    this.resizeHandlers.add(handler);
  }

  size(): { columns: number; rows: number } {
    return {
      columns: this.output.columns ?? 80,
      rows: this.output.rows ?? 24,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
    this.input.off?.("data", this.dataListener);
    this.input.removeListener?.("data", this.dataListener);
    this.output.off?.("resize", this.resizeListener);
    this.output.removeListener?.("resize", this.resizeListener);
    for (const { signal, handler } of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers.length = 0;
    this.resizeHandlers.clear();
    this.inputHandler = undefined;
    if (this.started) {
      this.input.setRawMode?.(false);
      this.input.pause?.();
      this.output.write(`${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
      this.started = false;
    }
    void this.registry.terminateOwned();
  }

  private handleData(chunk: string | Buffer): void {
    const keys = this.parser.push(chunk);
    for (const key of keys) this.inputHandler?.(mapKey(key));
    if (this.parser.hasPendingEscape()) {
      if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined;
        for (const key of this.parser.flush()) this.inputHandler?.(mapKey(key));
      }, ESCAPE_FLUSH_MS);
      this.escapeTimer.unref?.();
    }
  }

  private installSignals(): void {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      const handler = (): void => {
        this.close();
        process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
      };
      process.on(signal, handler);
      this.signalHandlers.push({ signal, handler });
    }
  }
}
