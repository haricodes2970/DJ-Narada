import type { ProbeOptions, ProbeResult } from "./types.js";
import { probeTrackWithHelper } from "./metadata.internal.js";

export async function probeTrack(filePath: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  return probeTrackWithHelper(filePath, options, undefined);
}
