import type { Track } from "../library/types.js";
import { getModes } from "../library/modes.js";
import { createAvatarFrame, drawPixelGrid, type AvatarState } from "./avatar.js";
import { createProceduralCover } from "./cover.js";
import type { Layout } from "./layout.js";
import { inset, progressBar, type Rect, type ScreenBuffer } from "./screen.js";
import { currentTrack, selectedLibraryTrack, selectedQueueTrack, type ConsoleState } from "./state.js";
import type { Theme } from "./theme.js";

const SPECTRUM = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function width(value: string): number {
  return [...value].length;
}

export function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  const characters = [...value];
  if (characters.length <= max) return value;
  if (max === 1) return "…";
  return `${characters.slice(0, max - 1).join("")}…`;
}

function pad(value: string, max: number): string {
  const clipped = truncate(value, max);
  return clipped + " ".repeat(Math.max(0, max - width(clipped)));
}

function centered(value: string, max: number): string {
  const clipped = truncate(value, max);
  const left = Math.max(0, Math.floor((max - width(clipped)) / 2));
  return `${" ".repeat(left)}${clipped}`;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function trackDetails(track: Track | undefined): string {
  if (track === undefined) return "";
  return [track.artist, track.album].filter((value): value is string => value !== undefined && value.length > 0).join(" · ");
}

function modeLabel(modeId: string): string {
  if (modeId === "all") return "ALL TRACKS";
  return getModes().find((mode) => mode.id === modeId)?.name.toUpperCase() ?? modeId.toUpperCase();
}

function playbackLabel(state: ConsoleState): string {
  switch (state.playback) {
    case "playing":
      return "PLAYING";
    case "paused":
      return "PAUSED";
    case "loading":
      return "LOADING";
    case "error":
      return "ERROR";
    case "stopped":
      return "STOPPED";
  }
}

function playbackIcon(state: ConsoleState): string {
  switch (state.playback) {
    case "playing":
      return "▶";
    case "paused":
      return "⏸";
    case "loading":
      return "◌";
    case "error":
      return "!";
    case "stopped":
      return "■";
  }
}

function avatarState(state: ConsoleState): AvatarState {
  if (state.playback === "error") return "error";
  if (state.playback === "paused") return "paused";
  if (state.playback === "stopped") return "idle";
  if (state.transition > 0) return "mixing";
  return "playing";
}

export function renderHeader(screen: ScreenBuffer, layout: Layout, state: ConsoleState, theme: Theme): void {
  const rect = layout.header;
  screen.fill(rect.x, rect.y, rect.width, rect.height, " ", { bg: theme.panel });
  screen.text(1, rect.y, "◈ NARADA", { fg: theme.ember, bold: true });
  if (rect.width >= 46) screen.text(10, rect.y, "· terminal radio", { fg: theme.muted });

  const status = `${playbackIcon(state)} ${playbackLabel(state)}  ${state.bpm > 0 ? `${state.bpm} BPM` : ""}`.trim();
  const mode = `[ ${modeLabel(state.modeId)} ]`;
  const right = `${mode}  ${status}`;
  const rightX = rect.width - width(right) - 2;
  if (rightX > 24) {
    screen.text(rightX, rect.y, mode, { fg: theme.amber, bold: true });
    screen.text(rightX + width(mode) + 2, rect.y, `${playbackIcon(state)} ${playbackLabel(state)}`, {
      fg: state.playback === "playing" ? theme.mint : state.playback === "error" ? theme.red : theme.muted,
      bold: true,
    });
    if (state.bpm > 0 && rect.width > 110) {
      screen.text(rightX + width(mode) + 2 + width(`${playbackIcon(state)} ${playbackLabel(state)}`) + 2, rect.y, `${state.bpm} BPM`, {
        fg: theme.muted,
      });
    }
  }

  if (rect.height >= 2) {
    const library = `LIBRARY  ${state.libraryRoot}`;
    screen.text(1, rect.y + 1, truncate(library, rect.width - 20), { fg: theme.muted });
    if (state.demo) {
      const badge = " DEMO ";
      screen.text(rect.width - width(badge) - 1, rect.y + 1, badge, { fg: theme.bg, bg: theme.amber, bold: true });
    }
  }
  screen.hline(rect.x, rect.y + rect.height - 1, rect.width, "─", { fg: theme.border, bg: theme.panel });
}

export function renderLibrary(screen: ScreenBuffer, layout: Layout, state: ConsoleState, theme: Theme): void {
  if (!layout.showLibrary || layout.library.width < 8 || layout.library.height < 4) return;
  const rect = layout.library;
  screen.fill(rect.x, rect.y, rect.width, rect.height, " ", { bg: theme.bg });
  screen.box(rect, { fg: theme.border, bg: theme.bg }, "LIBRARY");
  const inner = inset(rect, 2, 1, 1, 1);
  if (inner.width < 4 || inner.height < 2) return;

  let y = inner.y;
  screen.text(inner.x, y, "CATEGORIES", { fg: theme.muted, bold: true });
  y += 1;
  const categoryLimit = Math.min(state.categories.length, Math.max(0, Math.floor(inner.height * 0.28)));
  for (let index = 0; index < categoryLimit && y < inner.y + inner.height - 4; index += 1) {
    const category = state.categories[index];
    const active = state.categoryIndex === index;
    const star = category.starred ? "★" : " ";
    const line = `${star} ${truncate(category.name, Math.max(4, inner.width - 10))} ${category.trackCount}`;
    if (active) {
      screen.fill(inner.x, y, inner.width, 1, " ", { bg: theme.panelAlt });
      screen.text(inner.x, y, pad(line, inner.width), { fg: theme.amber, bg: theme.panelAlt, bold: true });
    } else screen.text(inner.x, y, pad(line, inner.width), { fg: theme.text });
    y += 1;
  }
  y += 1;
  if (y < inner.y + inner.height - 4) {
    screen.text(inner.x, y, "MODES", { fg: theme.muted, bold: true });
    y += 1;
  }
  const modes = getModes();
  for (let index = 0; index < modes.length && y < inner.y + inner.height - 4; index += 1) {
    const mode = modes[index];
    const active = state.modeId === mode.id;
    const count = state.modeCounts[mode.id] ?? 0;
    const label = `${active ? "▸" : " "} ${truncate(mode.name, inner.width - 7)}`;
    const countText = String(count).padStart(3);
    const line = `${pad(label, inner.width - 4)}${countText}`;
    if (active) {
      screen.fill(inner.x, y, inner.width, 1, " ", { bg: theme.panelAlt });
      screen.text(inner.x, y, line, { fg: theme.ember, bg: theme.panelAlt, bold: true });
    } else {
      screen.text(inner.x, y, line, { fg: theme.text });
    }
    y += 1;
  }

  y += 1;
  if (y < inner.y + inner.height - 3) {
    screen.text(inner.x, y, `TRACKS ${state.filtered.length}`, { fg: theme.muted, bold: true });
    y += 1;
    const listHeight = Math.max(0, inner.y + inner.height - 2 - y);
    const start = Math.max(0, Math.min(state.libraryIndex - Math.floor(listHeight / 2), state.filtered.length - listHeight));
    for (let offset = 0; offset < listHeight; offset += 1) {
      const track = state.filtered[start + offset];
      if (track === undefined) break;
      const active = state.panel === "library" && start + offset === state.libraryIndex;
      const line = `${String(start + offset + 1).padStart(2)} ${truncate(track.title, inner.width - 3)}`;
      if (active) {
        screen.fill(inner.x, y, inner.width, 1, " ", { bg: theme.panelAlt });
        screen.text(inner.x, y, pad(line, inner.width), { fg: theme.amber, bg: theme.panelAlt, bold: true });
      } else {
        screen.text(inner.x, y, pad(line, inner.width), { fg: theme.text });
      }
      y += 1;
    }
  }

  const searchY = inner.y + inner.height - 1;
  screen.text(inner.x, searchY, truncate(`/${state.query}`, inner.width), { fg: state.query.length > 0 ? theme.mint : theme.muted });
}

export function renderNowPlaying(screen: ScreenBuffer, layout: Layout, state: ConsoleState, theme: Theme): void {
  const rect = layout.nowPlaying;
  if (rect.width < 10 || rect.height < 4) return;
  screen.fill(rect.x, rect.y, rect.width, rect.height, " ", { bg: theme.bg });
  const border = state.playback === "playing" ? theme.ember : state.playback === "error" ? theme.red : theme.border;
  screen.box(rect, { fg: border, bg: theme.bg }, state.transition > 0 ? "MIXING" : "ON AIR");
  const inner = inset(rect, 2, 1, 2, 1);
  if (inner.width < 8 || inner.height < 3) return;

  const track = currentTrack(state);
  if (track === undefined) {
    screen.text(inner.x, inner.y + Math.floor(inner.height / 2) - 1, centered("NO TRACK SELECTED", inner.width), { fg: theme.muted, bold: true });
    screen.text(inner.x, inner.y + Math.floor(inner.height / 2), centered("Press r to rescan · ? for help", inner.width), { fg: theme.muted });
    return;
  }

  const avatarHeight = Math.max(6, Math.min(layout.showAvatar ? 16 : 8, Math.floor(inner.height * 0.52)));
  const avatarWidth = Math.max(12, Math.min(32, avatarHeight * 2, inner.width - 2));
  const avatarX = inner.x + Math.max(0, Math.floor((inner.width - avatarWidth) / 2));
  const avatarY = inner.y;
  drawPixelGrid(
    screen,
    { x: avatarX, y: avatarY, width: avatarWidth, height: avatarHeight },
    createAvatarFrame({
      state: avatarState(state),
      tick: state.tick,
      energy: state.energy,
      beatPhase: state.beat,
      transitionProgress: state.transition,
    }),
    theme,
  );

  // A crisp terminal-text neon sign sits on top of the pixel frame. The
  // 3x5 pixel font is intentionally tiny; this keeps the name readable.
  const sign = "N A R A D A";
  if (avatarWidth >= width(sign) + 2) {
    screen.text(avatarX + Math.floor((avatarWidth - width(sign)) / 2), avatarY + 1, sign, {
      fg: theme.amber,
      bold: true,
    });
  }

  const infoY = avatarY + avatarHeight + 1;
  const hasInfo = infoY + 3 < inner.y + inner.height;
  if (hasInfo) {
    const coverHeight = Math.max(3, Math.min(8, Math.floor(inner.height * 0.2)));
    const coverWidth = Math.max(6, coverHeight * 2);
    const coverX = inner.x;
    drawPixelGrid(
      screen,
      { x: coverX, y: infoY, width: coverWidth, height: coverHeight },
      createProceduralCover(track, 16, 16),
      theme,
    );

    const textX = coverX + coverWidth + 2;
    const textWidth = Math.max(0, inner.x + inner.width - textX);
    if (textWidth > 4) {
      screen.text(textX, infoY, truncate(track.title, textWidth), { fg: theme.white, bold: true });
      screen.text(textX, infoY + 1, truncate(trackDetails(track), textWidth), { fg: theme.muted });
      const meta = `${state.bpm > 0 ? `${state.bpm} BPM` : ""}${state.bpm > 0 ? " · " : ""}${formatTime(state.duration)}`;
      screen.text(textX, infoY + 2, truncate(meta, textWidth), { fg: theme.amber });
    }
  }

  const progressY = inner.y + inner.height - 2;
  const barWidth = Math.max(4, inner.width - 12);
  const ratio = state.duration > 0 ? state.position / state.duration : 0;
  const bar = progressBar(ratio, barWidth);
  screen.text(inner.x, progressY, formatTime(state.position), { fg: theme.muted });
  screen.text(inner.x + 6, progressY, bar, { fg: theme.ember });
  screen.text(inner.x + 6 + barWidth + 1, progressY, formatTime(state.duration), { fg: theme.muted });

  if (inner.height >= 14) {
    const spectrumY = progressY - 2;
    const bars = Math.max(8, Math.min(24, Math.floor(inner.width / 2)));
    for (let index = 0; index < bars; index += 1) {
      const wave = Math.abs(Math.sin(state.tick / 5 + index * 0.7));
      const level = Math.max(0, Math.min(1, state.energy * 0.65 + wave * 0.35));
      const char = SPECTRUM[Math.min(SPECTRUM.length - 1, Math.floor(level * SPECTRUM.length))];
      const x = inner.x + index * 2;
      screen.text(x, spectrumY, char, { fg: index % 5 === 0 ? theme.amber : theme.ember });
    }
  }
}

export function renderQueue(screen: ScreenBuffer, layout: Layout, state: ConsoleState, theme: Theme): void {
  if (!layout.showQueue || layout.queue.width < 8 || layout.queue.height < 4) return;
  const rect = layout.queue;
  screen.fill(rect.x, rect.y, rect.width, rect.height, " ", { bg: theme.bg });
  screen.box(rect, { fg: theme.border, bg: theme.bg }, "QUEUE");
  const inner = inset(rect, 2, 1, 1, 1);
  if (inner.width < 4 || inner.height < 2) return;

  const now = currentTrack(state);
  screen.text(inner.x, inner.y, "NOW", { fg: theme.muted, bold: true });
  screen.text(inner.x, inner.y + 1, truncate(now?.title ?? "—", inner.width), { fg: theme.white, bold: true });
  screen.text(inner.x, inner.y + 2, truncate(trackDetails(now), inner.width), { fg: theme.muted });

  let y = inner.y + 4;
  screen.text(inner.x, y, "UP NEXT", { fg: theme.muted, bold: true });
  y += 1;
  const listHeight = Math.max(0, inner.y + inner.height - 5 - y);
  let drawn = 0;
  for (let offset = 1; offset < state.queue.length && drawn < listHeight; offset += 1) {
    const index = (state.queueIndex + offset) % state.queue.length;
    const track = state.queue[index];
    if (track === undefined) break;
    const active = state.panel === "queue" && index === state.queueSelection;
    const line = `${String(index + 1).padStart(2)} ${truncate(track.title, inner.width - 8)} ${formatTime(track.durationSeconds ?? 0)}`;
    if (active) {
      screen.fill(inner.x, y, inner.width, 1, " ", { bg: theme.panelAlt });
      screen.text(inner.x, y, pad(line, inner.width), { fg: theme.amber, bg: theme.panelAlt, bold: true });
    } else {
      screen.text(inner.x, y, pad(line, inner.width), { fg: theme.text });
    }
    y += 1;
    drawn += 1;
  }
  if (drawn === 0) screen.text(inner.x, y, "Queue is empty", { fg: theme.muted });

  const energyY = inner.y + inner.height - 2;
  const energyBar = progressBar(state.energy, Math.max(4, inner.width - 8), "█", "░");
  screen.text(inner.x, energyY, `ENERGY ${energyBar}`, { fg: theme.mint });
  screen.text(inner.x, energyY + 1, `${state.bpm > 0 ? `${state.bpm} BPM` : "NO BPM"} · ${state.queue.length} tracks`, { fg: theme.muted });
}

export function renderTransport(screen: ScreenBuffer, layout: Layout, state: ConsoleState, theme: Theme): void {
  const rect = layout.transport;
  if (rect.height <= 0) return;
  screen.fill(rect.x, rect.y, rect.width, rect.height, " ", { bg: theme.panel });
  screen.hline(rect.x, rect.y, rect.width, "─", { fg: theme.border, bg: theme.panel });

  const elapsed = formatTime(state.position);
  const total = formatTime(state.duration);
  const icon = playbackIcon(state);

  if (rect.height === 1) {
    const ratio = state.duration > 0 ? state.position / state.duration : 0;
    const barWidth = Math.max(6, Math.min(30, rect.width - 48));
    const bar = progressBar(ratio, barWidth);
    const line = `${icon} ${elapsed}/${total}  ${bar}  VOL ${state.volume}  ? help  q quit`;
    screen.text(1, rect.y, truncate(line, rect.width - 2), { fg: theme.text });
    return;
  }

  const status = `${icon} ${playbackLabel(state)}`;
  screen.text(1, rect.y + 1, status, {
    fg: state.playback === "playing" ? theme.mint : state.playback === "error" ? theme.red : theme.muted,
    bold: true,
  });
  let x = 1 + width(status) + 2;
  screen.text(x, rect.y + 1, modeLabel(state.modeId), { fg: theme.amber, bold: true });
  x += width(modeLabel(state.modeId)) + 2;
  if (state.bpm > 0) {
    screen.text(x, rect.y + 1, `${state.bpm} BPM`, { fg: theme.muted });
    x += width(`${state.bpm} BPM`) + 2;
  }
  screen.text(x, rect.y + 1, `VOL ${state.volume}`, { fg: theme.muted });

  const barWidth = Math.max(8, rect.width - 20);
  const ratio = state.duration > 0 ? state.position / state.duration : 0;
  screen.text(1, rect.y + 2, elapsed, { fg: theme.muted });
  screen.text(7, rect.y + 2, progressBar(ratio, barWidth), { fg: theme.ember });
  screen.text(7 + barWidth + 1, rect.y + 2, total, { fg: theme.muted });

  if (rect.height >= 4) {
    const hints = "space play/pause  n next  b prev  / search  m mode  ? help  q quit";
    screen.text(1, rect.y + 3, truncate(hints, rect.width - 2), { fg: theme.muted });
  }
}

export function renderStatus(screen: ScreenBuffer, layout: Layout, state: ConsoleState, theme: Theme): void {
  const rect = layout.status;
  screen.fill(rect.x, rect.y, rect.width, rect.height, " ", { bg: theme.panelAlt });
  const left = state.message.length > 0
    ? state.message
    : `${state.tracks.length} tracks · ${getModes().length} modes · ${state.demo ? "demo" : "local"} · ${state.warnings.length} warnings`;
  screen.text(1, rect.y, truncate(left, Math.max(0, rect.width - 24)), {
    fg: state.message.length > 0 ? theme.amber : theme.muted,
  });
  const right = "? help  q quit";
  if (rect.width > width(right) + 8) {
    screen.text(rect.width - width(right) - 1, rect.y, right, { fg: theme.muted });
  }
}

function overlayBox(screen: ScreenBuffer, layout: Layout, theme: Theme, title: string, desiredWidth: number, desiredHeight: number): Rect {
  const boxWidth = Math.max(20, Math.min(desiredWidth, layout.columns - 4));
  const boxHeight = Math.max(5, Math.min(desiredHeight, layout.rows - 4));
  const x = Math.floor((layout.columns - boxWidth) / 2);
  const y = Math.floor((layout.rows - boxHeight) / 2);
  const rect = { x, y, width: boxWidth, height: boxHeight };
  screen.fill(rect.x, rect.y, rect.width, rect.height, " ", { bg: theme.panelAlt });
  screen.box(rect, { fg: theme.amber, bg: theme.panelAlt }, title);
  return rect;
}

export function renderOverlay(screen: ScreenBuffer, layout: Layout, state: ConsoleState, theme: Theme): void {
  if (state.overlay === "none") return;

  if (state.overlay === "help") {
    const rect = overlayBox(screen, layout, theme, "KEYS", 64, 22);
    const inner = inset(rect, 2, 1, 2, 1);
    const lines = [
      ["j / k, ↑ / ↓", "move selection"],
      ["g / G", "jump to top / bottom"],
      ["Tab", "switch library / queue"],
      ["Enter", "play selected"],
      ["Space", "play / pause"],
      ["n / b", "next / previous"],
      ["+ / -", "volume"],
      ["/", "search"],
      ["m", "listening mode"],
      ["s", "shuffle"],
      ["x", "crossfade preview"],
      ["a", "focus queue"],
      ["i", "track info"],
      ["d", "diagnostics"],
      ["r", "rescan"],
      ["?", "this help"],
      ["q", "quit"],
    ];
    lines.forEach(([key, action], index) => {
      const y = inner.y + index;
      if (y >= inner.y + inner.height) return;
      screen.text(inner.x, y, pad(key, 14), { fg: theme.amber, bold: true });
      screen.text(inner.x + 15, y, truncate(action, inner.width - 15), { fg: theme.text });
    });
    screen.text(inner.x, inner.y + inner.height - 1, "Press any key to close", { fg: theme.muted });
    return;
  }

  if (state.overlay === "modes") {
    const modes = getModes();
    const rect = overlayBox(screen, layout, theme, "LISTENING MODE", 54, modes.length + 5);
    const inner = inset(rect, 2, 1, 2, 1);
    modes.forEach((mode, index) => {
      const y = inner.y + index;
      const active = index === state.overlayIndex;
      const line = `${active ? "▸" : " "} ${pad(mode.name, 14)} ${String(state.modeCounts[mode.id] ?? 0).padStart(4)} tracks`;
      if (active) {
        screen.fill(inner.x, y, inner.width, 1, " ", { bg: theme.panel });
        screen.text(inner.x, y, pad(line, inner.width), { fg: theme.ember, bg: theme.panel, bold: true });
      } else {
        screen.text(inner.x, y, line, { fg: theme.text });
      }
    });
    screen.text(inner.x, inner.y + inner.height - 1, "Enter apply · Esc cancel", { fg: theme.muted });
    return;
  }

  if (state.overlay === "search") {
    const rect = overlayBox(screen, layout, theme, "SEARCH", Math.min(72, layout.columns - 4), 4);
    const inner = inset(rect, 2, 1, 2, 1);
    screen.text(inner.x, inner.y, `/${state.searchDraft}█`, { fg: theme.mint, bold: true });
    screen.text(inner.x, inner.y + 1, "Enter apply · Esc cancel · title, artist, album, path", { fg: theme.muted });
    return;
  }

  if (state.overlay === "info") {
    const track = currentTrack(state);
    const rect = overlayBox(screen, layout, theme, "TRACK INFO", 62, 12);
    const inner = inset(rect, 2, 1, 2, 1);
    if (track === undefined) {
      screen.text(inner.x, inner.y, "No track selected", { fg: theme.muted });
      return;
    }
    const lines = [
      ["TITLE", track.title],
      ["ARTIST", track.artist ?? "—"],
      ["ALBUM", track.album ?? "—"],
      ["DURATION", formatTime(track.durationSeconds ?? 0)],
      ["FORMAT", track.format ?? "—"],
      ["SIZE", `${(track.sizeBytes / (1024 * 1024)).toFixed(1)} MB`],
      ["PATH", track.path],
    ];
    lines.forEach(([label, value], index) => {
      const y = inner.y + index;
      screen.text(inner.x, y, pad(label, 10), { fg: theme.muted, bold: true });
      screen.text(inner.x + 11, y, truncate(value, inner.width - 11), { fg: theme.text });
    });
    screen.text(inner.x, inner.y + inner.height - 1, "Press any key to close", { fg: theme.muted });
  }
}

export function renderScreen(
  screen: ScreenBuffer,
  layout: Layout,
  state: ConsoleState,
  theme: Theme,
): void {
  screen.clear({ bg: theme.bg });
  renderHeader(screen, layout, state, theme);
  renderLibrary(screen, layout, state, theme);
  renderNowPlaying(screen, layout, state, theme);
  renderQueue(screen, layout, state, theme);
  renderTransport(screen, layout, state, theme);
  renderStatus(screen, layout, state, theme);
  renderOverlay(screen, layout, state, theme);
}

export function librarySelectionLabel(state: ConsoleState): string {
  return selectedLibraryTrack(state)?.title ?? "—";
}

export function queueSelectionLabel(state: ConsoleState): string {
  return selectedQueueTrack(state)?.title ?? "—";
}
