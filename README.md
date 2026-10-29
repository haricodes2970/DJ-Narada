# Narada DJ

Narada DJ is a planned terminal-native AI DJ and academic research project. Its intended experience combines music understanding, track-selection research, beat-aware transitions, a terminal interface, a pixel-art avatar, and a live visualizer.

## Phase 1 status

Phase 1 establishes project and library foundations only. It does **not** train models, prepare datasets, implement playback, or provide an operational DJ engine.

- No classifier has been trained or fine-tuned.
- No reinforcement-learning environment has been implemented or trained.
- No songs have been moved, downloaded, indexed, or imported.
- No personal music metadata or local database is stored in `data/`.

## Library organization

The personal music library lives outside this repository at:

```text
/home/hari007/Music
```

Broad storage categories are created directly under that path:

- `Kannada`, `Tamil`, `Telugu`, `Malayalam`
- `Hindi-Bollywood`, `Indian-Pop`
- `Hip-Hop`, `Western-Pop`, `Rock-Metal`, `Electronic`
- `Focus-Ambient`, `Classical-Folk`, `Soundtracks`, `Soul-Funk`, `Country`, `Other`

Existing folders are preserved. In particular, `/home/hari007/Music/SeedheMauth` remains untouched and is not part of this Git repository. Track-level language, genre, mood, artist, and use-case classification is planned for a future metadata layer rather than a deep folder hierarchy.

## Repository separation

Application source and Git metadata live only at:

```text
/home/hari007/Music/DJ
```

The parent music directory is not a Git repository. Personal audio formats, private metadata, local databases, downloads, model artifacts, and generated indexes are ignored by `.gitignore`.

## Development prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Python environment compatible with the selected research libraries; Python 3.14.8 is installed locally, but compatibility must be checked before adding ML dependencies
- Git 2.56 or newer

Phase 1 intentionally installs no dependencies. The current `package.json` describes the project and the TypeScript compiler configuration is retained in `tsconfig.json`; dependency installation will be introduced only with an approved implementation task.

## Planned milestones

1. Safe library structure and repository bootstrap.
2. Library discovery, metadata design, and deterministic in-memory catalog behavior.
3. Audio-feature extraction and classifier research prototype.
4. Simulated reinforcement-learning environment and baseline policies.
5. Local beat-aware mixing engine.
6. Terminal UI, avatar, visualizer, and end-to-end evaluation.

See [`docs/ACADEMIC_SCOPE.md`](docs/ACADEMIC_SCOPE.md) for research boundaries, proposed evaluation, licensing requirements, and non-goals.

## Safety rules

- Never stage `/home/hari007/Music` as a parent directory.
- Never force-add personal audio or private metadata.
- Do not move, rename, delete, overwrite, or modify existing music without an explicit approved milestone.
- Keep downloaded songs, model weights, checkpoints, generated indexes, datasets, and local databases outside published Git history unless explicitly approved and licensed.
