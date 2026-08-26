/**
 * Pure, vscode-free client-side state machine for a progressive Upgrade
 * review analysis. Applies one streamed `UpgradeAnalysisPartialSection`
 * (see webviewProtocol.ts) to the running per-section state the Upgrade
 * review panel renders from. Lives under src/host, not webview/src, so it's
 * importable both by App.tsx and by a plain node:test unit test — the same
 * convention this codebase already uses for other App.tsx-adjacent pure
 * logic (see upgradeUiState.ts).
 */

import type {
  SecurityOutcome,
  UpgradeAnalysisChange,
  UpgradeAnalysisCompatibility,
  UpgradeAnalysisFiles,
  UpgradeAnalysisPartialSection,
  UpgradeAnalysisSmartPlan,
  UpgradeAnalysisVerification,
  DependencyClassification,
} from './webviewProtocol.js';

export type SectionStatus<T> =
  | { status: 'waiting' }
  | { status: 'loading' }
  | { status: 'complete'; value: T }
  /** Smart plan only — settled the moment compatibility arrives non-conflict, since the host never sends a smart-plan partial in that case. */
  | { status: 'not-applicable' };

export interface UpgradeOverviewSection {
  currentVersion: string;
  targetVersion: string;
  classification: DependencyClassification;
  majorUpdate: boolean;
  changes: UpgradeAnalysisChange[];
  verification: UpgradeAnalysisVerification;
  files: UpgradeAnalysisFiles;
}

export interface UpgradeAnalysisSections {
  overview: SectionStatus<UpgradeOverviewSection>;
  compatibility: SectionStatus<UpgradeAnalysisCompatibility>;
  security: SectionStatus<SecurityOutcome | null>;
  smartPlan: SectionStatus<UpgradeAnalysisSmartPlan | null>;
}

/** The state a fresh analysis attempt starts from — every section unresolved. */
export const WAITING_UPGRADE_ANALYSIS_SECTIONS: UpgradeAnalysisSections = {
  overview: { status: 'waiting' },
  compatibility: { status: 'waiting' },
  security: { status: 'waiting' },
  smartPlan: { status: 'waiting' },
};

/**
 * Marks the section a just-started `upgrade-analyzing` phase ping refers to
 * as `loading` — a no-op once that section has already settled (`complete`),
 * so a duplicate or out-of-order ping can never regress a real result back
 * to a spinner.
 */
export function markPhaseLoading(
  prev: UpgradeAnalysisSections,
  phase: 'compatibility' | 'smart-plan'
): UpgradeAnalysisSections {
  if (phase === 'compatibility') {
    return prev.compatibility.status === 'waiting' ? { ...prev, compatibility: { status: 'loading' } } : prev;
  }
  return prev.smartPlan.status === 'waiting' ? { ...prev, smartPlan: { status: 'loading' } } : prev;
}

/**
 * Applies one streamed section to the running state. `compatibility`
 * additionally settles `smartPlan` to `not-applicable` in the same update
 * when its own status isn't `'conflict'` — see UpgradeAnalysisPartialSection's
 * own doc for why the host never follows up with a smart-plan partial in
 * that case, and why the webview must not wait on one indefinitely.
 */
export function applyPartialSection(
  prev: UpgradeAnalysisSections,
  section: UpgradeAnalysisPartialSection
): UpgradeAnalysisSections {
  if (section.kind === 'overview') {
    return {
      ...prev,
      overview: {
        status: 'complete',
        value: {
          currentVersion: section.currentVersion,
          targetVersion: section.targetVersion,
          classification: section.classification,
          majorUpdate: section.majorUpdate,
          changes: section.changes,
          verification: section.verification,
          files: section.files,
        },
      },
    };
  }
  if (section.kind === 'compatibility') {
    const next: UpgradeAnalysisSections = {
      ...prev,
      compatibility: { status: 'complete', value: section.compatibility },
    };
    if (section.compatibility.status !== 'conflict' && prev.smartPlan.status !== 'complete') {
      next.smartPlan = { status: 'not-applicable' };
    }
    return next;
  }
  if (section.kind === 'security') {
    return { ...prev, security: { status: 'complete', value: section.security } };
  }
  return { ...prev, smartPlan: { status: 'complete', value: section.smartPlan } };
}
