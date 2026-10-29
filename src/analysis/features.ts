import type { AudioFeatures } from "./types.js";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeAudioFeatures(value: unknown): AudioFeatures | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const durationSeconds = record.durationSeconds;
  const sampleRate = record.sampleRate;
  const channels = record.channels;
  const tempoBpm = record.tempoBpm;
  const rmsEnergy = record.rmsEnergy;
  const spectralCentroidHz = record.spectralCentroidHz;
  const zeroCrossingRate = record.zeroCrossingRate;
  if (
    !isFiniteNumber(durationSeconds) ||
    !isFiniteNumber(sampleRate) ||
    !isFiniteNumber(channels) ||
    !isFiniteNumber(tempoBpm) ||
    !isFiniteNumber(rmsEnergy) ||
    !isFiniteNumber(spectralCentroidHz) ||
    !isFiniteNumber(zeroCrossingRate)
  ) {
    return undefined;
  }
  return { durationSeconds, sampleRate, channels, tempoBpm, rmsEnergy, spectralCentroidHz, zeroCrossingRate };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** A stable 0..1 energy estimate from cached audio features. */
export function energyFromFeatures(features: AudioFeatures): number {
  const rms = clamp01(features.rmsEnergy);
  const centroid = clamp01(features.spectralCentroidHz / 8000);
  const zeroCrossing = clamp01(features.zeroCrossingRate * 4);
  return clamp01(0.12 + rms * 2.2 + centroid * 0.25 + zeroCrossing * 0.1);
}

export function bpmFromFeatures(features: AudioFeatures): number {
  if (!Number.isFinite(features.tempoBpm) || features.tempoBpm < 20 || features.tempoBpm > 300) return 0;
  return Math.round(features.tempoBpm);
}

/** Small deterministic pulse layered on top of the measured energy. */
export function liveEnergy(features: AudioFeatures, tick: number): number {
  const base = energyFromFeatures(features);
  const pulse = 0.88 + Math.abs(Math.sin(tick / 6)) * 0.12;
  return clamp01(base * pulse);
}
