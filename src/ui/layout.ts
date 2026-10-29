import type { Rect } from "./screen.js";

export type Layout = {
  columns: number;
  rows: number;
  header: Rect;
  library: Rect;
  nowPlaying: Rect;
  queue: Rect;
  transport: Rect;
  status: Rect;
  content: Rect;
  showLibrary: boolean;
  showQueue: boolean;
  showAvatar: boolean;
  compact: boolean;
};

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Breakpoint-driven layout.
 *
 * >=110 cols: library | now playing | queue
 *  80-109:    library | now playing (queue is an overlay)
 *  60-79:     now playing only
 *   <60:      compact single column
 */
export function computeLayout(columns: number, rows: number): Layout {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(rows));
  const compact = width < 60 || height < 20;
  const showLibrary = width >= 80 && !compact;
  const showQueue = width >= 110 && !compact;
  const showAvatar = width >= 60 && height >= 20;

  const headerHeight = height >= 30 ? 2 : 1;
  const statusHeight = 1;
  const transportHeight = compact ? 1 : 3;
  const contentY = headerHeight;
  const contentHeight = Math.max(1, height - headerHeight - transportHeight - statusHeight);

  const libraryWidth = showLibrary ? Math.min(30, Math.max(22, Math.floor(width * 0.22))) : 0;
  const queueWidth = showQueue ? Math.min(34, Math.max(26, Math.floor(width * 0.24))) : 0;
  const centerWidth = Math.max(1, width - libraryWidth - queueWidth);

  const library = showLibrary ? rect(0, contentY, libraryWidth, contentHeight) : rect(0, contentY, 0, 0);
  const nowPlaying = rect(libraryWidth, contentY, centerWidth, contentHeight);
  const queue = showQueue
    ? rect(libraryWidth + centerWidth, contentY, queueWidth, contentHeight)
    : rect(0, 0, 0, 0);

  return {
    columns: width,
    rows: height,
    header: rect(0, 0, width, headerHeight),
    library,
    nowPlaying,
    queue,
    transport: rect(0, contentY + contentHeight, width, transportHeight),
    status: rect(0, height - statusHeight, width, statusHeight),
    content: rect(0, contentY, width, contentHeight),
    showLibrary,
    showQueue,
    showAvatar,
    compact,
  };
}

export function centeredRect(outer: Rect, width: number, height: number): Rect {
  const x = outer.x + Math.max(0, Math.floor((outer.width - width) / 2));
  const y = outer.y + Math.max(0, Math.floor((outer.height - height) / 2));
  return rect(x, y, width, height);
}
