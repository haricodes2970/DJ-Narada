export type AudioFeatures = {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  tempoBpm: number;
  rmsEnergy: number;
  spectralCentroidHz: number;
  zeroCrossingRate: number;
};

export type AudioProbeWarning = {
  path: string;
  message: string;
};

export type AudioProbeResult =
  | { ok: true; features: AudioFeatures }
  | { ok: false; warning: AudioProbeWarning };

export type AudioProbeOptions = {
  executable?: string;
  workerScript?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
};
