/**
 * Concurrency-limited work pool.
 *
 * Two properties make this worth ~60 lines instead of a dependency:
 *
 *  1. It never rejects. Every task is wrapped, and failures come back as
 *     per-item results. That is what makes "one bad package must not break the
 *     whole table" a structural guarantee rather than a code-review habit — a
 *     single 404 cannot reject the batch because there is no rejection path.
 *  2. `onSettled` fires as each item lands, so results can be streamed to the
 *     UI incrementally instead of waiting for the slowest request.
 */

import { FetchError } from './http.js';

/** Measured flat past 8 (1 = 16.2s, 4 = 2.07s, 8 = 1.94s, 16 = 2.07s over 30
 *  packages) — bandwidth-bound, not latency-bound. Higher only raises peak
 *  memory and 429 risk, and corporate proxies are far less forgiving than the
 *  public CDN. */
export const DEFAULT_CONCURRENCY = 8;

export type Settled<R> =
  | { ok: true; value: R }
  | { ok: false; error: FetchError };

export interface PoolOptions<T, R> {
  limit?: number;
  signal?: AbortSignal;
  /** Called once per item as it settles, in completion order. */
  onSettled?: (item: T, result: Settled<R>) => void;
}

function toFetchError(cause: unknown): FetchError {
  if (cause instanceof FetchError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new FetchError('NETWORK', message);
}

/**
 * Run `worker` over `items`, at most `limit` at a time.
 *
 * Resolves to one result per item, in input order. Never rejects — cancellation
 * included, which surfaces as CANCELLED results for whatever had not finished.
 */
export async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T, signal?: AbortSignal) => Promise<R>,
  options: PoolOptions<T, R> = {}
): Promise<Array<Settled<R>>> {
  const limit = Math.max(1, options.limit ?? DEFAULT_CONCURRENCY);
  const results = new Array<Settled<R>>(items.length);
  let next = 0;

  const settle = (index: number, item: T, result: Settled<R>): void => {
    results[index] = result;
    options.onSettled?.(item, result);
  };

  const runOne = async (index: number): Promise<void> => {
    const item = items[index];
    if (item === undefined) return;

    if (options.signal?.aborted === true) {
      settle(index, item, {
        ok: false,
        error: new FetchError('CANCELLED', 'aborted before dispatch'),
      });
      return;
    }

    try {
      const value = await worker(item, options.signal);
      settle(index, item, { ok: true, value });
    } catch (cause) {
      // The only place a worker rejection is allowed to land. Converting it
      // here is what keeps the batch alive.
      settle(index, item, { ok: false, error: toFetchError(cause) });
    }
  };

  const drain = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await runOne(index);
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(drain());
  }
  await Promise.all(workers);

  return results;
}
