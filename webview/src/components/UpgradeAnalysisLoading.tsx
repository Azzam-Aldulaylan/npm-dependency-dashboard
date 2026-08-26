import type { ReactElement } from 'react';

import { LoadingRing } from './DependencyLoadingState.js';

/** Exported for UpgradeAnalysisSections.tsx's per-section loading placeholders, which reuse this exact copy rather than inventing a second phrasing for the same two phases. */
export const PHASE_LABEL: Record<'compatibility' | 'smart-plan', string> = {
  compatibility: 'Checking peer compatibility…',
  'smart-plan': 'Finding a coordinated upgrade path…',
};

/**
 * Shown inside the modal shell between the Upgrade click and the analysis
 * arriving. Only ever displays a phase this webview actually received an
 * `upgrade-analyzing` message for — never a fabricated progress sequence
 * (spec: "Do not fake phase progress").
 */
export function UpgradeAnalysisLoading({
  packageName,
  targetVersion,
  changeCount = 1,
  phase,
}: {
  packageName: string;
  targetVersion: string;
  changeCount?: number;
  phase: 'compatibility' | 'smart-plan' | null;
}): ReactElement {
  return (
    <div className="analysis-loading" role="status" aria-live="polite">
      <LoadingRing progress={undefined} />
      <p className="analysis-loading__title">
        {changeCount > 1 ? `Analyzing ${changeCount} dependency upgrades` : `Analyzing ${packageName} ${targetVersion}`}
      </p>
      <p className="analysis-loading__detail">{phase === null ? 'Checking package metadata…' : PHASE_LABEL[phase]}</p>
    </div>
  );
}
