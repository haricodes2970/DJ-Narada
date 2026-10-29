import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export type HashOptions = {
  algorithm?: string;
  signal?: AbortSignal;
};

/**
 * Stream a file through a content hash without loading it into memory.
 *
 * Hashing is deliberately separate from metadata probing so scans can skip
 * unchanged files and tests can replace it with a deterministic fixture.
 */
export function hashFile(filePath: string, options: HashOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(options.algorithm ?? "sha256");
    const stream = createReadStream(filePath);
    const abort = (): void => {
      stream.destroy(new Error("Hash aborted"));
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) => {
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    stream.on("end", () => {
      options.signal?.removeEventListener("abort", abort);
      resolve(hash.digest("hex"));
    });
  });
}
