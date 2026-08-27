/**
 * A bounded, synchronously-readable/writable cache backed by an injected
 * asynchronous persistence function — the shape both the persisted project
 * cache (workspaceState) and the persisted registry/ETag cache (globalState)
 * need, and the specific mechanism that lets the existing *synchronous*
 * `EtagStore` interface (src/core/registry/versions.ts) sit in front of
 * VS Code's *asynchronous* `Memento.update` without either becoming async
 * itself (which would ripple through the whole version-fetching hot path)
 * or losing writes to overlapping saves.
 *
 * How: `get`/`set` only ever touch an in-memory `Map` — always synchronous,
 * always immediately consistent for the caller. `set` additionally schedules
 * a persistence flush, either immediately or through an opt-in trailing/max
 * delay policy. The persistence queue is a single chained Promise, so a flush
 * never starts before the previous one finishes, and ordinary flushes persist
 * whatever is in the Map *at the moment they actually run* (not a snapshot
 * captured back when scheduled) — so a burst of `set` calls while a flush is
 * in flight is never lost, just coalesced into the next flush.
 *
 * Eviction is deterministic FIFO-by-most-recent-write: `set`ting a key
 * (new or existing) moves it to the "freshest" end of insertion order: the
 * *oldest not-recently-written* entry is evicted first once `maxEntries` is
 * exceeded, so a project or package the user is actively working with is
 * never the one dropped just because it happened to be cached first.
 */

export interface WriteBackCacheOptions<V> {
  /** The persisted snapshot to hydrate from, already validated by the caller. */
  initialEntries?: readonly (readonly [string, V])[];
  maxEntries: number;
  /** Called with the *current* full entry list every time a flush actually runs. Persistence failures are the caller's concern (e.g. log and drop) — a failed flush does not retry on its own, but the next `set` schedules a fresh one with current data. */
  persist: (entries: Array<[string, V]>) => Promise<void>;
  /** Optional write batching. Omitted by stores that require the original immediate persistence semantics. */
  batching?: WriteBackCacheBatchingOptions;
}

export type WriteBackCacheTimerHandle = object | number;

export interface WriteBackCacheScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): WriteBackCacheTimerHandle;
  cancel(handle: WriteBackCacheTimerHandle): void;
}

export interface WriteBackCacheBatchingOptions {
  /** Flush after writes have been quiet for this long. */
  trailingDelayMs: number;
  /** Flush no later than this long after the first write in a continuous burst. */
  maxDelayMs: number;
  /** Injectable so batching behavior can be tested without wall-clock sleeps. */
  scheduler?: WriteBackCacheScheduler;
}

const DEFAULT_SCHEDULER: WriteBackCacheScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class WriteBackCache<V> {
  private readonly entries: Map<string, V>;
  private readonly maxEntries: number;
  private readonly persistFn: (entries: Array<[string, V]>) => Promise<void>;
  private readonly batching: {
    trailingDelayMs: number;
    maxDelayMs: number;
    scheduler: WriteBackCacheScheduler;
  } | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private dirty = false;
  private disposed = false;
  private batchStartedAt: number | undefined;
  private scheduledFlush: WriteBackCacheTimerHandle | undefined;

  constructor(options: WriteBackCacheOptions<V>) {
    this.entries = new Map(options.initialEntries ?? []);
    this.maxEntries = Math.max(0, options.maxEntries);
    this.persistFn = options.persist;
    this.batching = options.batching === undefined
      ? undefined
      : {
          trailingDelayMs: Math.max(0, options.batching.trailingDelayMs),
          maxDelayMs: Math.max(0, options.batching.maxDelayMs),
          scheduler: options.batching.scheduler ?? DEFAULT_SCHEDULER,
        };
    this.evictIfNeeded();
  }

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  get size(): number {
    return this.entries.size;
  }

  set(key: string, value: V): void {
    // Delete-then-reinsert so an existing key's Map position moves to the
    // "most recently written" end — see the file header on eviction order.
    this.entries.delete(key);
    this.entries.set(key, value);
    this.evictIfNeeded();
    this.scheduleFlush();
  }

  delete(key: string): void {
    if (this.entries.delete(key)) this.scheduleFlush();
  }

  /** Deletes every entry whose value matches `predicate` — the mechanism behind purging every project sharing one npm-workspace root lockfile in a single pass. */
  deleteWhere(predicate: (value: V, key: string) => boolean): void {
    let changed = false;
    for (const [key, value] of this.entries) {
      if (predicate(value, key)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.scheduleFlush();
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey: string | undefined = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  private scheduleFlush(): void {
    if (this.disposed) return; // disposal prevents later writes — see dispose()
    this.dirty = true;
    if (this.batching === undefined) {
      this.enqueueFlush();
      return;
    }

    const now = this.batching.scheduler.now();
    this.batchStartedAt ??= now;
    const deadline = Math.min(
      now + this.batching.trailingDelayMs,
      this.batchStartedAt + this.batching.maxDelayMs
    );
    if (this.scheduledFlush !== undefined) {
      this.batching.scheduler.cancel(this.scheduledFlush);
    }
    this.scheduledFlush = this.batching.scheduler.schedule(() => {
      this.scheduledFlush = undefined;
      this.batchStartedAt = undefined;
      this.enqueueFlush();
    }, Math.max(0, deadline - now));
  }

  private enqueueFlush(): void {
    this.writeQueue = this.writeQueue.then(() => this.flush());
  }

  private async flush(): Promise<void> {
    // Deliberately does NOT check `this.disposed` — `scheduleFlush()` already
    // refuses to enqueue new work once disposed, so the only way `flush()`
    // still runs after `dispose()` is that it was already queued before it.
    // A mutation made before dispose must still reach persist; only
    // mutations *attempted* after dispose are the ones that must not.
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot: Array<[string, V]> = [...this.entries];
    await this.persistSnapshot(snapshot);
  }

  private async persistSnapshot(snapshot: Array<[string, V]>): Promise<void> {
    try {
      await this.persistFn(snapshot);
    } catch {
      // A failed flush does not retry itself, but `writeQueue` must stay a
      // resolved promise — otherwise every future `.then(() => this.flush())`
      // chained onto it would skip flush() forever (a rejected promise's
      // .then with no rejection handler never runs its fulfilled callback),
      // permanently breaking persistence for this store after one transient
      // failure. The next `set`/`delete` still schedules a fresh flush with
      // current data, same as the class doc promises.
    }
  }

  /**
   * Stops scheduling further persistence writes. Does not clear the
   * in-memory Map (a disposed controller/panel simply stops writing
   * through; there is no meaningful reader left to serve stale data to).
   * Any flush already running is left to finish, while dirty state waiting on
   * either the queue or a batch timer is captured as one final snapshot.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.batching !== undefined && this.scheduledFlush !== undefined) {
      this.batching.scheduler.cancel(this.scheduledFlush);
      this.scheduledFlush = undefined;
      this.batchStartedAt = undefined;
    }
    if (this.dirty) {
      // Capture now: post-disposal writes remain synchronously visible in
      // memory, but they must neither schedule nor leak into this final write.
      this.dirty = false;
      const finalSnapshot: Array<[string, V]> = [...this.entries];
      this.writeQueue = this.writeQueue.then(() => this.persistSnapshot(finalSnapshot));
    }
  }
}
