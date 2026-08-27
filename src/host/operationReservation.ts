export interface OperationReservationOptions {
  reserve(packageName: string): boolean;
  release(packageName: string): void;
  flushDeferredChanges(): Promise<void>;
  resumePendingBackground(): void;
  isDisposed(): boolean;
  dispose(): void;
}

/**
 * Injected, deterministic lifecycle for the panel's one dependency-operation
 * reservation. It deliberately distinguishes a read-only review reservation
 * from the short mutation boundary that actually owns dependency files.
 */
export class OperationReservation {
  private heldPackage: string | undefined;
  private mutating = false;

  constructor(private readonly options: OperationReservationOptions) {}

  reserve(packageName: string): boolean {
    if (!this.options.reserve(packageName)) return false;
    this.heldPackage = packageName;
    return true;
  }

  beginMutation(packageName: string): boolean {
    if (this.heldPackage !== packageName) return false;
    this.mutating = true;
    return true;
  }

  get isMutationBusy(): boolean {
    return this.mutating;
  }

  get currentPackage(): string | undefined {
    return this.heldPackage;
  }

  /** Release synchronously, then drain once, then resume background work. */
  async release(packageName: string): Promise<boolean> {
    if (this.heldPackage !== packageName) return false;
    this.heldPackage = undefined;
    this.mutating = false;
    this.options.release(packageName);
    try {
      await this.options.flushDeferredChanges();
    } catch {
      // A failed reload must not poison later reservation releases.
    }
    try {
      this.options.resumePendingBackground();
    } catch {
      // Background refresh is best-effort lifecycle follow-up.
    }
    if (this.options.isDisposed()) this.options.dispose();
    return true;
  }

  async releaseCurrent(): Promise<boolean> {
    return this.heldPackage === undefined ? false : this.release(this.heldPackage);
  }

  disposeIfIdle(): void {
    if (this.heldPackage === undefined) this.options.dispose();
  }
}

/** Monotonic execution gate advanced at the synchronous watcher boundary. */
export class SourceGenerationGuard {
  private generation = 0;

  capture(): number {
    return this.generation;
  }

  advance(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(captured: number): boolean {
    return captured === this.generation;
  }

  /** Commits an analysis result only while its captured source is current. */
  commitIfCurrent(captured: number, commit: () => void): boolean {
    if (!this.isCurrent(captured)) return false;
    commit();
    return true;
  }
}
