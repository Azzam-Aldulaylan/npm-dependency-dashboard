import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { UpgradeAnalysisSections as UpgradeAnalysisSectionsState } from '../../../src/host/upgradeAnalysisSections.js';
import { LoadingRing } from './DependencyLoadingState.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { SmartPlanSection } from './SmartPlanSection.js';
import {
  CompatibilityCheckCard,
  FilesModifiedCard,
  SecurityOutcomeCard,
  SimpleUpgradePlanCard,
  VerificationStepsCard,
} from './UpgradeAnalysisCards.js';
import { PHASE_LABEL } from './UpgradeAnalysisLoading.js';

/**
 * A single section's compact loading placeholder — deliberately not a large
 * skeleton or a second progress-bar system, just a small ring plus the same
 * phase copy UpgradeAnalysisLoading.tsx already uses, sized to sit in a
 * card's own slot in the grid below.
 */
function SectionPlaceholder({ label }: { label: string }): ReactElement {
  return (
    <div className="analysis-card analysis-card--pending" role="status" aria-live="polite">
      <LoadingRing progress={undefined} />
      <p className="analysis-card__pending-label">{label}</p>
    </div>
  );
}

/**
 * The Upgrade review tab's loading state, rendered while `analysis` is still
 * null — each of the five sections (Overview feeds Files/Verification;
 * Compatibility; Security; Smart plan) shows its own real card the moment
 * its own data arrives, instead of gating everything behind one spinner.
 * Never renders the headline/summary cards (Upgrade summary, At a glance,
 * Recommended action, Upgrade preview) — those synthesize across every
 * section at once and only ever appear once the full `analysis` replaces
 * this component entirely (see UpgradeReviewPanel.tsx).
 */
export function UpgradeAnalysisSections({
  row,
  targetVersion,
  sections,
  onChangeTab,
  onConfigureVerification,
}: {
  row: PackageRow;
  targetVersion: string;
  sections: UpgradeAnalysisSectionsState;
  onChangeTab: (tab: ManageTabId) => void;
  onConfigureVerification: () => void;
}): ReactElement {
  const { overview, compatibility, security, smartPlan } = sections;

  return (
    <div className="upgrade-tab">
      <div className="upgrade-tab__details">
        <div className="analysis-loading analysis-loading--compact" role="status" aria-live="polite">
          <LoadingRing progress={undefined} />
          <p className="analysis-loading__title">
            Analyzing {row.name} {targetVersion}
          </p>
        </div>
        {compatibility.status === 'complete' ? (
          <CompatibilityCheckCard compatibility={compatibility.value} majorUpdate={overview.status === 'complete' ? overview.value.majorUpdate : false} />
        ) : (
          <SectionPlaceholder label={compatibility.status === 'loading' ? PHASE_LABEL.compatibility : 'Waiting to check compatibility…'} />
        )}

        {smartPlan.status === 'complete' && smartPlan.value !== null ? (
          // A found, validated coordinated plan.
          <SmartPlanSection smartPlan={smartPlan.value} />
        ) : (smartPlan.status === 'not-applicable' || (smartPlan.status === 'complete' && smartPlan.value === null)) &&
          overview.status === 'complete' ? (
          // Either no conflict existed at all, or one did and no coordinated
          // plan was found — both show the plain requested-changes list, the
          // same "always render one or the other" behavior the fully-
          // populated view below already has.
          <SimpleUpgradePlanCard row={row} changes={overview.value.changes} />
        ) : (
          <SectionPlaceholder label={smartPlan.status === 'loading' ? PHASE_LABEL['smart-plan'] : 'Waiting for compatibility results…'} />
        )}

        {security.status === 'complete' ? (
          <SecurityOutcomeCard row={row} security={security.value} onChangeTab={onChangeTab} />
        ) : (
          <SectionPlaceholder label="Checking known vulnerabilities…" />
        )}

        <div className="upgrade-tab__bottom-grid">
          {overview.status === 'complete' ? (
            <FilesModifiedCard files={overview.value.files} />
          ) : (
            <SectionPlaceholder label="Preparing file list…" />
          )}
          {overview.status === 'complete' ? (
            <VerificationStepsCard verification={overview.value.verification} onConfigureVerification={onConfigureVerification} />
          ) : (
            <SectionPlaceholder label="Preparing verification…" />
          )}
        </div>
      </div>
    </div>
  );
}
