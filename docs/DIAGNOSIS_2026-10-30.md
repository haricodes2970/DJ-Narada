# Narada Diagnosis — 2026-10-30

Status: analysis only, no fixes applied.
Scope: why the CLI feels broken despite green tests.

## Summary of findings

| # | Symptom reported | Verified? | Root cause | Severity |
|---|---|---|---|---|
| A | "zero tracks, zero everything" | Partially — not reproduced in 80x24 / 120x40 tmux | Startup selects an arbitrary non-`ALL TRACKS` category; if that category is empty (e.g. starred empty folder) the queue is empty. DB path is cwd-dependent, so stars differ per launch directory. | High |
| B | "clicks are not working" | Yes | Zero mouse handling in the codebase. The TUI is keyboard-only. | High |
| C | "app icon inside my library" | Yes | `data/` and `logs/` are real first-level folders and are listed as categories. Only `DJ/` is excluded, via a hard-coded path. | Medium |
| D | "I have more than 100 MP3 files" | No — the library has 33 | Only 33 audio files exist under `/home/hari007/Music`. The other ~232 are in `Projects`, `.vscode`, `.cache`, `Applications`, etc. | Critical (data) |
| E | "it plays all songs once, no radio feel" | Yes | Playback is a fixed queue that loops in the same order. Crossfade exists only as a manual `x` preview. No rotation, no weighted shuffle, no discovery. | High |
| F | "you did not download transition assets" | Yes | `assets/transitions`, `assets/sound-effects`, `assets/avatar` are empty directories. | High |
| G | Stars appear/disappear between runs | Yes | `resolveDatabasePath()` uses `path.resolve("data/narada.db")` → depends on cwd. Two DBs exist: `Music/DJ/data/narada.db` and `Music/data/narada.db`. | High |

## A. Zero tracks on startup

Evidence:

- `src/ui/console.ts` constructor:
  `const initialCategory = this.state.categories.find((c) => c.id !== "__all__") ?? ...`
  Because the sort puts starred folders first, the first non-`ALL TRACKS` category is
  often a starred folder. If that folder is empty, `queue = []` and every panel
  shows 0.
- `src/config/paths.ts`:
  `export const DEFAULT_DATABASE_PATH = path.resolve("data/narada.db");`
  Launch from `~/Music/DJ` → `DJ/data/narada.db`. Launch from `~/Music` →
  `Music/data/narada.db`. Star sets therefore differ per launch directory, which
  makes the "first category" differ per launch.
- Not reproduced at 80x24 or 120x40 with a clean DB. So this is state-dependent,
  not layout-dependent.

Additional contributing factor: a library with 33 tracks and 18 empty folders
looks "zero" even when it is correct.

## B. Mouse clicks

Evidence: `grep -rn "mouse|SGR|1006|1000h" src/` returns nothing. `TerminalSession`
only handles `data` events and maps key sequences in `src/cli/terminal.ts`.
A mouse click emits an escape sequence that the parser drops. Nothing happens by
design, not by bug.

## C. Non-music folders inside the library

`runConsole` does:

```ts
const entries = await fs.readdir(options.libraryRoot, { withFileTypes: true });
categoryFolders = entries.filter((e) => e.isDirectory() && e.name !== "DJ")
```

So `data/` (the SQLite directory) and `logs/` are shown as categories. The exclusion
list is a hard-coded absolute path in `src/library/scanner.ts`
(`DEFAULT_EXCLUDED_ROOT = "/home/hari007/Music/DJ"`), not a general rule.

The GNOME app-grid icon is the `.desktop` file created during this session:
`~/.local/share/applications/narada-dj.desktop` → `scripts/launch-narada.sh`.
It is a launcher, not library content.

## D. Missing music

Actual counts under `/home/hari007/Music`:

```text
SeedheMauth   19
TestAssets    14
DJ            22   (excluded from library scan)
everything else 0
total outside DJ: 33
```

Audio files elsewhere under `/home/hari007` (excluding `Music/DJ`):

```text
Projects 67 | .vscode 45 | .cache 43 | .local 35 | Music 33 | Applications 22 | Setup Guide 19
total 265
```

So the "100+ songs" exist, but they are not in the library root. No scanner change
can find them while the root stays `/home/hari007/Music`.

## E. Radio behaviour

`src/player/controller.ts` → `handleEnded()` calls `next()`; `next()` wraps with
`(index + 1) % queue.length`. Result: the same 19 tracks loop forever in the same
order. There is no:

- weighted/rotating selection across the whole library,
- artist/track cooldown that survives restarts,
- automatic crossfade during playback,
- loudness matching,
- transition stingers.

`src/mixing/crossfade.ts` is only reachable from the `x` key (`previewCrossfade`),
which renders an FFmpeg file. It is not part of the playback path.

## F. Assets

```text
assets/avatar/          empty
assets/sound-effects/   empty
assets/transitions/     empty
```

No asset has ever been downloaded into the project.

## G. Test confidence gap

The suite (222 tests) validates the harness, not the user's environment. Every
"verified" claim came from `tmux` with scripted keys and a fixed terminal size.
That is why green tests and a broken-feeling product coexisted. Two console tests
were also rewritten to match observed behaviour instead of the specification.

## What is actually solid

- Recursive scanner + native helper, 0 errors on the real tree.
- SQLite schema and migrations.
- Metadata probe, cover art, analysis cache.
- VLC backend with working `play` command (silent-audio bug fixed).
- Recommendations and history modules (scoring + persistence), not yet UI-wired.
- Folder categories, stars, and all-tracks aggregation (logic tested).

The engine is reusable. The terminal presentation layer is the weak part.
