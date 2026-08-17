import type { ReactElement } from 'react';

import { LoadingRing } from './DependencyLoadingState.js';

const PHASE_LABEL: Record<'compatibility' | 'smart-plan', string> = {
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
  phase,
}: {
  packageName: string;
  targetVersion: string;
  phase: 'compatibility' | 'smart-plan' | null;
}): ReactElement {
  return (
    <div className="analysis-loading" role="status" aria-live="polite">
      <LoadingRing progress={undefined} />
      <p className="analysis-loading__title">
        Analyzing {packageName} {targetVersion}
      </p>
      <p className="analysis-loading__detail">{phase === null ? 'Checking package metadata…' : PHASE_LABEL[phase]}</p>
    </div>
  );
}
