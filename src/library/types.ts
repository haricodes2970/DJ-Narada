export type ScanWarning = {
  path: string;
  message: string;
};

export type ScanOptions = {
  root: string;
  excludedRoots?: readonly string[];
  supportedExtensions?: ReadonlySet<string>;
};

export type ScanResult = {
  files: string[];
  warnings: ScanWarning[];
};

export type Track = {
  id: string;
  path: string;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  format?: string;
  contentHash?: string;
  bpm?: number;
  energy?: number;
  sizeBytes: number;
};

export type ProbeOptions = {
  executable?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type ProbeResult = {
  track?: Track;
  warning?: ScanWarning;
};
