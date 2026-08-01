/**
 * The vscode-free pieces of the Upgrade action's execution bookkeeping, kept
 * separate from upgradeRunner.ts so they can be unit-tested directly. Files
 * that `import * as vscode from 'vscode'` (upgradeRunner.ts, dashboardPanel.ts,
 * projectResolution.ts) have no node:test coverage in this repo — there is no
 * real `vscode` package outside the extension host for a plain `node --test`
 * process to resolve — so anything worth testing has to live outside them.
 */

/**
 * One upgrade at a time per panel/project — not one per package. While a
 * confirmation dialog or a task is active for any package, every other
 * upgrade request is rejected, even for a different package: running two
 * `npm install`s concurrently against the same package.json/lockfile is a
 * write race regardless of whether the two packages differ.
 */
export class UpgradeLock {
  private heldBy: string | undefined;

  /** Acquires the lock for `packageName` and returns true, unless it's already held (false, no change — by anyone, including a different package). */
  tryAcquire(packageName: string): boolean {
    if (this.heldBy !== undefined) return false;
    this.heldBy = packageName;
    return true;
  }

  /** No-op if `packageName` isn't the current holder — a stale/mismatched release can't clear someone else's lock. */
  release(packageName: string): void {
    if (this.heldBy === packageName) this.heldBy = undefined;
  }

  isHeld(): boolean {
    return this.heldBy !== undefined;
  }

  /** Unconditional release, for panel disposal — the holder no longer matters. */
  clear(): void {
    this.heldBy = undefined;
  }
}

/**
 * Only a literal exit code of `0` counts as success. `vscode.TaskProcessEndEvent`
 * types `exitCode` as `number | undefined` — undefined must never be treated
 * as success, since it means the process ended without VS Code observing a
 * code at all (e.g. it was killed), not that it succeeded.
 */
export function isSuccessfulExitCode(exitCode: number | undefined): boolean {
  return exitCode === 0;
}

/**
 * Tracks callbacks for upgrade runs that are still awaiting a real outcome
 * (a task ending, or a task failing to start), so panel disposal can settle
 * every one of them instead of leaving their promises pending forever. A
 * `vscode.Disposable` only stops *future* events — disposing the
 * `onDidEndTaskProcess` listener a run was waiting on does not, by itself,
 * resolve that run's already-pending Promise.
 */
export class PendingUpgradeRuns {
  private readonly callbacks = new Set<() => void>();

  /** Registers `onDisposed` (called if `settleAll` fires before the run finishes on its own) and returns a function to unregister it once the run finishes normally. */
  track(onDisposed: () => void): () => void {
    this.callbacks.add(onDisposed);
    return () => {
      this.callbacks.delete(onDisposed);
    };
  }

  /** Calls every still-registered callback exactly once, then forgets them all. */
  settleAll(): void {
    const toCall = [...this.callbacks];
    this.callbacks.clear();
    for (const callback of toCall) callback();
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}
