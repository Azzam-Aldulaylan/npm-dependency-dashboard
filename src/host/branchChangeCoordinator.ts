export interface BranchTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realBranchTimerScheduler: BranchTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface BranchChangeCoordinatorOptions {
  isMutationBusy(): boolean;
  reconcile(generation: number): Promise<void>;
}

/** Pure debounce/serialization for genuine Git HEAD changes. */
export class BranchChangeCoordinator {
  private generation = 0;
  private pending = false;
  private running = false;
  private timer: unknown;
  private disposed = false;

  constructor(
    private readonly scheduler: BranchTimerScheduler,
    private readonly options: BranchChangeCoordinatorOptions,
    private readonly debounceMs: number
  ) {}

  notify(): number {
    if (this.disposed) return this.generation;
    this.generation += 1;
    this.pending = true;
    if (!this.options.isMutationBusy()) this.schedule(this.debounceMs);
    return this.generation;
  }

  mutationReleased(): void {
    if (this.pending && !this.disposed) this.schedule(0);
  }

  /** True while filesystem bursts are superseded by branch rediscovery. */
  get hasPending(): boolean {
    return this.pending;
  }

  /**
   * Called once reconciliation has selected its authoritative target, just
   * before its disk reload. Later filesystem events are then retained by the
   * normal coordinator; a newer HEAD notification makes this pending again.
   */
  claim(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.pending = false;
    return true;
  }

  isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  /** Restores a claimed reconciliation when a mutation starts before apply. */
  deferClaimed(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.pending = true;
    return true;
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.disposed || !this.pending || this.options.isMutationBusy()) return;
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      await this.options.reconcile(generation);
    } catch {
      // Host reconciliation reports its own recoverable state.
    } finally {
      this.running = false;
      if (!this.disposed && this.pending && generation !== this.generation) this.schedule(0);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
