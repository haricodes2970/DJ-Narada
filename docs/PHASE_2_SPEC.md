# Narada DJ Phase 2 Specification

## Status and boundary

Phase 2 builds the first working local prototype: a terminal CLI, read-only music-library scanner, search/browse behavior, and playback only if the verified VLC functional probe passes.

Phase 2 does **not** include machine-learning models, reinforcement learning, beat matching, BPM/key analysis, audio downloads, tag editing, persistent library indexes, live visualization, or an AI claim. Listening modes are deterministic metadata/path heuristics only.

## Product intent

Narada is a terminal-native local DJ for an approved music library. The user can inspect a library, search tracks, choose a transparent listening mode, and—after backend validation—control local playback. The application must remain useful when metadata is incomplete, tools are unavailable, input is non-interactive, or individual files are malformed.

Visual direction: dark terminal presentation with saffron/orange active accents, cyan playback state, compact status information, and restrained ASCII/pixel-inspired Narada identity. Visualizer behavior is out of scope.

## Runtime and dependencies

- Node.js 22 or newer.
- TypeScript with strict compiler settings.
- Built-in Node.js facilities for CLI input, subprocesses, paths, and tests where practical.
- ANSI terminal rendering; no Ink, React, Python Textual, or UI framework in Phase 2.
- Installed `ffprobe` subprocess for metadata extraction.
- VLC/cvlc as first playback candidate, behind an interface.
- No global npm packages, Python packages, system packages, or system configuration changes.
- Before installing the already-declared TypeScript dependency, inspect `package.json`, lockfile state, and proposed dependency changes. Use only the project-local dependency.
- Generate and commit `package-lock.json` with the approved local `npm install`; never commit `node_modules/` or unrelated dependencies.

Build and executable contract:

- `tsconfig.json` uses `rootDir: "."`, `outDir: "dist"`, strict compilation, and preserves predictable `dist/src/**/*.js` and `dist/tests/**/*.test.js` paths.
- `package.json` defines `build` as TypeScript compilation, `typecheck` as `tsc --noEmit`, `test` as build followed by Node's built-in test runner over compiled tests (for example, `node --test dist/tests/**/*.test.js`), `start` as `node dist/src/index.js`, and `dev` as the local development command without a TypeScript runtime dependency.
- `package.json` maps the local executable with `"bin": { "narada": "dist/src/index.js" }`.
- `src/index.ts` emits a `#!/usr/bin/env node` shebang in `dist/src/index.js`.
- Supported local invocations after `npm install` and `npm run build` are `node dist/src/index.js --help` and `./node_modules/.bin/narada --help`; no global installation is required.
- Targeted tests run against compiled paths or through a documented build-then-test helper; no TypeScript runtime loader is added.

## Filesystem and scanner safety

Default library root:

```text
/home/hari007/Music
```

The application repository is explicitly excluded:

```text
/home/hari007/Music/DJ
```

The root must be configurable for tests and future installations. Scanner requirements:

- Resolve canonical paths before comparing the library root and excluded repository path.
- Compare path components with path-boundary awareness, never string prefixes; `DJ` must not exclude a sibling such as `DJ-other`.
- If the canonical scan root equals the excluded DJ root or is inside it, return zero files with an actionable warning and a successful empty scan result; never scan the application subtree.
- Exclude the complete canonical DJ subtree, including symlink paths whose resolved target is inside it.
- Do not follow symbolic links by default, including symlinked directories and files; broken links produce warnings without aborting the scan.
- Discover supported audio extensions case-insensitively.
- Continue after unreadable directories, broken links, malformed files, or metadata failures.
- Return deterministic ordering.
- Deduplicate by canonical path; do not merge different files merely because metadata matches.
- Keep results in memory for Phase 2.
- The initial `Track.id` is the canonical absolute path, retained in memory only; identical canonical paths have identical IDs.
- Never write an index, cache, metadata file, database, or temporary output into the music library or `DJ/data`.
- Scanner implementation may use a checked-in Linux C helper compiled to ignored build output. No third-party runtime or build dependencies are permitted. If helper build or execution is unavailable, scanning fails with an explicit warning and never falls back to path-based traversal.
- A no-write guarantee includes no created, deleted, renamed, or modified fixture/library entries during a scan.
- Never move, rename, delete, rewrite tags, overwrite, or download music.

Supported formats include:

```text
mp3 flac wav m4a aac ogg opus wma aiff aif alac ape wv mka mp2 amr ac3 dts
mid midi caf 3gp 3g2 webm ra rm tta dsf dff
```

## Metadata contract

Metadata extraction uses `spawn`/`execFile` with argument arrays. File paths must never be interpolated into shell commands.

Probe command shape:

```text
ffprobe -v error -print_format json -show_format -show_streams <path>
```

Initial configurable engineering defaults (not universal optimal values) are:

- Timeout: 5 seconds per file.
- Maximum stdout: 1 MiB.
- Maximum stderr: 64 KiB.

Each probe must have:

- A strict timeout.
- A bounded stdout/stderr capture limit.
- Safe argument passing.
- Nonzero-exit and malformed-JSON handling.
- A warning associated with the affected path rather than whole-scan failure.
- Cleanup on timeout, spawn error, process close, and abort paths.
- If stdout or stderr exceeds its limit, stop accepting output, terminate only the owned `ffprobe` child, clear timers/listeners as appropriate, and return a bounded-output warning with fallback track metadata.

If `ffprobe` is missing, preserve the discovered path and filename/size fallback track, report an actionable warning, and distinguish individual-file failures from command-level failures. Individual probe failures do not make a scan command fail; root/configuration or command-level failures may produce a nonzero exit status.

Normalized track contract:

```ts
type Track = {
  id: string;
  path: string;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  format?: string;
  sizeBytes: number;
};
```

Fallbacks:

- Missing title: filename without extension.
- Missing artist or album: `undefined`.
- Invalid or absent duration: `undefined`.
- Probe failure: retain path, filename-derived title, file size, and warning.

## Search and listening modes

Search covers title, artist, album, filename, and path. It is case-insensitive, deterministic, and returns all tracks for an empty query. Results contain no duplicate track IDs.

Modes are defined separately from scanner and player modules:

- **Hip-Hop:** path/category and available metadata terms associated with hip-hop.
- **Desi:** Indian-language/category/path and available metadata terms.
- **Workout:** only transparent available metadata/category rules; no inferred energy or BPM.
- **Deep Focus:** ambient/classical/focus category and available metadata terms.

Mode rules use directory names and available metadata only. They must not infer mood, energy, BPM, language, or genre from audio that has not been measured. When metadata is insufficient, the CLI explains that filtering is limited. Every rule is deterministic and unit-tested.

Mode results use this contract:

```ts
type ModeResult = {
  modeId: string;
  tracks: Track[];
  matchedRuleCount: number;
  explanation: string;
  limited: boolean;
};
```

`limited` is true when available metadata/path evidence cannot meaningfully apply the requested mode.

## CLI contract

The executable entry point is `narada`. Required non-interactive commands:

```text
narada --help
narada scan
narada search "query"
narada --library /path scan
narada --library /path search "query"
```

Interactive mode provides navigation and these initial controls:

```text
q / Ctrl-C   quit
j / Down     move down
k / Up       move up
Enter        select
/            search
m            choose mode
p            play selected track
Space        pause/resume
n            next
b            previous
+ / -        volume
r            rescan
?            help
```

Reliability requirements:

- Detect non-TTY input and do not enter interactive mode unexpectedly.
- Return useful help, scan, and search output without a TTY.
- Restore terminal settings on normal exit, Ctrl-C, child-process failure, and unexpected errors.
- Track owned children through an idempotent registry:

```ts
interface ChildProcessRegistry {
  register(child: ChildProcess): void;
  unregister(child: ChildProcess): void;
  terminateOwned(): Promise<void>;
}
```

- `TerminalSession.close()` invokes the registry, is idempotent, and never terminates unrelated processes.
- Never terminate unrelated VLC sessions.
- Do not claim playback, visualization, AI classification, or other behavior until tested.

## Playback contract

Playback is conditional. Before implementation, perform a controlled VLC probe covering:

- VLC process startup.
- Loading a disposable/local test track.
- Play, pause, resume, and stop for the currently loaded track.
- Volume control.
- Paths containing spaces and Unicode.
- Process exit, cleanup, and unexpected termination.
- Ownership: only the VLC process started by the application may be cleaned up.
- Audible tests are environment-dependent and must be labeled as such.

If VLC control is unreliable, stop playback implementation and report evidence plus alternatives. Do not install another backend automatically.

Playback abstraction:

```ts
type PlaybackState = "idle" | "playing" | "paused" | "stopped" | "error";

interface PlaybackBackend {
  load(track: Track): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  setVolume(percent: number): Promise<void>;
  getState(): PlaybackState;
  close(): Promise<void>;
}
```

`PlaybackController` owns the queue, current index, `next()`, and `previous()` behavior. The backend controls only the currently selected track; it does not own application queue navigation. Controller queue tests use a fake backend. The controller delegates the backend process protocol and state transitions. States include `idle`, `playing`, `paused`, `stopped`, and `error`. Empty queues, missing tracks, invalid volume, process failure, and unavailable VLC must produce safe, actionable results.

## Proposed module boundaries

```text
src/
├── index.ts
├── cli/
│   ├── main.ts
│   ├── terminal.ts
│   ├── commands.ts
│   └── views.ts
├── library/
│   ├── types.ts
│   ├── scanner.ts
│   ├── metadata.ts
│   ├── search.ts
│   └── modes.ts
├── player/
│   ├── types.ts
│   ├── controller.ts
│   └── vlc-backend.ts
└── config/
    └── paths.ts
```

Tests use Node's built-in `node:test` and strict assertions. They use temporary fixtures and controlled subprocess doubles; they do not commit or modify personal audio.

## Non-goals

- No ML classifier, fine-tuning, inference, or model weights.
- No RL environment or policy training.
- No beat matching, BPM/key/phrase analysis, or transition effects.
- No persistent index, database, private metadata, or generated library cache.
- No audio downloads or tag writes.
- No live visualizer or production-grade avatar animation.
- No automatic dependency/system installation.
