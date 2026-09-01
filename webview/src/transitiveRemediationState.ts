import type {
  RemediationOutcomeStatus,
  TransitiveRemediationApplyResult,
  TransitiveRemediationPlanSummary,
  TransitiveRemediationProgressPhase,
} from '../../src/host/webviewProtocol.js';

/**
 * Session-local presentation state for one direct dependency's transitive
 * remediation workflow. The plan and result are always stored intact so a
 * tab switch never reduces the review back to a status-only sentence.
 */
export type TransitiveFixUiState =
  | { phase: 'analyzing' }
  | { phase: 'not-needed'; message: string }
  | { phase: 'legacy-result'; status: RemediationOutcomeStatus }
  | { phase: 'plan'; plan: TransitiveRemediationPlanSummary; reviewed: boolean }
  | {
      phase: 'applying';
      plan: TransitiveRemediationPlanSummary;
      progress: TransitiveRemediationProgressPhase;
      cancelRequested: boolean;
    }
  | { phase: 'stale'; plan: TransitiveRemediationPlanSummary; message: string }
  | { phase: 'result'; plan: TransitiveRemediationPlanSummary; result: TransitiveRemediationApplyResult }
  | { phase: 'error'; message: string };

export function remediationPlanFromState(state: TransitiveFixUiState | undefined): TransitiveRemediationPlanSummary | null {
  if (state === undefined) return null;
  if (state.phase === 'plan' || state.phase === 'applying' || state.phase === 'stale' || state.phase === 'result') {
    return state.plan;
  }
  return null;
}
