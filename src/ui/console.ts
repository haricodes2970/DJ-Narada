import { TerminalSession, type CliAction } from "../cli/terminal.js";
import { PlaybackController } from "../player/controller.js";
import type { PlaybackState } from "../player/types.js";
import { VlcBackend } from "../player/vlcBackend.js";
import { buildCatalog, type CatalogResult } from "../library/catalog.js";
import { applyMode, getModes } from "../library/modes.js";
import { probeTrack } from "../library/metadata.js";
import { scanLibrary } from "../library/scanner.js";
import { searchTracks } from "../library/search.js";
import type { ScanWarning, Track } from "../library/types.js";
import { createAvatarFrame, drawPixelGrid } from "./avatar.js";
import { computeLayout } from "./layout.js";
import { diffFrames, ScreenBuffer, type Rect } from "./screen.js";
import {
  clampIndex,
  createConsoleState,
  currentTrack,
  selectedLibraryTrack,
  selectedQueueTrack,
  syntheticBpm,
  syntheticEnergy,
  type ConsoleState,
} from "./state.js";
import { EMBER_THEME, detectColorDepth, type ColorDepth, type Theme } from "./theme.js";
import { renderScreen } from "./views.js";

export type ConsoleCatalog = {
  tracks: Track[];
  warnings: ScanWarning[];
};

export type NaradaConsoleOptions = {
  terminal: TerminalSession;
  catalog: ConsoleCatalog;
  libraryRoot: string;
  demo?: boolean;
  theme?: Theme;
  depth?: ColorDepth;
  splashMs?: number;
  frameMs?: number;
  autoStartTimer?: boolean;
  playback?: PlaybackController;
};

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/**
 * The Narada terminal console.
 *
 * The console owns presentation state and a deterministic demo clock. A real
 * playback backend can be attached later without changing the rendering or
 * input layers.
 */
export class NaradaConsole {
  private readonly terminal: TerminalSession;
  private readonly catalog: ConsoleCatalog;
  private readonly libraryRoot: string;
  private readonly demo: boolean;
  private readonly theme: Theme;
  private readonly depth: ColorDepth;
  private readonly frameMs: number;
  private readonly splashMs: number;
  private readonly autoStartTimer: boolean;
  private readonly playback: PlaybackController | undefined;
  private readonly state: ConsoleState;
  private lastPlaybackIndex = -1;
  private previousRows: string[] | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private splashRemainingMs = 0;
  private quitResolve: (() => void) | undefined;
  private quitRequested = false;

  constructor(options: NaradaConsoleOptions) {
    this.terminal = options.terminal;
    this.catalog = options.catalog;
    this.libraryRoot = options.libraryRoot;
    this.demo = options.demo ?? false;
    this.theme = options.theme ?? EMBER_THEME;
    this.depth = options.depth ?? detectColorDepth(process.env, true);
    this.frameMs = options.frameMs ?? 90;
    this.splashMs = options.splashMs ?? 0;
    this.autoStartTimer = options.autoStartTimer ?? true;
    this.playback = options.playback;
    this.state = createConsoleState({
      libraryRoot: this.libraryRoot,
      tracks: this.catalog.tracks,
      warnings: this.catalog.warnings,
      demo: this.demo,
    });
    this.refreshModeCounts();
    this.selectFirstTrack();
    if (this.playback !== undefined) {
      this.state.volume = this.playback.getState().volume;
      this.state.playback = "stopped";
      this.playback.setQueue(this.state.queue, this.state.queueIndex);
    }
    if (this.splashMs > 0) {
      this.splashRemainingMs = this.splashMs;
      this.state.playback = "loading";
    }
  }

  getState(): Readonly<ConsoleState> {
    return this.state;
  }

  start(): boolean {
    if (this.started) return true;
    if (!this.terminal.start()) return false;
    this.started = true;
    this.terminal.onInput((action, key) => this.handleInput(action, key));
    this.terminal.onResize(() => this.render());
    this.render();
    if (this.autoStartTimer) {
      this.timer = setInterval(() => this.tick(), this.frameMs);
    }
    return true;
  }

  async run(): Promise<void> {
    if (!this.start()) return;
    if (this.quitRequested) return;
    await new Promise<void>((resolve) => {
      this.quitResolve = resolve;
    });
  }

  stop(): void {
    void this.playback?.close();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.quitRequested = true;
    this.terminal.close();
    this.quitResolve?.();
    this.quitResolve = undefined;
  }

  tick(): void {
    this.state.tick += 1;
    if (this.splashRemainingMs > 0) {
      this.splashRemainingMs = Math.max(0, this.splashRemainingMs - this.frameMs);
      if (this.splashRemainingMs === 0) {
        this.startPlaybackIfNeeded();
      }
    } else if (this.playback !== undefined) {
      this.syncPlaybackState();
      const active = this.state.playback === "playing";
      this.state.energy = active ? syntheticEnergy(currentTrack(this.state), this.state.tick) : Math.max(0.05, this.state.energy * 0.98);
      this.state.beat = active ? (this.state.tick % 8) / 8 : 0;
      if (active && this.state.transition > 0) {
        this.state.transition = Math.min(1, this.state.transition + 0.018);
        if (this.state.transition >= 1) this.state.transition = 0;
      }
    } else if (this.state.playback === "playing") {
      this.state.position += this.frameMs / 1000;
      this.state.energy = syntheticEnergy(currentTrack(this.state), this.state.tick);
      this.state.beat = (this.state.tick % 8) / 8;
      if (this.state.transition > 0) {
        this.state.transition = Math.min(1, this.state.transition + 0.018);
        if (this.state.transition >= 1) this.state.transition = 0;
      }
      if (this.state.duration > 0 && this.state.position >= this.state.duration) {
        this.nextTrack(1);
      }
    } else {
      this.state.energy = Math.max(0.05, this.state.energy * 0.98);
      this.state.beat = 0;
    }
    this.render();
  }

  dispatch(action: CliAction, key = ""): void {
    this.handleInput(action, key);
  }

  renderToString(): string {
    const layout = computeLayout(this.terminal.size().columns, this.terminal.size().rows);
    const screen = new ScreenBuffer(layout.columns, layout.rows);
    if (this.splashRemainingMs > 0) this.renderSplash(screen, layout);
    else renderScreen(screen, layout, this.state, this.theme);
    return screen.rows("none").join("\n");
  }

  render(): void {
    const layout = computeLayout(this.terminal.size().columns, this.terminal.size().rows);
    const screen = new ScreenBuffer(layout.columns, layout.rows);
    if (this.splashRemainingMs > 0) this.renderSplash(screen, layout);
    else renderScreen(screen, layout, this.state, this.theme);
    const rows = screen.rows(this.depth);
    const output = diffFrames(this.previousRows, rows, { synchronized: this.depth !== "none" });
    this.previousRows = rows;
    if (output.length > 0) this.terminal.render(output);
  }

  private renderSplash(screen: ScreenBuffer, layout: ReturnType<typeof computeLayout>): void {
    screen.clear({ bg: this.theme.bg });
    const avatarWidth = Math.min(32, Math.max(16, layout.columns - 8));
    const avatarHeight = Math.min(16, Math.max(8, Math.floor(layout.rows * 0.45)));
    const rect: Rect = {
      x: Math.floor((layout.columns - avatarWidth) / 2),
      y: Math.max(1, Math.floor((layout.rows - avatarHeight) / 2) - 2),
      width: avatarWidth,
      height: avatarHeight,
    };
    drawPixelGrid(
      screen,
      rect,
      createAvatarFrame({
        state: "boot",
        tick: this.state.tick,
        energy: 0.8,
        beatPhase: (this.state.tick % 8) / 8,
        transitionProgress: 0,
      }),
      this.theme,
    );
    const neon = "N A R A D A";
    if (rect.width >= neon.length + 2) {
      screen.text(rect.x + Math.floor((rect.width - neon.length) / 2), rect.y + 1, neon, {
        fg: this.theme.amber,
        bold: true,
      });
    }
    const title = "◈ TERMINAL RADIO";
    screen.text(
      Math.floor((layout.columns - title.length) / 2),
      Math.min(layout.rows - 4, rect.y + rect.height + 1),
      title,
      { fg: this.theme.ember, bold: true },
    );
    const subtitle = "COSMIC DJ SAGE · LOCAL LIBRARY";
    screen.text(
      Math.floor((layout.columns - subtitle.length) / 2),
      Math.min(layout.rows - 3, rect.y + rect.height + 2),
      subtitle,
      { fg: this.theme.muted },
    );
    const dots = ".".repeat((this.state.tick % 4) + 1);
    const boot = `TUNING THE COSMIC DECKS${dots}`;
    screen.text(
      Math.floor((layout.columns - boot.length) / 2),
      Math.min(layout.rows - 2, rect.y + rect.height + 3),
      boot,
      { fg: this.theme.amber },
    );
  }

  private refreshModeCounts(): void {
    this.state.modeCounts = { all: this.state.tracks.length };
    for (const mode of getModes()) {
      this.state.modeCounts[mode.id] = applyMode(mode.id, this.state.tracks).tracks.length;
    }
  }

  private selectFirstTrack(): void {
    const track = currentTrack(this.state);
    this.state.duration = track?.durationSeconds ?? 0;
    this.state.bpm = syntheticBpm(track);
    this.state.position = 0;
  }

  private handleInput(action: CliAction, key: string): void {
    if (this.splashRemainingMs > 0) {
      this.splashRemainingMs = 0;
      this.startPlaybackIfNeeded();
      this.render();
      return;
    }

    if (this.state.overlay === "search") {
      if (key === "\u0003") {
        this.stop();
        return;
      }
      if (key === "\u001b") {
        this.state.overlay = "none";
        this.state.searchDraft = this.state.query;
        this.state.message = "Search cancelled";
        this.render();
        return;
      }
      if (key === "\r" || key === "\n") {
        this.applySearch();
        return;
      }
      if (key === "\u007f" || key === "\b") {
        this.state.searchDraft = [...this.state.searchDraft].slice(0, -1).join("");
        this.render();
        return;
      }
      if (key.length === 1 && key >= " " && key !== "\u001b") {
        this.state.searchDraft += key;
        this.render();
      }
      return;
    }

    if (this.state.overlay === "modes") {
      if (action === "quit") {
        this.stop();
        return;
      }
      if (action === "back") {
        this.state.overlay = "none";
        this.render();
        return;
      }
      if (action === "down") this.state.overlayIndex = clampIndex(this.state.overlayIndex + 1, getModes().length);
      if (action === "up") this.state.overlayIndex = clampIndex(this.state.overlayIndex - 1, getModes().length);
      if (action === "top") this.state.overlayIndex = 0;
      if (action === "bottom") this.state.overlayIndex = getModes().length - 1;
      if (action === "select") this.applyMode(getModes()[this.state.overlayIndex].id);
      this.render();
      return;
    }

    if (this.state.overlay === "help" || this.state.overlay === "info") {
      if (action === "quit") {
        this.stop();
        return;
      }
      this.state.overlay = "none";
      this.render();
      return;
    }

    switch (action) {
      case "quit":
        this.stop();
        return;
      case "down":
        this.moveSelection(1);
        break;
      case "up":
        this.moveSelection(-1);
        break;
      case "top":
        if (this.state.panel === "library") this.state.libraryIndex = 0;
        else this.state.queueSelection = 0;
        break;
      case "bottom":
        if (this.state.panel === "library") this.state.libraryIndex = Math.max(0, this.state.filtered.length - 1);
        else this.state.queueSelection = Math.max(0, this.state.queue.length - 1);
        break;
      case "nextPanel":
      case "previousPanel":
        this.state.panel = this.state.panel === "library" ? "queue" : "library";
        break;
      case "select":
        this.playSelected();
        break;
      case "pause":
        this.togglePause();
        break;
      case "play":
        if (this.playback !== undefined) {
          if (this.state.playback === "paused") void this.playback.resume();
          else void this.playback.playIndex(this.state.queueIndex);
          this.syncPlaybackState();
        } else {
          this.state.playback = "playing";
        }
        break;
      case "next":
        this.nextTrack(1);
        break;
      case "previous":
        this.nextTrack(-1);
        break;
      case "volumeUp":
        this.state.volume = Math.min(100, this.state.volume + 5);
        void this.playback?.setVolume(this.state.volume);
        this.state.message = `Volume ${this.state.volume}`;
        break;
      case "volumeDown":
        this.state.volume = Math.max(0, this.state.volume - 5);
        void this.playback?.setVolume(this.state.volume);
        this.state.message = `Volume ${this.state.volume}`;
        break;
      case "search":
        this.state.overlay = "search";
        this.state.searchDraft = this.state.query;
        break;
      case "mode":
        this.state.overlay = "modes";
        this.state.overlayIndex = Math.max(0, getModes().findIndex((mode) => mode.id === this.state.modeId));
        break;
      case "rescan":
        this.state.message = "Restart the console to reload the library";
        break;
      case "help":
        this.state.overlay = "help";
        break;
      case "queue":
        this.state.panel = "queue";
        this.state.queueSelection = this.state.queueIndex;
        break;
      case "shuffle":
        this.shuffleQueue();
        break;
      case "crossfade":
        this.state.transition = 0.001;
        this.state.message = "Crossfade preview (synthetic)";
        break;
      case "info":
        this.state.overlay = "info";
        break;
      case "diagnostics":
        this.state.message = `${this.state.tracks.length} tracks · ${this.state.filtered.length} filtered · ${this.state.warnings.length} warnings · ${this.libraryRoot}`;
        break;
      case "back":
        this.state.overlay = "none";
        this.state.message = "";
        break;
      case "unknown":
        break;
    }
    this.render();
  }

  private moveSelection(delta: number): void {
    if (this.state.panel === "library") {
      this.state.libraryIndex = clampIndex(this.state.libraryIndex + delta, this.state.filtered.length);
    } else {
      this.state.queueSelection = clampIndex(this.state.queueSelection + delta, this.state.queue.length);
    }
  }

  private playSelected(): void {
    if (this.state.panel === "library") {
      const track = selectedLibraryTrack(this.state);
      if (track === undefined) return;
      this.state.queue = [...this.state.filtered];
      this.state.queueIndex = this.state.libraryIndex;
      this.state.queueSelection = this.state.queueIndex;
      if (this.playback !== undefined) {
        this.playback.setQueue(this.state.queue, this.state.queueIndex);
        void this.playback.playIndex(this.state.queueIndex);
        this.syncPlaybackState();
      } else {
        this.startTrack(track);
      }
    } else {
      const track = selectedQueueTrack(this.state);
      if (track === undefined) return;
      this.state.queueIndex = this.state.queueSelection;
      if (this.playback !== undefined) {
        void this.playback.playIndex(this.state.queueIndex);
        this.syncPlaybackState();
      } else {
        this.startTrack(track);
      }
    }
  }

  private startTrack(track: Track): void {
    this.state.position = 0;
    this.state.duration = track.durationSeconds ?? 0;
    this.state.bpm = syntheticBpm(track);
    this.state.energy = syntheticEnergy(track, this.state.tick);
    this.state.playback = "playing";
    this.state.message = `Playing ${track.title}`;
  }

  private togglePause(): void {
    if (this.playback !== undefined) {
      void this.playback.togglePause();
      this.syncPlaybackState();
      this.state.message = this.state.playback === "paused" ? "Paused" : "Resumed";
      return;
    }
    if (this.state.playback === "playing") {
      this.state.playback = "paused";
      this.state.message = "Paused";
    } else if (this.state.playback === "paused") {
      this.state.playback = "playing";
      this.state.message = "Resumed";
    } else {
      const track = currentTrack(this.state) ?? this.state.filtered[0];
      if (track !== undefined) {
        if (currentTrack(this.state) === undefined) this.state.queue = [...this.state.filtered];
        this.startTrack(track);
      }
    }
  }

  private nextTrack(delta: number): void {
    if (this.state.queue.length === 0) return;
    if (this.playback !== undefined) {
      void (delta > 0 ? this.playback.next() : this.playback.previous());
      this.syncPlaybackState();
      const track = currentTrack(this.state);
      this.state.message = `${delta > 0 ? "Next" : "Previous"}: ${track?.title ?? ""}`;
      return;
    }
    this.state.queueIndex = (this.state.queueIndex + delta + this.state.queue.length) % this.state.queue.length;
    const track = currentTrack(this.state);
    if (track === undefined) return;
    this.state.position = 0;
    this.state.duration = track.durationSeconds ?? 0;
    this.state.bpm = syntheticBpm(track);
    this.state.energy = syntheticEnergy(track, this.state.tick);
    this.state.playback = "playing";
    this.state.message = `${delta > 0 ? "Next" : "Previous"}: ${track.title}`;
  }

  private shuffleQueue(): void {
    if (this.state.filtered.length === 0) return;
    this.state.queue = shuffle(this.state.filtered, this.state.tick + 1);
    this.state.queueIndex = 0;
    this.state.queueSelection = 0;
    if (this.playback !== undefined) {
      this.playback.setQueue(this.state.queue, 0);
      void this.playback.playIndex(0);
      this.syncPlaybackState();
    } else {
      const track = currentTrack(this.state);
      if (track !== undefined) this.startTrack(track);
    }
    this.state.message = "Queue shuffled";
  }

  private applySearch(): void {
    this.state.query = this.state.searchDraft.trim();
    this.state.filtered = this.state.query.length > 0
      ? searchTracks(this.state.tracks, this.state.query)
      : [...this.state.tracks];
    this.state.libraryIndex = 0;
    this.state.overlay = "none";
    this.state.message = `Search: ${this.state.filtered.length} track(s)`;
  }

  private applyMode(modeId: string): void {
    const result = applyMode(modeId, this.state.tracks);
    this.state.modeId = modeId;
    this.state.filtered = result.tracks;
    this.state.libraryIndex = 0;
    this.state.queue = [...result.tracks];
    this.state.queueIndex = 0;
    this.state.queueSelection = 0;
    this.state.overlay = "none";
    this.state.position = 0;
    this.state.duration = this.state.queue[0]?.durationSeconds ?? 0;
    this.state.bpm = syntheticBpm(this.state.queue[0]);
    if (this.playback !== undefined) {
      this.playback.setQueue(this.state.queue, 0);
      if (this.state.queue.length > 0) void this.playback.playIndex(0);
      else void this.playback.stop();
      this.syncPlaybackState();
    } else {
      this.state.playback = this.state.queue.length > 0 ? "playing" : "stopped";
    }
    this.state.message = result.explanation;
  }

  private startPlaybackIfNeeded(): void {
    if (this.playback === undefined) {
      this.state.playback = this.state.tracks.length > 0 ? "playing" : "stopped";
      return;
    }
    if (this.state.queue.length === 0) {
      this.state.playback = "stopped";
      return;
    }
    this.playback.setQueue(this.state.queue, this.state.queueIndex);
    void this.playback.playIndex(this.state.queueIndex);
    this.syncPlaybackState();
  }

  private syncPlaybackState(): void {
    if (this.playback === undefined) return;
    const snapshot = this.playback.getState();
    if (snapshot.queue.length > 0) this.state.queue = snapshot.queue;
    if (snapshot.index >= 0) {
      if (snapshot.index !== this.lastPlaybackIndex) this.state.queueSelection = snapshot.index;
      this.lastPlaybackIndex = snapshot.index;
      this.state.queueIndex = snapshot.index;
    }
    this.state.playback = mapPlaybackStatus(snapshot.status);
    this.state.position = snapshot.positionSeconds;
    this.state.duration = snapshot.durationSeconds;
    this.state.volume = snapshot.volume;
    if (snapshot.error !== undefined) this.state.message = snapshot.error;
    this.state.bpm = syntheticBpm(snapshot.track ?? currentTrack(this.state));
  }
}

function mapPlaybackStatus(status: PlaybackState): ConsoleState["playback"] {
  if (status === "playing") return "playing";
  if (status === "paused") return "paused";
  if (status === "error") return "error";
  return "stopped";
}

export type RunConsoleOptions = {
  libraryRoot: string;
  demo?: boolean;
  terminal?: TerminalSession;
  catalog?: CatalogResult;
  stdout?: { isTTY?: boolean; write(chunk: string): unknown; columns?: number; rows?: number };
  stderr?: { write(chunk: string): unknown };
  env?: Record<string, string | undefined>;
  splashMs?: number;
  autoStartTimer?: boolean;
  playback?: PlaybackController;
  enablePlayback?: boolean;
  loadCatalog?: (root: string) => Promise<CatalogResult>;
};

export async function runConsole(options: RunConsoleOptions): Promise<number> {
  const terminal = options.terminal ?? new TerminalSession({
    input: process.stdin,
    output: process.stdout,
  });
  if (!terminal.isInteractive()) {
    options.stderr?.write("Narada console needs an interactive TTY. Use `narada scan` or `narada search`.\n");
    return 2;
  }

  const catalog = options.catalog ?? await (options.loadCatalog ?? (async (root: string) => {
    const scan = await scanLibrary({ root });
    return buildCatalog(scan, (filePath) => probeTrack(filePath));
  }))(options.libraryRoot);

  const shouldEnablePlayback = options.enablePlayback ?? !(options.demo ?? false);
  const environment = options.env ?? process.env;
  const playback = options.playback ?? (shouldEnablePlayback
    ? new PlaybackController({
      backend: new VlcBackend({ registry: terminal.getRegistry(), audioOutput: environment.NARADA_AOUT }),
    })
    : undefined);

  const console = new NaradaConsole({
    terminal,
    catalog,
    libraryRoot: options.libraryRoot,
    demo: options.demo ?? false,
    depth: detectColorDepth(options.env ?? process.env, true),
    splashMs: options.splashMs ?? 900,
    autoStartTimer: options.autoStartTimer ?? true,
    playback,
  });

  await console.run();
  await playback?.close();
  return 0;
}
