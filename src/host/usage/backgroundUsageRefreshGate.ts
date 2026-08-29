/**
 * Pure decision for requestBackgroundUsageRefresh: given a project's last
 * completed project-wide analysis and its current source identity, does a
 * background usage pass actually need to scan again? Isolated from vscode (and from the
 * busy/mutation-lock checks, which are trivial booleans the caller already
 * holds) so it can be unit tested directly — see usageCoordinator.ts's own
 * doc on requestBackgroundUsageRefresh for where this fits in the lifecycle.
 *
 * A matching result is reused for one hour. `force: true` (manual Refresh,
 * and every successful mutation reload) always
 * says yes, even when the fingerprint hasn't changed — those callers exist
 * specifically to guarantee a fresh check, not a cheap skip.
 */

import { usageSourceIdentitiesMatch } from './usageAnalysisState.js';
import type { UsageSourceIdentity } from './usageAnalysisState.js';
import { USAGE_ANALYSIS_REUSE_MS } from './usageAnalysisState.js';

export interface ProjectUsageAnalysisMarker {
  identity: UsageSourceIdentity;
  analyzedAt: number;
}

export function shouldRunBackgroundUsageRefresh(
  force: boolean,
  lastProjectAnalysis: ProjectUsageAnalysisMarker | undefined,
  currentIdentity: UsageSourceIdentity,
  now: number = Date.now(),
  reuseMs: number = USAGE_ANALYSIS_REUSE_MS
): boolean {
  if (force) return true;
  if (lastProjectAnalysis === undefined) return true;
  if (!usageSourceIdentitiesMatch(lastProjectAnalysis.identity, currentIdentity)) return true;
  return now - lastProjectAnalysis.analyzedAt >= reuseMs;
}
