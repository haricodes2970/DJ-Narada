# Narada Web Migration Plan

Derived from `ADR-001-interface-platform.md` (accepted 2026-10-30).

Goal: a local radio station with a real UI, continuous rotation, real crossfade,
and a distinctive avatar. The terminal UI becomes a secondary mode.

## Non-negotiables

1. Audio only from the user's own files. No ripping, no streaming service capture.
2. The service binds to loopback only and requires a per-run token.
3. Never modify files under the library root. Read-only streaming.
4. `SeedheMauth` stays hash-verified after every milestone.
5. A milestone is done only when verified in a real browser, not only in tests.

## Architecture

```text
Browser (localhost)                         Node/TS service (127.0.0.1)
├─ Library / categories panel     HTTP+JSON  ├─ scanner + native helper (existing)
├─ Two decks (A/B) + Web Audio   ─────────▶  ├─ SQLite: stars, history, playlists (existing)
├─ Crossfade curves (GainNode)               ├─ radio scheduler (recommendations.ts)
├─ Avatar (Canvas/WebGL/Rive)                ├─ analysis cache (existing)
└─ Visualiser (AnalyserNode)      HTTP Range ├─ /api/audio streaming
```

Playback moves in-process. VLC is no longer used by the web UI. The CLI keeps VLC
until it is retired or re-pointed at the service.

## Phases

### Phase 1 — Local service (DONE, commit pending)

- `narada serve` starts the HTTP service on `127.0.0.1:7070` (override `NARADA_PORT`).
- Token in header or query; `/api/audio` accepts `Range` for seeking.
- Endpoints: `/api/health`, `/api/library`, `/api/tracks?category=`, `/api/audio`,
  `/api/stars`, `/api/refresh`.
- Stable database path: `$XDG_DATA_HOME/narada/narada.db`
  (default `~/.local/share/narada/narada.db`), independent of cwd.
- Non-music folders (`DJ`, `data`, `logs`, `node_modules`, `.git`) are excluded
  from categories.
- Verified against the real library: 33 tracks, 19 categories, `206` range response.

Acceptance (met): tests cover health, categories, range streaming, path traversal,
token auth, and star persistence.

### Phase 2 — Web UI skeleton

- Vite + React + TypeScript in `web/`.
- Library sidebar: starred first, count descending, alphabetical; `ALL TRACKS` last;
  0-track folders visible.
- Two-deck player: `<audio>` A/B, `GainNode` equal-power crossfade (3–8s).
- Queue panel, now playing, seek bar, keyboard shortcuts, mouse interaction.
- Media Session API for OS media keys.

Acceptance: click a category → it plays; star toggles persist; seek works; crossfade
is audible between two tracks; page reload keeps stars.

### Phase 3 — Radio brain

- Library-wide rotation, not folder-scoped.
- Cooldowns persisted in SQLite: track (~50 plays), artist (~12), album (~6).
- Weighted selection using BPM/energy/likes/skips (reuse `recommendations.ts`).
- Station presets: "Everything", "Seedhe Mauth Radio", "Late Night", "Focus".
- "Why this track?" line in the UI (recommendation explanation already exists).

Acceptance: 100-track simulation shows no repeat inside the cooldown window; artist
never repeats back-to-back; restart preserves rotation state.

### Phase 4 — Avatar and transitions

- Character avatar with idle/listening/beat states (Rive preferred, WebGL fallback).
- Audio-reactive motion driven by `AnalyserNode` (no fake random animation).
- Transition stingers/station IDs: royalty-free or self-generated; licence recorded
  in `assets/LICENSES.md`.
- Optional visual transition (sweep/glitch) synchronised with the crossfade.

Acceptance: avatar reacts to actual audio energy; stingers only fire inside a
crossfade and never clip the music.

### Phase 5 — Packaging

- PWA manifest + offline shell.
- Tauri wrapper for a real desktop icon and single-instance launch.
- Launcher script starts the service and opens the UI.
- Retire/redirect the old CLI desktop entry.

Acceptance: clean launch from the app icon, no terminal window required, service
shuts down with the app.

## Workspace layout

```text
DJ/
├─ src/            existing engine + CLI + server
├─ web/            new browser UI (Vite)
├─ assets/         avatar, stingers, transitions, LICENSES.md
├─ docs/           journal, ADRs, diagnosis, this plan
└─ tests/          node:test suites (engine, server)
```

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Browser blocks autoplay | One "Start radio" gesture; remember consent per session |
| Localhost exposure | Loopback bind, per-run token, no directory traversal, read-only |
| Crossfade timing drift | Schedule with `AudioContext.currentTime`, not `setTimeout` |
| Large library scan slow | SQLite-backed snapshot + background refresh |
| Avatar scope creep | Ship one expressive state machine, extend later |
| Two audio backends during transition | Web UI is Web Audio only; CLI stays VLC until retired |

## Immediate next actions

1. Scaffold `web/` (Vite + React + TS) and a dev proxy to the service.
2. Implement the library sidebar and two-deck crossfade.
3. Decide avatar medium (Rive vs custom WebGL) with a small prototype.
4. Locate the remaining music: current root holds 33 files; confirm whether more
   should be added to `~/Music` or a second root is needed.
