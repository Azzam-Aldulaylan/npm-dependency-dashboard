/**
 * Bounded, deterministic file reading for workspace usage analysis.
 *
 * Files are read concurrently in small batches, then consumed in input order.
 * That keeps reference ordering stable and retains at most one batch of source
 * text at a time instead of an unbounded Promise.all over a large workspace.
 */

export const DEFAULT_USAGE_FILE_CONCURRENCY = 8;

export interface BoundedFileScanOptions<T> {
  items: readonly T[];
  read(item: T): Promise<string | null>;
  consume(item: T, text: string): void;
  concurrency?: number;
  isCancelled?: () => boolean;
  onProgress?: (processed: number, total: number) => void;
  onReadFailure?: (item: T) => void;
}

export interface BoundedFileScanResult {
  processed: number;
  cancelled: boolean;
}

export async function scanFilesBounded<T>(
  options: BoundedFileScanOptions<T>
): Promise<BoundedFileScanResult> {
  const requestedLimit = options.concurrency ?? DEFAULT_USAGE_FILE_CONCURRENCY;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.floor(requestedLimit))
    : DEFAULT_USAGE_FILE_CONCURRENCY;
  let processed = 0;

  for (let offset = 0; offset < options.items.length; offset += limit) {
    if (options.isCancelled?.() === true) return { processed, cancelled: true };

    const batch = options.items.slice(offset, offset + limit);
    const texts = await Promise.all(
      batch.map(async (item) => {
        try {
          return await options.read(item);
        } catch {
          // One unreadable file is the same degraded case as readTextFileCapped
          // returning null; it must not discard references from the rest.
          return null;
        }
      })
    );

    for (let index = 0; index < batch.length; index += 1) {
      if (options.isCancelled?.() === true) return { processed, cancelled: true };
      const item = batch[index];
      if (item === undefined) continue;
      const text = texts[index];
      if (text !== null && text !== undefined) options.consume(item, text);
      else options.onReadFailure?.(item);
      processed += 1;
      options.onProgress?.(processed, options.items.length);
    }
  }

  return { processed, cancelled: false };
}
