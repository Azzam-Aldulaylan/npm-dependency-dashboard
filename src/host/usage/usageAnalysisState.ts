import { sourceFingerprintsMatch } from '../../core/cache/sourceFingerprint.js';
import type { ProjectSourceFingerprint } from '../../core/cache/sourceFingerprint.js';
import type { DependencyUsageResult } from '../../core/usage/types.js';

export interface UsageSourceIdentity {
  fingerprint: ProjectSourceFingerprint;
  generation: number;
}

export interface CachedUsage {
  result: DependencyUsageResult;
  identity: UsageSourceIdentity;
  cachedAt: number;
}

export function usageSourceIdentitiesMatch(
  left: UsageSourceIdentity,
  right: UsageSourceIdentity
): boolean {
  return left.generation === right.generation &&
    sourceFingerprintsMatch(left.fingerprint, right.fingerprint);
}

export function canJoinBackgroundUsageScan(input: {
  backgroundOwner: boolean;
  scanProjectId: string;
  requestedProjectId: string;
  scanIdentity: UsageSourceIdentity;
  requestedIdentity: UsageSourceIdentity;
  scannedPackages: ReadonlySet<string>;
  requestedPackages: readonly string[];
}): boolean {
  return input.backgroundOwner &&
    input.scanProjectId === input.requestedProjectId &&
    usageSourceIdentitiesMatch(input.scanIdentity, input.requestedIdentity) &&
    input.requestedPackages.every((name) => input.scannedPackages.has(name));
}

/** A joined foreground cancellation never owns the shared background work. */
export function shouldCancelUnderlyingUsageScan(consumerOwnsScan: boolean): boolean {
  return consumerOwnsScan;
}

export type UsageScanFailureAudience = 'quiet' | 'owner' | 'foreground';

/**
 * Background ownership never produces its own banner. A waiting foreground
 * consumer reports the same rejection through its own expected protocol;
 * without one the failure stays quiet.
 */
export function usageScanFailureAudience(input: {
  backgroundOwner: boolean;
  foregroundWaiters: number;
}): UsageScanFailureAudience {
  if (!input.backgroundOwner) return 'owner';
  return input.foregroundWaiters > 0 ? 'foreground' : 'quiet';
}

export interface ForegroundUsageOperation<T> {
  readonly value: T;
  cancelled: boolean;
}

/**
 * The webview cancellation message has no operation id, so exactly one
 * request-visible foreground operation may own that cancellation channel.
 * Background work is deliberately outside this registry.
 */
export class ForegroundUsageOperationRegistry<T> {
  private active: ForegroundUsageOperation<T> | undefined;

  claim(value: T): ForegroundUsageOperation<T> | undefined {
    if (this.active !== undefined) return undefined;
    const operation = { value, cancelled: false };
    this.active = operation;
    return operation;
  }

  cancelActive(onCancel: (value: T) => void): void {
    const operation = this.active;
    if (operation !== undefined) this.cancel(operation, onCancel);
  }

  cancel(operation: ForegroundUsageOperation<T>, onCancel: (value: T) => void): void {
    if (this.active !== operation || operation.cancelled) return;
    operation.cancelled = true;
    onCancel(operation.value);
  }

  release(operation: ForegroundUsageOperation<T>): void {
    if (this.active === operation) this.active = undefined;
  }

  isClaimed(): boolean {
    return this.active !== undefined;
  }
}

const ANALYSIS_IN_PROGRESS_ERROR = Object.freeze({
  code: 'ANALYSIS_IN_PROGRESS',
  message: 'Another usage analysis is already in progress for this project.',
});

export function foregroundUsageBusyMessage(
  kind: 'usage',
  packageName: string
): { status: 'usage-error'; package: string; error: typeof ANALYSIS_IN_PROGRESS_ERROR };
export function foregroundUsageBusyMessage(
  kind: 'removal'
): { status: 'removal-impact-error'; error: typeof ANALYSIS_IN_PROGRESS_ERROR };
export function foregroundUsageBusyMessage(
  kind: 'usage' | 'removal',
  packageName?: string
): { status: 'usage-error'; package: string; error: typeof ANALYSIS_IN_PROGRESS_ERROR } |
  { status: 'removal-impact-error'; error: typeof ANALYSIS_IN_PROGRESS_ERROR } {
  if (kind === 'usage') {
    return { status: 'usage-error', package: packageName ?? '', error: ANALYSIS_IN_PROGRESS_ERROR };
  }
  return { status: 'removal-impact-error', error: ANALYSIS_IN_PROGRESS_ERROR };
}

/** Project-isolated generation and bounded parsed-result cache. */
export class UsageAnalysisState {
  private readonly generations = new Map<string, number>();
  private readonly cache = new Map<string, Map<string, CachedUsage>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  identity(projectId: string, fingerprint: ProjectSourceFingerprint): UsageSourceIdentity {
    return { fingerprint, generation: this.generation(projectId) };
  }

  generation(projectId: string): number {
    return this.generations.get(projectId) ?? 0;
  }

  invalidate(projectId: string): number {
    const next = this.generation(projectId) + 1;
    this.generations.set(projectId, next);
    this.cache.delete(projectId);
    return next;
  }

  isCurrent(projectId: string, identity: UsageSourceIdentity): boolean {
    return identity.generation === this.generation(projectId);
  }

  get(projectId: string, packageName: string, identity: UsageSourceIdentity): CachedUsage | undefined {
    const entry = this.cache.get(projectId)?.get(packageName);
    if (entry === undefined) return undefined;
    if (this.now() - entry.cachedAt > this.ttlMs) return undefined;
    if (!usageSourceIdentitiesMatch(entry.identity, identity)) return undefined;
    return entry;
  }

  /** Removal claims may only reuse a complete result for every package. */
  getComplete(
    projectId: string,
    packageNames: readonly string[],
    identity: UsageSourceIdentity
  ): Map<string, CachedUsage> | undefined {
    const entries = new Map<string, CachedUsage>();
    for (const packageName of packageNames) {
      const entry = this.get(projectId, packageName, identity);
      if (entry === undefined || entry.result.truncated) return undefined;
      entries.set(packageName, entry);
    }
    return entries;
  }

  set(
    projectId: string,
    packageName: string,
    identity: UsageSourceIdentity,
    result: DependencyUsageResult
  ): CachedUsage {
    let projectCache = this.cache.get(projectId);
    if (projectCache === undefined) {
      projectCache = new Map();
      this.cache.set(projectId, projectCache);
    }
    const entry = { result, identity, cachedAt: this.now() };
    projectCache.set(packageName, entry);
    return entry;
  }
}
