#!/usr/bin/env python3
"""Narada audio analysis worker (Phase 3 scaffold).

Usage:
    python worker.py <audio-path>

Emits exactly one JSON object on stdout:

    {"ok": true, "features": {
        "durationSeconds": <float>,
        "sampleRate": <int>,
        "channels": <int>,
        "tempoBpm": <float>,
        "rmsEnergy": <float>,
        "spectralCentroidHz": <float>,
        "zeroCrossingRate": <float>
    }}

    {"ok": false, "error": "<message>"}

Exit code is 0 on success and 1 on failure. The worker is a deterministic,
metadata-only feature extractor: it never writes to the audio file and never
downloads data. It is intentionally a scaffold; it is not wired into the CLI.
"""

from __future__ import annotations

import json
import sys


def _emit_failure(message: str) -> int:
    print(json.dumps({"ok": False, "error": message}))
    return 1


def _analyze(path: str) -> dict:
    import librosa
    import numpy as np
    import soundfile as sf

    info = sf.info(path)
    samples, sample_rate = librosa.load(path, sr=22050, mono=True)
    if samples.size == 0:
        raise ValueError("audio file decoded to zero samples")

    tempo, _ = librosa.beat.beat_track(y=samples, sr=sample_rate)
    tempo_value = float(np.atleast_1d(tempo)[0])

    return {
        "durationSeconds": float(info.duration),
        "sampleRate": int(info.samplerate),
        "channels": int(info.channels),
        "tempoBpm": tempo_value,
        "rmsEnergy": float(np.mean(librosa.feature.rms(y=samples))),
        "spectralCentroidHz": float(np.mean(librosa.feature.spectral_centroid(y=samples, sr=sample_rate))),
        "zeroCrossingRate": float(np.mean(librosa.feature.zero_crossing_rate(y=samples))),
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        return _emit_failure("usage: worker.py <audio-path>")

    try:
        import librosa  # noqa: F401
        import numpy  # noqa: F401
        import soundfile  # noqa: F401
    except Exception as exc:  # pragma: no cover - environment dependent
        return _emit_failure(f"analysis dependencies unavailable: {exc}")

    try:
        features = _analyze(argv[1])
    except Exception as exc:
        return _emit_failure(f"analysis failed: {exc}")

    print(json.dumps({"ok": True, "features": features}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
