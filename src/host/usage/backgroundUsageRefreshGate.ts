/**
 * Pure decision for requestBackgroundUsageRefresh: given a project's last
 * auto-analyzed fingerprint and its current one, does a background usage
 * pass actually need to scan again? Isolated from vscode (and from the
 * busy/mutation-lock checks, which are trivial booleans the caller already
 * holds) so it can be unit tested directly — see usageCoordinator.ts's own
 * doc on requestBackgroundUsageRefresh for where this fits in the lifecycle.
 *
 * `force: true` (manual Refresh, and every successful mutation reload) always
 * says yes, even when the fingerprint hasn't changed — those callers exist
 * specifically to guarantee a fresh check, not a cheap skip.
 */

import { usageSourceIdentitiesMatch } from './usageAnalysisState.js';
import type { UsageSourceIdentity } from './usageAnalysisState.js';

export function shouldRunBackgroundUsageRefresh(
  force: boolean,
  lastAutoAnalyzedIdentity: UsageSourceIdentity | undefined,
  currentIdentity: UsageSourceIdentity
): boolean {
  if (force) return true;
  if (lastAutoAnalyzedIdentity === undefined) return true;
  return !usageSourceIdentitiesMatch(lastAutoAnalyzedIdentity, currentIdentity);
}
