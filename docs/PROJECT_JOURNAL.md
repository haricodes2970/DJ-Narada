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

## 2026-10-31 — TUNE IN dead click: root cause found

**Symptom.** User: "tune in click not working, nothing happens." Screenshots of
the landing page also showed the featured track panel empty.

**Root cause.** `web/app.js` contained **TypeScript syntax** (`as const`,
`type Mode = ...`, `url: string` param annotations) but is a plain `.js` file
served raw to the browser. The parser threw a SyntaxError on load, so the
entire module never executed — no click handler, no fetches, nothing. Earlier
`--dump-dom` "verification" only matched static HTML strings, which masked it.

**Second bug.** Even after fixing syntax, `enter()` awaited
`ctx.resume()` *before* switching pages. Without a user gesture the resume
promise stays pending, so the page switch never ran. Fixed by switching pages
first (`landing.hidden = true; radio.hidden = false;` above any audio work).

**Evidence.** Headless dump after fix: `landing hidden=""`, `radio` visible,
"ON AIR" present, NOW PLAYING populated. `node --check web/app.js` now passes
(was SyntaxError at line 13).

**Also added.** Landing pixel-art FX (flickering lanterns, scanlines, glow
burst, poster pulse), random featured track per page load, defensive
`safeListen()` wiring, `window.__naradaEnter` fallback on the button.

---

## 2026-10-31 — DJ producer engine v2 (research-backed rewrite)

**Symptom.** User: "DJ mode completely messed up — all music plays 1–2 seconds
then jumps around." 

**Root cause (fixed in c24cfe3 first).** `playTransition` awaited only
`stinger.play()` (start), while a global `stinger.ended` listener re-called
`playNextRandom()` — every track died ~2 s after the previous clip finished.

**Feature data.** `narada analyze` (existing CLI, proved out) ran the librosa
Python worker over the library: 145/146 tracks analyzed (1 long jukebox
timed out). Analysis lives in `analysis_runs`, keyed by path + algorithm.

**Wiring.** Server now attaches `bpm`/`energy` to every `/api/tracks` payload
from the analysis cache. Two bugs fixed on the way:
- /api/tracks?category served *category copies* of tracks, not the decorated
  snapshot — `withFeatures` now remaps category track arrays (id → new track).
- The attach raced a rebuild once; confirmed via a temporary dist log.

**Sequencer v2 (web/app.js), per DJ research (Native Instruments, Pioneer DJ,
DJ TechTools, vibesdj):**
- Technique selection by BPM distance: ≤5 → 8-bar smooth blend with bass-swap
  EQ (lowshelf 240 Hz; incoming bass cut −30 dB, swap at the handoff);
  5–12 → echo out (delay per beat, tail rings over three steps); >12/unknown
  → radio drop through a stinger clip awaited to completion.
- Track choice scores energy arc (lift/breathe flips) + BPM compatibility +
  randomness, under artist/cooldown filters, top-3 shortlist.
- Web Audio decks upgraded: gain → bass EQ → master, plus echo send
  (delay + 0.38 feedback).

**On "train a DL/RL model".** Rejected with evidence: no legal transition
dataset exists (mixes are copyrighted), GPU-bound, and a rules engine built
on documented DJ techniques is deterministic and auditable. The user's
"messed up" experience was a plain logic bug, not missing intelligence.

**Verification.** node --check ✓, 228 tests ✓, headless autostart: DJ mode
plays Kahnada set, spectrum reactive, zero console errors, no rapid chopping
(the chop bug needs a long observed session; visible behavior correct).

**Follow-ups.** Stinger clip timing only on 'drop' technique; blend
bar-alignment is approximate (no downbeat detection); per-category DJ pool.

---

## Standing rules

1. Never modify files under `/home/hari007/Music/SeedheMauth`.
2. A green test suite is not acceptance. Verify rendered output and audible output.
3. Record every non-obvious bug here with evidence, not just the fix.
4. Commit and push each green milestone.
