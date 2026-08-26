import type { ReactElement } from 'react';

import type { UpgradeAnalysisChange, UpgradeAnalysisCompatibility, UpgradeAnalysisSmartPlan } from '../../../src/host/webviewProtocol.js';
import { plannerAddedUpgradeChanges } from '../../../src/host/upgradeReviewUiState.js';
import { IconRoute } from '../icons.js';

/**
 * Only ever rendered when the host already found and validated a coordinated
 * plan (`smartPlan !== null`) — the webview never constructs plan steps of
 * its own; `onUseSmartPlan` echoes back only the analysis id the host itself
 * issued, never plan contents (see webviewProtocol.ts's own doc on
 * use-smart-plan).
 */
/**
 * Rendered full-width, above the Compatibility/Security/Files/Verification
 * card grid — a call-to-action the modal is steering the user toward, not
 * another paired status card. Display-only: the "Use coordinated upgrade"
 * action itself lives in the modal footer, so there's exactly one place to
 * trigger it, not two.
 */
export function SmartPlanSection({
  requestedChanges,
  smartPlan,
  compatibility,
}: {
  requestedChanges: UpgradeAnalysisChange[];
  smartPlan: UpgradeAnalysisSmartPlan;
  compatibility: UpgradeAnalysisCompatibility;
}): ReactElement {
  const additionalCount = plannerAddedUpgradeChanges(requestedChanges, smartPlan.changes).length;
  const reasonIds = new Set(smartPlan.reasonFindingIds);
  const reasons = compatibility.findings.filter((finding) => reasonIds.has(finding.id));
  return (
    <section className="smart-plan-banner" aria-labelledby="analysis-smart-plan-heading">
      <h3 className="smart-plan-banner__title" id="analysis-smart-plan-heading">
        <IconRoute className="smart-plan-banner__title-icon" />
        Recommended coordinated upgrade
      </h3>
      <ol className="smart-plan__changes">
        {smartPlan.changes.map((change) => (
          <li className="smart-plan__change" key={change.packageName}>
            <span className="smart-plan__package">{change.packageName}</span>
            <span className="smart-plan__versions">
              {change.currentVersion} → {change.targetVersion}
            </span>
          </li>
        ))}
      </ol>
      <p className="smart-plan-banner__hint">
        The planner added {additionalCount} dependency change{additionalCount === 1 ? '' : 's'} to the requested upgrade.
      </p>
      {reasons.length > 0 ? (
        <div className="coordinated-plan__reasons">
          <p className="coordinated-plan__reasons-label">Why coordination is needed</p>
          <ul>{reasons.map((finding) => <li key={finding.id}>{finding.explanation}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}
