/**
 * Coordinates what happens after a raw filesystem watcher event, decoupled
 * from `vscode.FileSystemWatcher` itself so this whole decision layer is
 * unit-testable without an extension host — only the actual watcher
 * subscription and the actual disk re-read stay in src/host.
 *
 * Owns four concerns a host adapter would otherwise have to get right on
 * its own, all pure Set/generation bookkeeping:
 *   1. Coalescing — repeated `notify()` calls before the host's own debounce
 *      timer calls `flush()` accumulate into one burst, so one filesystem
 *      event turns into one reload with the union of kinds, not several.
 *   2. Deferral during an active upgrade — processing while `isBusy()` is
 *      true does not drop the event; it holds the kinds until
 *      `flushDeferred()` is called (once the upgrade lock is released,
 *      success or failure — a failed task can still have partially rewritten
 *      package.json/the lockfile before it failed).
 *   3. Serialized, generation-checked reloads — concurrent `flush()`/
 *      `flushDeferred()` calls never let their `reload()` invocations
 *      interleave, and a reload whose generation has gone stale by the time
 *      its turn comes up (a project switch happened first) is skipped
 *      outright rather than applied to whatever project is now selected.
 *   4. Self-draining — a `notify()` that arrives *while* a reload is already
 *      running is not lost even if nothing ever calls `flush()` for it
 *      again. The host's own debounce timer is exactly such a thing it
 *      cannot rely on: `reload()` itself typically ends by recreating the
 *      watcher (a fresh resolved lockfile path, a project switch), which
 *      cancels whatever timer the host had scheduled to eventually flush
 *      that newly-pending burst. So after every `reload()` call settles,
 *      this class checks its own pending state itself and keeps draining
 *      until nothing is left — no second external event required.
 */

export type FileChangeKind = 'manifest' | 'lockfile' | 'configuration';

function mergeKinds(
  existing: Set<FileChangeKind> | undefined,
  next: ReadonlySet<FileChangeKind>
): Set<FileChangeKind> {
  const merged = existing === undefined ? new Set<FileChangeKind>() : new Set(existing);
  for (const kind of next) merged.add(kind);
  return merged;
}

export interface FileChangeCoordinatorOptions {
  /** True while an operation (e.g. an Upgrade task) that owns the watched files itself is in progress. */
  isBusy: () => boolean;
  /** A monotonically increasing counter the host bumps on every authoritative project switch. */
  currentGeneration: () => number;
  /** Performs the actual reload (disk re-read + controller snapshot replacement). Receives the generation captured when this burst started, so it can apply its own final staleness check around the disk read too. */
  reload: (kinds: ReadonlySet<FileChangeKind>, generation: number) => Promise<void>;
}

export class FileChangeCoordinator {
  private pendingKinds = new Set<FileChangeKind>();
  private pendingGeneration: number | undefined;
  private deferredKinds: Set<FileChangeKind> | undefined;
  private reloadChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: FileChangeCoordinatorOptions) {}

  /** Call once per raw filesystem event. Coalesces with anything else pending for the same not-yet-flushed burst. */
  notify(kind: FileChangeKind): void {
    if (this.disposed) return;
    this.pendingKinds.add(kind);
    if (this.pendingGeneration === undefined) this.pendingGeneration = this.options.currentGeneration();
  }

  get hasPending(): boolean {
    return this.pendingKinds.size > 0;
  }

  get hasDeferred(): boolean {
    return this.deferredKinds !== undefined && this.deferredKinds.size > 0;
  }

  /** Host calls this when its own debounce timer fires. */
  async flush(): Promise<void> {
    if (this.disposed || this.pendingKinds.size === 0) return;
    const kinds = this.pendingKinds;
    const generation = this.pendingGeneration ?? this.options.currentGeneration();
    this.pendingKinds = new Set();
    this.pendingGeneration = undefined;
    await this.enqueue(kinds, generation);
  }

  /** Host calls this once the operation that made `isBusy()` true has released — processes anything that was deferred while busy. */
  async flushDeferred(): Promise<void> {
    if (this.disposed) return;
    const kinds = this.deferredKinds;
    this.deferredKinds = undefined;
    if (kinds === undefined || kinds.size === 0) return;
    await this.enqueue(kinds, this.options.currentGeneration());
  }

  /** A full, authoritative reload the host already knows about (an explicit project switch) makes any pending/deferred burst for the old selection moot. */
  discardPending(): void {
    this.pendingKinds = new Set();
    this.pendingGeneration = undefined;
    this.deferredKinds = undefined;
  }

  private async enqueue(kinds: Set<FileChangeKind>, generation: number): Promise<void> {
    // Chained onto `reloadChain` (not run directly) so concurrent flush()/
    // flushDeferred() calls never let their reload()s interleave — the
    // second one's turn only starts once the first has fully settled.
    // `.catch()` here, not just around the assignment, matters for two
    // reasons: the chain itself must never become a rejected promise (see
    // writeBackCache.ts for the identical hazard — a rejected promise's
    // `.then(onFulfilled)` with no rejection handler skips onFulfilled
    // forever, permanently breaking every reload queued after this one), and
    // this method's own caller (`flush`/`flushDeferred`, called fire-and-
    // forget as `void ...` by the host) must never see an unhandled
    // rejection just because one `reload()` call happened to throw.
    const settled = this.reloadChain.then(() => this.runAndDrain(kinds, generation)).catch(() => {});
    this.reloadChain = settled;
    await settled;
  }

  /**
   * Runs one reload (or defers it, if busy), then — before returning —
   * checks whether anything landed in `pendingKinds` while that reload was
   * in flight and, if so, immediately processes that too, looping until
   * nothing is left. This is what makes a `notify()` that arrives mid-reload
   * safe even if the host's own debounce timer that would otherwise have
   * flushed it gets cancelled by that very reload's side effects (see the
   * class doc, point 4) — draining happens here, unconditionally, not only
   * in response to an external `flush()` call.
   */
  private async runAndDrain(kinds: Set<FileChangeKind>, generation: number): Promise<void> {
    let currentKinds = kinds;
    let currentGeneration = generation;
    for (;;) {
      if (this.disposed) return;
      if (currentGeneration === this.options.currentGeneration()) {
        if (this.options.isBusy()) {
          this.deferredKinds = mergeKinds(this.deferredKinds, currentKinds);
        } else {
          await this.options.reload(currentKinds, currentGeneration);
        }
      }
      // else: stale by the time this iteration's turn came up — skipped outright, never applied.

      if (this.disposed || this.pendingKinds.size === 0) return;
      currentKinds = this.pendingKinds;
      currentGeneration = this.pendingGeneration ?? this.options.currentGeneration();
      this.pendingKinds = new Set();
      this.pendingGeneration = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pendingKinds = new Set();
    this.pendingGeneration = undefined;
    this.deferredKinds = undefined;
  }
}
