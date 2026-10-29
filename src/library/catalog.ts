import type { ProbeResult, ScanResult, ScanWarning, Track } from "./types.js";

export type ProbeFn = (filePath: string) => Promise<ProbeResult>;

export type CatalogResult = {
  tracks: Track[];
  warnings: ScanWarning[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build an in-memory catalog from a completed scan.
 *
 * Probes run concurrently but results are reassembled in scan order so the
 * catalog is deterministic regardless of subprocess completion timing. A
 * probe that rejects becomes a path-scoped warning instead of aborting the
 * catalog.
 */
export async function buildCatalog(scan: ScanResult, probe: ProbeFn): Promise<CatalogResult> {
  const probed = await Promise.all(
    scan.files.map(async (filePath): Promise<ProbeResult> => {
      try {
        return await probe(filePath);
      } catch (error) {
        return { warning: { path: filePath, message: `Unable to probe track: ${errorMessage(error)}` } };
      }
    }),
  );

  const tracks: Track[] = [];
  const seen = new Set<string>();
  const warnings: ScanWarning[] = [...scan.warnings];

  for (let index = 0; index < probed.length; index += 1) {
    const result = probed[index];
    if (result.track !== undefined && !seen.has(result.track.id)) {
      seen.add(result.track.id);
      tracks.push(result.track);
    }
    if (result.warning !== undefined) warnings.push(result.warning);
    if (result.track === undefined && result.warning === undefined) {
      warnings.push({ path: scan.files[index], message: "Probe returned neither a track nor a warning" });
    }
  }

  return { tracks, warnings };
}
