import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { UpgradeAnalysisSections as UpgradeAnalysisSectionsState } from '../../../src/host/upgradeAnalysisSections.js';
import { hasPlannerAddedCoordination } from '../../../src/host/upgradeReviewUiState.js';
import { LoadingRing } from './DependencyLoadingState.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import {
  CompatibilityCheckCard,
  CoordinatedUpgradePlanCard,
  CoordinationUnavailableCard,
  SecurityOutcomeCard,
  SimpleUpgradePlanCard,
  VerificationStepsCard,
} from './UpgradeAnalysisCards.js';
import { PHASE_LABEL } from './UpgradeAnalysisLoading.js';
import { ProjectCompatibilitySection } from './ProjectCompatibilitySection.js';

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
  onOpenAdvisory,
  onOpenUsageReference,
}: {
  row: PackageRow;
  targetVersion: string;
  sections: UpgradeAnalysisSectionsState;
  onChangeTab: (tab: ManageTabId) => void;
  onConfigureVerification: () => void;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[]) => void) | undefined;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
}): ReactElement {
  const { overview, compatibility, projectCompatibility, security, smartPlan } = sections;

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
          <CompatibilityCheckCard
            compatibility={compatibility.value}
            projectCompatibility={projectCompatibility.status === 'complete' ? projectCompatibility.value : undefined}
          />
        ) : (
          <SectionPlaceholder label={compatibility.status === 'loading' ? PHASE_LABEL.compatibility : 'Waiting to check compatibility…'} />
        )}

        {projectCompatibility.status === 'complete' ? (
          <ProjectCompatibilitySection analysis={projectCompatibility.value} onOpenUsageReference={onOpenUsageReference} />
        ) : (
          <SectionPlaceholder
            label={projectCompatibility.status === 'loading' ? PHASE_LABEL['project-compatibility'] : 'Waiting to check project compatibility…'}
          />
        )}

        {smartPlan.status === 'complete' &&
        smartPlan.value !== null &&
        overview.status === 'complete' &&
        hasPlannerAddedCoordination(overview.value.changes, smartPlan.value.changes) ? (
          // A found, validated coordinated plan.
          compatibility.status === 'complete' ? (
            <CoordinatedUpgradePlanCard
              requestedChanges={overview.value.changes}
              smartPlan={smartPlan.value}
              compatibility={compatibility.value}
            />
          ) : (
            <SectionPlaceholder label="Preparing coordinated plan…" />
          )
        ) : (smartPlan.status === 'not-applicable' || smartPlan.status === 'complete') &&
          overview.status === 'complete' ? (
          compatibility.status === 'complete' && compatibility.value.status === 'conflict' ? (
            <CoordinationUnavailableCard row={row} changes={overview.value.changes} />
          ) : (
            <SimpleUpgradePlanCard row={row} changes={overview.value.changes} />
          )
        ) : (
          <SectionPlaceholder label={smartPlan.status === 'loading' ? PHASE_LABEL['smart-plan'] : 'Waiting for compatibility results…'} />
        )}

        {security.status === 'complete' ? (
          <SecurityOutcomeCard row={row} security={security.value} onChangeTab={onChangeTab} onOpenAdvisory={onOpenAdvisory} />
        ) : (
          <SectionPlaceholder label="Checking known vulnerabilities…" />
        )}

        {overview.status === 'complete' ? (
          <VerificationStepsCard verification={overview.value.verification} onConfigureVerification={onConfigureVerification} />
        ) : (
          <SectionPlaceholder label="Preparing verification…" />
        )}
      </div>
    </div>
  );
}
