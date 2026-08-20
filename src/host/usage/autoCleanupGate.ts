/**
 * Pure gate for auto-running "Analyze cleanup" (likely-unused detection)
 * once per project state, instead of only ever on an explicit click.
 *
 * Likely-unused detection is a real workspace file scan (see
 * usageAnalyzer.ts) — categorically more expensive than the graph-only
 * hygiene findings computed on every scan. This gate is what keeps an
 * automatic trigger from reopening that cost: it only says yes the first
 * time a project's fingerprint is seen, or after that fingerprint actually
 * changes (a manifest/lockfile edit, an upgrade, a remove) — every other
 * refresh/reload/background revalidation with an unchanged fingerprint is a
 * cheap comparison here, not a new scan.
 */

import { sourceFingerprintsMatch } from '../../core/cache/sourceFingerprint.js';
import type { ProjectSourceFingerprint } from '../../core/cache/sourceFingerprint.js';

/**
 * `force: true` is for an explicit manual Refresh — see
 * usageCoordinator.ts's own doc on why a deliberate, user-initiated refresh
 * bypasses the fingerprint-match check entirely (re-verifying usage the same
 * way a first-ever open does) while every other trigger (background timer,
 * file-watcher reload, a fresh `ready`) stays gated. Busy/lock safety checks
 * still apply either way — `force` only ever overrides the performance gate,
 * never the concurrency ones.
 */
export function shouldAutoAnalyzeCleanup(
  lastAutoAnalyzedFingerprint: ProjectSourceFingerprint | undefined,
  currentFingerprint: ProjectSourceFingerprint,
  isUsageBusy: boolean,
  isUpgradeBusy: boolean,
  force = false
): boolean {
  if (isUsageBusy || isUpgradeBusy) return false;
  if (force) return true;
  if (lastAutoAnalyzedFingerprint === undefined) return true;
  return !sourceFingerprintsMatch(lastAutoAnalyzedFingerprint, currentFingerprint);
}
