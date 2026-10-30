# Narada Project Journal

Living log. Newest entry first. Every entry: symptom → evidence → cause → action.

---

## 2026-10-30 — THE "zero tracks" bug: cwd-relative native helper

**Symptom.** Owner launches Narada from a normal terminal and sees 0 tracks,
0 queue, STOPPED. Reported three times.

**Reproduction.** `cd ~/Music && narada serve` →
`{"ok":true,"root":"/home/hari007/Music","tracks":0,"categories":19,"warnings":1}`.
`cd ~/Music/DJ && narada serve` → 33 tracks.

**Evidence.** `src/library/scanner.ts` used
`helper: path.resolve("dist/native/narada-scan")`. That path is relative to
`process.cwd()`. Outside the project directory the spawn fails, the scan returns
zero files, and the UI shows an empty library.

**Cause.** cwd-relative executable resolution, masked by every manual test that
started with `cd /home/hari007/Music/DJ`, including the desktop launcher.

**Action.** Resolve the helper from `import.meta.url`:

```ts
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCAN_HELPER = path.resolve(MODULE_DIR, "../../native/narada-scan");
helper: process.env.NARADA_SCAN_HELPER ?? DEFAULT_SCAN_HELPER,
```

Regression test `tests/library/scannerCwd.test.ts` scans from an unrelated cwd.

**Verified.** From `/home/hari007`: 33 tracks, 19 categories, 0 warnings; console
plays `101.mp3`. Library later grew to 35 tracks when the owner added 2 Kannada
songs.

**Lesson.** Never trust a test whose setup `cd`s into the project. Launch paths are
part of the product surface.

---

## 2026-10-30 — Platform diagnosis, product direction challenged

**Symptom.** Owner reports: launching Narada from a normal terminal shows zero
tracks / zero everything; mouse clicks do nothing; an app icon appears with the
launcher path; the 19-track folder plays straight through with no radio feel;
no transition assets were ever downloaded.

**Evidence.**

- No mouse handling exists anywhere in `src/` (grep for `mouse`, `SGR`, `1006`).
- Startup picks the first non-`ALL TRACKS` category, which can be an empty starred
  folder → empty queue → all panels at 0.
- DB path is cwd-relative (`path.resolve("data/narada.db")`); two DBs exist.
- `data/` and `logs/` are listed as categories; exclusion is a hard-coded `DJ` path.
- Only 33 audio files exist under `/home/hari007/Music`; ~232 more live elsewhere
  in the home directory.
- Queue end wraps with `% queue.length` → same N tracks loop in the same order.
- Crossfade only via the `x` preview key; not in the playback path.
- `assets/avatar`, `assets/sound-effects`, `assets/transitions` are empty.

**Cause.** Terminal UI is structurally the wrong medium for the avatar, mouse
interaction, and visual transitions; plus state/layout bugs and a library-root
mismatch.

**Action.** Wrote `docs/DIAGNOSIS_2026-10-30.md` and `docs/ADR-001-interface-platform.md`.
No code changes. Decision pending on CLI vs desktop vs local web.

---

## 2026-10-30 — Category UI still looked unchanged

**Symptom.** After categories were added, the screen still looked like the old UI.

**Cause.** The old four mood boxes (Hip-Hop / Desi / Workout / Deep Focus) were still
rendered in the main library panel and dominated it.

**Action.** Removed mode boxes from the main panel; categories became the primary
list; current track path displayed in the Now Playing panel. Commit `b444eb8`.

**Lesson.** "Tests pass" meant the harness passed, not that the product changed.
Verification must compare rendered output before/after, in the user's real terminal.

---

## 2026-10-30 — Stars did not persist reliably

**Symptom.** Starred folder appeared, then disappeared after relaunch.

**Cause.** Two independent problems: (1) migration was appended incorrectly at first;
(2) the database path depends on the current working directory, so different launch
directories read different databases.

**Action.** Migration fixed. cwd-dependent path still open — recorded in the diagnosis.

---

## 2026-10-30 — Categories wrong / empty folders missing

**Symptom.** Only folders containing tracks appeared; ordering did not match the
requested starred-first / count-descending / alphabetical rule.

**Cause.** Categories were derived only from tracks; filesystem folders were never
enumerated. Sort comparator also had `ALL TRACKS` pinned to the top.

**Action.** Merged filesystem folders with track buckets, added sort spec, appended
schema migration 3 (`category_stars`). Commit `1a25248`.

---

## 2026-10-30 — VLC played but no sound

**Symptom.** UI advanced, position moved, but audio was silent.

**Cause.** VLC launched with `--no-playlist-autostart`, and `play()` never sent the
RC `play` command.

**Action.** Send `play` after `load`. Verified with PipeWire (`Corked: no`) and by
checking VLC's reported input path. Commit `d3a7dfb`.

**Lesson.** "State says playing" is not evidence of audio. Always verify the sink.

---

## 2026-10-30 — Direct `--library /path` opened demo mode

**Symptom.** `narada --library /some/folder` showed synthetic content.

**Cause.** The flag set the root but did not switch the mode away from demo defaults.

**Action.** Direct folder invocation defaults to real console mode with playback.

---

## 2026-10-29 — Baseline test audio

**Symptom.** Risk of corrupting the only real music on disk.

**Action.** Captured SHA-256 baseline for all 19 Seedhe Mauth files and verify after
every milestone (`sha256sum -c`). Files are treated as read-only fixtures.

---

## Standing rules

1. Never modify files under `/home/hari007/Music/SeedheMauth`.
2. A green test suite is not acceptance. Verify rendered output and audible output.
3. Record every non-obvious bug here with evidence, not just the fix.
4. Commit and push each green milestone.
