# Narada DJ Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested local Narada prototype with a reliable terminal CLI, read-only scanner/search, and VLC playback only after functional validation.

**Architecture:** Compose a CLI controller from independent library, mode, terminal, and player modules. Scan canonical filesystem paths in memory, extract metadata through bounded `ffprobe` subprocesses, and isolate VLC process control behind `PlaybackBackend`; no module writes to personal music or persistent indexes.

**Tech Stack:** Node.js 22, strict TypeScript, Node built-in `readline`/`child_process`/`node:test`, ANSI rendering, installed `ffprobe`, verified `cvlc` candidate.

**Spec:** `docs/PHASE_2_SPEC.md`

## Global Constraints

- Default library root is `/home/hari007/Music`.
- Exclude canonical `/home/hari007/Music/DJ` and do not follow symbolic links by default.
- Use `spawn`/`execFile` argument arrays; never construct shell commands from file paths.
- Apply strict probe timeouts and bounded output capture.
- Keep scan results in memory; never write an index, database, metadata, cache, or temporary file to the library or `DJ/data`.
- Preserve original audio read-only: no move, rename, delete, tag rewrite, overwrite, or download.
- Detect non-TTY input and provide useful non-interactive commands.
- Restore terminal state and clean up only child processes owned by Narada.
- Do not claim AI classification, beat matching, visualization, or playback until tested.
- Do not install global npm/Python/system packages or alter system configuration.
- Before installing TypeScript, inspect package/lockfile/dependency state; install only project-local declared dependency if approved.
- Generate and commit `package-lock.json` with approved `npm install`; never commit `node_modules/` or unrelated dependencies.
- Never stage audio, private metadata, secrets, databases, model artifacts, or downloaded media.
- Commit only after relevant tests pass; do not push without separate explicit approval.

## Review Focus

- Canonical path and symlink escape: scanner excludes DJ and does not traverse links (Task 3 test: nested DJ path and symlink fixture).
- Hostile or malformed metadata: bounded `ffprobe` invocation returns fallback track plus warning (Task 4 test: nonzero, malformed, oversized/timeout probe).
- Terminal lifecycle failure: raw-mode/settings and owned child cleanup run on Ctrl-C/errors (Task 6 tests: cleanup on signal/error).
- VLC ownership and path safety: spaces/Unicode work and unrelated VLC processes are untouched (Task 8 environment probe/tests).
- Private artifact leakage: build/runtime/audio/database files remain ignored and untracked (Task 2 and Task 9 validation).

---

### Task 1: Dependency and project command baseline

**Files:**
- Inspect: `package.json`, lockfile state, `.gitignore`, `tsconfig.json`
- Modify: `package.json`, `tsconfig.json`
- Generate: `package-lock.json` through approved local `npm install`

**Interfaces:**
- Consumes: Phase 1 package and strict TypeScript configuration.
- Produces: deterministic `typecheck`, `build`, `test`, `start`, and `dev` command contracts for later tasks; no entry-point implementation.

- [ ] **Step 1: Inspect dependency state**
  - Record whether `package-lock.json` exists, current `npm ls --depth=0`, and proposed dependency diff; do not install yet.

- [ ] **Step 2: Install only approved local dependency**
  - After explicit dependency approval, run `npm install` using existing `package.json`; generate `package-lock.json`, install no global/unrelated packages, and never commit `node_modules/`.

- [ ] **Step 3: Configure predictable TypeScript output**
  - Set `rootDir: "."`, `outDir: "dist"`, strict settings, and predictable `dist/src/**/*.js` and `dist/tests/**/*.test.js` output.

- [ ] **Step 4: Define package scripts and executable metadata**
  - Define `typecheck` as `tsc --noEmit`, `build` as TypeScript compilation, `test` as build followed by Node's built-in test runner over compiled tests, `start` as `node dist/src/index.js`, and `dev` as a build-then-run local command without a TypeScript runtime dependency.
  - Define `bin.narada` as `dist/src/index.js`; reserve the shebang and entry implementation for Task 7.

- [ ] **Step 5: Run configuration checks only**
  - Validate package JSON, lockfile consistency, script resolution, and TypeScript configuration. Do not require a source-entry smoke test or successful full build until Task 7 implements the entry point.

- [ ] **Step 6: Commit**
  ```bash
  git add package.json package-lock.json tsconfig.json
  git diff --cached --check
  git commit -m "chore: configure phase two development commands"
  ```

### Task 2: CLI argument and configuration contracts

**Files:**
- Create: `src/config/paths.ts`
- Create: `src/cli/commands.ts`
- Create: `tests/cli/commands.test.ts`

**Interfaces:**
- Produces `parseArgs(argv: readonly string[]): CliOptions` supporting `--help`, `scan`, `search <query>`, and `--library <path>`.
- Produces `resolveLibraryRoot(configured?: string): string` with default `/home/hari007/Music`.

- [ ] **Step 1: Write failing argument/config tests**
  - Assert help, scan, search query, configurable root, missing query, and unknown option behavior.

- [ ] **Step 2: Run targeted test and verify expected failure**
  - Run `npm run build`, then `node --test dist/tests/cli/commands.test.js`; expected failure because exports are absent.

- [ ] **Step 3: Implement minimal parser and path resolver**
  - Use no argument parser dependency; reject ambiguous/missing values with actionable errors.

- [ ] **Step 4: Run targeted and full tests**
  - Expected: parser tests pass and existing project suite remains green.

- [ ] **Step 5: Commit**
  ```bash
  git add src/config/paths.ts src/cli/commands.ts tests/cli/commands.test.ts
  git commit -m "feat: add narada command configuration"
  ```

### Task 3: Safe recursive audio discovery

**Files:**
- Create: `src/library/types.ts`
- Create: `src/library/scanner.ts`
- Create: `tests/library/scanner.test.ts`

**Interfaces:**
- Produces `scanLibrary(options: ScanOptions): Promise<ScanResult>`.
- `ScanOptions` includes `root: string`, optional `excludedRoots?: readonly string[]`, and optional supported extensions.
- `ScanResult` includes deterministic `files: string[]` and path-scoped `warnings: ScanWarning[]`.

- [ ] **Step 1: Write failing scanner tests**
  - Test supported extension discovery, case-insensitive suffixes, deterministic ordering, unsupported files, canonical DJ exclusion, exact root equality with DJ, descendant root inside DJ, prefix collision such as `DJ-other`, symlink non-traversal, symlink target resolving into DJ, unreadable-entry continuation, duplicate canonical path removal, canonical-path IDs, and duplicate canonical paths producing one result.
  - Snapshot fixture directory entries and file metadata before scanning; assert the complete snapshot is unchanged afterward, proving no-write behavior.

- [ ] **Step 2: Run scanner tests and verify expected failure**
  - Run `npm run build`, then `node --test dist/tests/library/scanner.test.js`; expected missing module/export failure.

- [ ] **Step 3: Implement scanner**
  - Use `fs.promises.opendir`/`lstat` or equivalent; canonicalize root/exclusions, avoid symlink traversal, catch per-entry errors, and never write files.

- [ ] **Step 4: Run targeted and full tests**
  - Expected: all scanner cases pass; no fixture escapes temporary root.

- [ ] **Step 5: Commit**
  ```bash
  git add src/library/types.ts src/library/scanner.ts tests/library/scanner.test.ts
  git commit -m "feat: add safe local audio discovery"
  ```

### Task 4: Bounded ffprobe metadata extraction

**Files:**
- Create: `src/library/metadata.ts`
- Create: `tests/library/metadata.test.ts`
- Modify: `src/library/types.ts`

**Interfaces:**
- Produces `probeTrack(filePath: string, options?: ProbeOptions): Promise<ProbeResult>`.
- `ProbeResult` contains a fallback-safe `track?: Track` and optional warning/error data.
- `ProbeOptions` defines executable, timeout milliseconds, and maximum stdout/stderr bytes.

- [ ] **Step 1: Write failing metadata tests**
  - Test valid JSON, missing tags, invalid duration, malformed JSON, nonzero exit, missing `ffprobe`, 5-second default timeout, configurable timeout, 1 MiB stdout limit, 64 KiB stderr limit, bounded-output child termination, cleanup on timeout/spawn error/close/abort, paths with spaces/Unicode, canonical absolute IDs, and argument-array invocation.

- [ ] **Step 2: Run metadata tests and verify expected failure**
  - Run `npm run build`, then `node --test dist/tests/library/metadata.test.js`; expected missing module/export failure.

- [ ] **Step 3: Implement bounded subprocess probe**
  - Use `execFile` or `spawn` without a shell, enforce timeout/output limits, normalize format/tags/duration/size, and derive title from basename.

- [ ] **Step 4: Run targeted and full tests**
  - Expected: malformed or unavailable probes return warnings and do not abort caller scan.

- [ ] **Step 5: Commit**
  ```bash
  git add src/library/types.ts src/library/metadata.ts tests/library/metadata.test.ts
  git commit -m "feat: extract resilient audio metadata"
  ```

### Task 5: In-memory catalog, search, and deterministic modes

**Files:**
- Create: `src/library/catalog.ts`
- Create: `src/library/search.ts`
- Create: `src/library/modes.ts`
- Create: `tests/library/search.test.ts`
- Create: `tests/library/modes.test.ts`

**Interfaces:**
- Produces `buildCatalog(scan: ScanResult, probe: ProbeFn): Promise<CatalogResult>`.
- Produces `searchTracks(tracks: readonly Track[], query: string): Track[]`.
- Produces `getModes(): readonly ListeningMode[]` and `applyMode(modeId: string, tracks: readonly Track[]): ModeResult`.
- `ModeResult` is `{ modeId: string; tracks: Track[]; matchedRuleCount: number; explanation: string; limited: boolean }`.

- [ ] **Step 1: Write failing catalog/search/mode tests**
  - Test warning retention, title/artist/album/path matching, case-insensitivity, empty query, stable ordering, duplicate IDs, all four modes, metadata/path-only rules, and insufficient-metadata explanation.

- [ ] **Step 2: Run targeted tests and verify expected failure**
  - Run `npm run build`, then `node --test dist/tests/library/search.test.js dist/tests/library/modes.test.js`; expected missing exports.

- [ ] **Step 3: Implement catalog/search/modes**
  - Keep results in memory; never persist generated metadata. Modes must not infer energy, BPM, mood, or language beyond explicit metadata/path terms.

- [ ] **Step 4: Run targeted and full tests**
  - Expected: deterministic result sets and transparent mode explanations.

- [ ] **Step 5: Commit**
  ```bash
  git add src/library/catalog.ts src/library/search.ts src/library/modes.ts tests/library/search.test.ts tests/library/modes.test.ts
  git commit -m "feat: add searchable in-memory music catalog"
  ```

### Task 6: Terminal renderer and lifecycle-safe interactive shell

**Files:**
- Create: `src/cli/terminal.ts`
- Create: `src/cli/views.ts`
- Create: `src/cli/interactive.ts`
- Create: `tests/cli/terminal.test.ts`
- Create: `tests/cli/interactive.test.ts`

**Interfaces:**
- Produces `TerminalSession` with `start()`, `render(view)`, `onInput(handler)`, and idempotent `close()`.
- Produces `ChildProcessRegistry` with `register(child)`, `unregister(child)`, and `terminateOwned()`; cleanup operates only on registered Narada children.
- Produces `mapKey(input: string): CliAction` for navigation, search, mode, playback, rescan, help, and quit.

- [ ] **Step 1: Write failing terminal tests**
  - Test ANSI rendering, key mapping, non-TTY no-interactive behavior, terminal restoration on normal close/error/SIGINT, idempotent close, and registry cleanup using fake child handles while proving unrelated handles are untouched.

- [ ] **Step 2: Run targeted tests and verify expected failure**
  - Run `npm run build`, then `node --test dist/tests/cli/terminal.test.js dist/tests/cli/interactive.test.js`; expected missing exports.

- [ ] **Step 3: Implement minimal ANSI terminal session**
  - Use built-in streams/readline/raw mode only when TTY; install cleanup handlers once and make cleanup idempotent.

- [ ] **Step 4: Implement views and visual direction**
  - Render help, library list, selected track, current mode, warnings, and playback placeholder/state without claiming unsupported capabilities.

- [ ] **Step 5: Run targeted and full tests**
  - Expected: lifecycle tests prove terminal restoration and no unexpected interactive entry in non-TTY contexts.

- [ ] **Step 6: Commit**
  ```bash
  git add src/cli/terminal.ts src/cli/views.ts src/cli/interactive.ts tests/cli/terminal.test.ts tests/cli/interactive.test.ts
  git commit -m "feat: add reliable terminal interaction shell"
  ```

### Task 7: Wire non-interactive CLI commands and documentation

**Files:**
- Create/modify: `src/cli/main.ts`, `src/index.ts`
- Create: `tests/cli/main.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces executable behavior for `narada --help`, `narada scan`, `narada search "query"`, and `--library <path>`.
- Consumes parser, scanner, metadata, catalog, search, modes, and terminal interfaces from Tasks 2–6.

- [ ] **Step 1: Write failing CLI integration tests**
  - Assert help output, scan output, search output, configurable fixture root, graceful missing executable, non-TTY behavior, compiled `dist/src/index.js` shebang, `package.json` `bin.narada` mapping, and local invocations through `node dist/src/index.js` and `./node_modules/.bin/narada`.

- [ ] **Step 2: Run targeted tests and verify expected failure**
  - Run `npm run build`, then `node --test dist/tests/cli/main.test.js`; expected missing entry behavior.

- [ ] **Step 3: Implement composition and command output**
  - Use dependency injection for scanner/probe/streams so tests do not scan personal library or invoke real playback.

- [ ] **Step 4: Document commands and limitations**
  - Add development commands, scanner safety, supported formats, metadata fallback, mode semantics, and explicit no-AI/no-index/no-playback-until-validation statements.

- [ ] **Step 5: Run full suite and manual fixture smoke tests**
  - Run `npm test`, `npm run typecheck`, and `npm run build`; manually run CLI against a temporary fixture root.

- [ ] **Step 6: Commit**
  ```bash
  git add src/index.ts src/cli/main.ts tests/cli/main.test.ts README.md package.json tsconfig.json package-lock.json
  git commit -m "feat: expose narada scan and search commands"
  ```

### Task 8: Validate VLC candidate before playback implementation

**Files:**
- Create: `src/player/types.ts` only for approved interface definitions
- Create: `tests/player/vlc-probe.test.ts`
- Create temporary disposable fixtures outside the repository; do not commit audio.

**Interfaces:**
- Produces a probe report, not assumed playback support.
- If successful, defines the verified command/control behavior consumed by Task 9.

- [ ] **Step 1: Inspect VLC command/control behavior**
  - Confirm executable path/version and choose an owned process invocation with an isolated RC endpoint.

- [ ] **Step 2: Write failing capability probe/test**
  - Test startup, load, play/pause/resume/stop, volume, exit/cleanup, spaces/Unicode, and unrelated-process ownership; do not test queue `next`/`previous` here because the controller owns those semantics. Mark audible checks environment-dependent.

- [ ] **Step 3: Run controlled probe**
  - Use a disposable fixture or approved local test track; capture exact failures. Do not terminate unrelated VLC processes.

- [ ] **Step 4: Decision gate**
  - If controls pass, continue to Task 9. If unreliable, stop playback work and document alternatives; do not install another backend.

- [ ] **Step 5: Commit only verified interface/probe tests**
  ```bash
  git add src/player/types.ts tests/player/vlc-probe.test.ts
  git commit -m "test: validate VLC playback control candidate"
  ```
  - Skip this commit if the probe fails and no meaningful reusable interface/test remains.

### Task 9: Playback controller and verified VLC backend

**Files:**
- Create: `src/player/controller.ts`
- Create: `src/player/vlc-backend.ts`
- Create: `tests/player/controller.test.ts`
- Create: `tests/player/vlc-backend.test.ts`
- Modify: `src/cli/interactive.ts`, `src/cli/views.ts`

**Interfaces:**
- Implements `PlaybackBackend` from `docs/PHASE_2_SPEC.md`.
- Produces `PlaybackController` with queue/index/state operations and owned-process cleanup.

- [ ] **Step 1: Write failing controller tests**
  - Use a fake backend and test queue loading, controller-owned next/previous boundaries, play/pause/resume, volume clamping, empty queue, missing track, backend errors, and idempotent close.

- [ ] **Step 2: Run controller tests and verify expected failure**
  - Run `npm run build`, then `node --test dist/tests/player/controller.test.js`; expected missing implementation.

- [ ] **Step 3: Implement controller against backend interface**
  - Keep queue policy independent from VLC process details; never shell-interpolate paths.

- [ ] **Step 4: Write failing backend integration tests**
  - Test verified VLC command protocol, spaces/Unicode, owned process cleanup, and unavailable backend errors.

- [ ] **Step 5: Implement VLC backend**
  - Use only the validated invocation/control protocol from Task 8; close only the process handle created by the backend.

- [ ] **Step 6: Run unit suite and environment-dependent playback tests**
  - Expected: controller suite passes; audible tests report explicit pass/skip/failure based on environment.

- [ ] **Step 7: Wire controls into interactive CLI and document status**
  - Only expose controls proven by Task 8; document backend limitations.

- [ ] **Step 8: Commit**
  ```bash
  git add src/player src/cli/interactive.ts src/cli/views.ts tests/player
  git commit -m "feat: add verified local playback controls"
  ```

### Task 10: Final Phase 2 safety validation and release report

**Files:**
- Modify: `README.md` or `docs/PHASE_2_SPEC.md` only for verified final status.
- No generated runtime files committed.

**Interfaces:**
- Consumes all prototype modules and tests.
- Produces validation evidence and proposed push command; never pushes.

- [ ] **Step 1: Run full verification**
  - Run `npm test`, `npm run typecheck`, `npm run build`, CLI fixture smoke tests, `.gitignore` checks, and repository status checks.

- [ ] **Step 2: Scan tracked content**
  - Confirm no audio, secrets, private metadata, databases, model artifacts, downloaded media, generated index, or runtime cache is tracked.

- [ ] **Step 3: Verify music preservation**
  - Recount and hash the 19 `SeedheMauth` MP3 files; compare with the established baseline.

- [ ] **Step 4: Review commits**
  - Inspect each Phase 2 commit and staged list; ensure small meaningful boundaries and no amended/re-written history.

- [ ] **Step 5: Present approval report**
  - Report tests, tool/dependency state, scanner/playback limitations, commit hashes, exact file inventory, clean status, and proposed command:
    ```bash
    git -C /home/hari007/Music/DJ push origin main
    ```
  - Stop for explicit push approval.

## Acceptance criteria

Phase 2 is ready for review when:

- `narada --help`, `narada scan`, `narada search "query"`, and configurable-root forms work locally.
- Interactive mode works only in a TTY and restores terminal state on every exit path.
- Scanner recursively discovers supported formats, excludes canonical DJ, avoids symlink traversal, deduplicates paths, and survives errors.
- Metadata extraction uses bounded, timed, argument-safe `ffprobe` calls with fallbacks.
- Search and four deterministic listening modes are unit-tested and transparent about missing metadata.
- Playback is exposed only if the VLC capability probe passes; otherwise blocker and alternatives are documented.
- No personal music, private metadata, local database, generated index, secret, model artifact, or downloaded media is tracked.
- Existing audio remains read-only and unchanged.
- Full tests, strict typecheck, build, and safety validation pass.
- Push is not performed without a separate explicit approval.

## Self-review notes

- Spec requirements map to Tasks 1–10.
- Scanner, metadata, CLI lifecycle, playback ownership, dependency policy, and Git safety each have explicit tests or validation gates.
- Task 8 intentionally separates backend investigation from implementation; playback is conditional rather than assumed.
- Empty directories remain local-only; no placeholders are planned.
- Phase 2 remains bounded to CLI, scanner, search, and conditional playback; academic ML/RL scope remains future work.
