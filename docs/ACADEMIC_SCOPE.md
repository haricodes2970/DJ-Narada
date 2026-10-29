# Narada DJ Academic Scope

## Purpose and research question

Narada DJ is intended as an academic exploration of whether music-understanding representations and sequential decision-making can improve local DJ track selection and transition planning. The system is planned for terminal-native use: a user supplies an approved local library, observes recommendations and transition decisions, and eventually receives playback with an animated pixel-art avatar and visualizer.

This document describes hypotheses and evaluation plans, not completed experiments. Phase 1 contains no trained models, prepared datasets, playback engine, or operational DJ.

## Planned system boundaries

### Audio classifier

The planned classifier will estimate track-level and segment-level attributes useful for DJ decisions, such as genre family, language, mood, energy, tempo, beat/downbeat features, and structural descriptors. A research prototype may compare a pretrained audio representation with a smaller fine-tuned classifier. Model inputs, labels, augmentation, calibration, and class imbalance handling must be recorded before experimentation.

The classifier is an aid to analysis, not an authority on cultural or linguistic identity. Human review and uncertainty reporting are required for ambiguous predictions.

### Reinforcement-learning environment

The planned environment is a simulator, not a direct controller of a user's files. A state may include the currently playing track, candidate-track features, recent-history/novelty features, tempo and key compatibility, energy trajectory, transition constraints, and user/session preferences.

A discrete action may select a candidate track and transition style, with a no-op/continue action where appropriate. A reward proposal combines musical compatibility, continuity of energy and tempo, novelty, user preference signals, transition quality, and penalties for repetition, abruptness, invalid candidates, or unsafe operating conditions. Reward weights must be exposed and sensitivity-tested rather than treated as universal musical truth.

The first environment should be deterministic under a fixed seed, use synthetic or licensed feature fixtures, and separate training episodes from evaluation episodes. It must not require personal audio to be committed to Git.

### Local DJ engine

A later engine may use beat grids, phrase boundaries, tempo adjustment, gain control, crossfades, and transition effects. It must preserve an explicit preview/simulation mode before any live playback behavior. Audio decoding and DSP choices will be evaluated separately from policy learning.

### Terminal experience

A later terminal interface may expose library selection, analysis status, recommendations, transition plans, playback state, logs, avatar frames, and visualizer output. UI polish is not a Phase 1 objective.

## Baselines and evaluation

Planned comparisons include:

- random valid track selection;
- popularity or fixed-order selection, where an approved dataset supports it;
- nearest-neighbor selection by handcrafted audio features;
- greedy compatibility/energy heuristic;
- supervised classifier without RL policy optimization;
- RL policy variants against the same simulator and seed protocol.

Planned metrics include classifier macro-F1, balanced accuracy, per-class precision/recall, calibration error, and held-out robustness; recommendation hit rate or ranking metrics where labels exist; transition compatibility and invalid-action rate; energy/tempo continuity; repetition and novelty; episode return; user preference ratings; latency; and reproducibility across seeds. Metrics must be reported with dataset split, confidence intervals or variance where applicable, and known limitations.

No metric alone establishes that a mix is musically good. Human evaluation, ablations, and failure-case analysis are required.

## Dataset, licensing, and split policy

Every future dataset and audio source must have documented provenance, license, usage restrictions, and redistribution status. Personal library files are not automatically publishable research data. Dataset manifests should contain stable identifiers and permitted metadata rather than copying copyrighted audio into the repository.

Train, validation, and test sets must be separated before model selection. Splits must avoid artist, album, near-duplicate, and leakage overlap where the research question requires generalization. Feature extraction, normalization, and augmentation parameters must be fit only on training data. Test data remains untouched until final evaluation.

Model weights, generated datasets, indexes, and caches remain local or use an approved artifact store; they are not silently committed to this repository.

## Planned milestones

1. **Phase 1 — foundation:** safe folder structure, isolated Git repository, project configuration, scope documentation, and defensive ignore rules. This phase is the current boundary.
2. **Phase 2 — library discovery:** design opt-in scanning, metadata schema, provenance rules, and deterministic local indexes without publishing personal data.
3. **Phase 3 — audio understanding:** select licensed/public research data, establish feature and classifier baselines, and evaluate split discipline and uncertainty.
4. **Phase 4 — RL simulation:** implement a seeded environment, explicit state/action/reward interfaces, heuristic baselines, and offline evaluation.
5. **Phase 5 — DJ engine:** prototype beat-aware transition planning and preview playback with safety controls.
6. **Phase 6 — terminal product:** integrate CLI, avatar, visualizer, logging, performance checks, and user evaluation.

A milestone is not complete merely because code exists; it requires reproducible validation and a review of data and licensing assumptions.

## Phase 1 non-goals

- No model training, fine-tuning, inference service, or checkpoint creation.
- No dataset download, preparation, or licensing claim.
- No reinforcement-learning environment implementation or training.
- No audio decoding, beat tracking, mixing, or playback.
- No terminal UI, avatar animation, or visualizer implementation.
- No movement or modification of existing music.
- No personal music metadata, local database, generated index, virtual environment, or heavyweight dependency installation.
