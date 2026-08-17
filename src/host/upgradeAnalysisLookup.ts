/**
 * The pure security-boundary decision behind confirm-upgrade/use-smart-plan:
 * given whatever the coordinator's in-memory analysis store currently holds
 * (or doesn't), and an untrusted `{analysisId, wantsSmartPlan}` request, is
 * there a real, still-fresh, applicable stored analysis to execute?
 *
 * Extracted out of UpgradeAssistantCoordinator (which imports `vscode` and
 * so cannot be unit-tested outside the extension host — see
 * dashboardController.ts's own equivalent split for `validateUpgradeRequest`)
 * so this one decision — the part that actually matters for "can a forged or
 * stale request execute anything" — has a real, fast, vscode-free test
 * suite. The coordinator calls this first, before touching disk or the
 * package manager at all.
 */

export interface StoredAnalysisSummary {
  id: string;
  compatibilityStatus: 'compatible' | 'warning' | 'conflict' | 'unknown';
  /** Whether a validated coordinated plan is attached — never the plan's own contents, which this function has no reason to see. */
  hasSmartPlan: boolean;
  expiresAt: number;
}

export type AnalysisLookupRejection = 'STALE_ANALYSIS' | 'NO_SMART_PLAN' | 'PREFLIGHT_CONFLICT';

export type AnalysisLookupResult = { ok: true } | { ok: false; reason: AnalysisLookupRejection };

export interface ResolveAnalysisForExecutionOptions {
  /** The coordinator's single in-memory slot, or undefined if nothing is currently stored (already consumed, never analyzed, or reclaimed). */
  stored: StoredAnalysisSummary | undefined;
  requestedAnalysisId: string;
  now: number;
  /** True for use-smart-plan, false for confirm-upgrade — the two callers this function has, each wanting a different proposal. */
  wantsSmartPlan: boolean;
}

/**
 * Every rejection here is deliberately indistinguishable from "you're just
 * too late" to a forger: a mismatched id and an expired real id both come
 * back `STALE_ANALYSIS`, never a hint about which real id (if any) is
 * currently stored.
 */
export function resolveAnalysisForExecution(options: ResolveAnalysisForExecutionOptions): AnalysisLookupResult {
  const { stored, requestedAnalysisId, now, wantsSmartPlan } = options;

  if (stored === undefined || stored.id !== requestedAnalysisId || now >= stored.expiresAt) {
    return { ok: false, reason: 'STALE_ANALYSIS' };
  }

  if (wantsSmartPlan) {
    // Confirming a coordinated plan that was never actually offered (a
    // forged or stale selection) must fail closed, never silently fall back
    // to the plain proposal.
    if (!stored.hasSmartPlan) return { ok: false, reason: 'NO_SMART_PLAN' };
    return { ok: true };
  }

  // A real conflict with no chosen coordinated plan must never execute the
  // plain (still-conflicting) proposal — only reachable via a forged
  // confirm-upgrade, since the webview never renders a plain Upgrade button
  // for a conflict.
  if (stored.compatibilityStatus === 'conflict') return { ok: false, reason: 'PREFLIGHT_CONFLICT' };
  return { ok: true };
}
