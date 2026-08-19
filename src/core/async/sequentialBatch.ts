export interface SequentialBatchResult {
  completed: number;
  cancelled: boolean;
}

/**
 * Runs independent, potentially expensive checks one at a time. A failed
 * item is reported and does not prevent later items from settling; aborting
 * stops before the next item and does not count the interrupted item.
 */
export async function runSequentialBatch<T>(options: {
  items: readonly T[];
  signal: AbortSignal;
  onStart(item: T, completed: number, total: number): void;
  run(item: T, signal: AbortSignal): Promise<void>;
  onError(item: T, cause: unknown): void;
}): Promise<SequentialBatchResult> {
  let completed = 0;
  for (const item of options.items) {
    if (options.signal.aborted) break;
    options.onStart(item, completed, options.items.length);
    try {
      await options.run(item, options.signal);
    } catch (cause) {
      if (!options.signal.aborted) options.onError(item, cause);
    }
    if (options.signal.aborted) break;
    completed += 1;
  }
  return { completed, cancelled: options.signal.aborted };
}
