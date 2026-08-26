/**
 * Soft (time-based) staleness for a displayed Upgrade review analysis —
 * pure, vscode-free. Deliberately separate from src/core/cache/freshness.ts,
 * which governs the whole-scan TTL (`cacheTtlMinutes`, default 30 minutes
 * — see DEFAULT_TTL_MINUTES); this is a narrower, unrelated ~1 hour window
 * scoped only to how old the currently-displayed upgrade analysis is. Hard
 * (structural) staleness is a different, out-of-band signal entirely — see
 * upgradeAssistantCoordinator.ts's checkOpenAnalysisFreshness and the
 * `upgrade-analysis-stale` message; time alone never implies that.
 */

export const UPGRADE_ANALYSIS_SOFT_STALE_MS = 60 * 60_000;

/** An unparseable `analyzedAt` is treated as "can't tell", not as stale — the same graceful-degrade choice src/core/cache/freshness.ts's own `classifyFreshness` makes for a missing/malformed timestamp. */
export function isUpgradeAnalysisSoftStale(analyzedAt: string, now: number): boolean {
  const analyzedMs = Date.parse(analyzedAt);
  if (!Number.isFinite(analyzedMs)) return false;
  return now - analyzedMs >= UPGRADE_ANALYSIS_SOFT_STALE_MS;
}
