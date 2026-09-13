import type { ReactElement } from 'react';

import { upgradeConfirmationAction } from '../../../src/host/actionButtonSemantics.js';
import { deriveUpgradeReviewDecision } from '../../../src/host/upgradeReviewDecision.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { IconListChecks } from '../icons.js';

/** Shared decision copy and action semantics; no independent safety judgment. */
export function UpgradeRecommendationCard({ analysis, coordinated }: {
  analysis: UpgradeAnalysisPresentation;
  coordinated: boolean;
}): ReactElement {
  const decision = deriveUpgradeReviewDecision(analysis, coordinated);
  const action = upgradeConfirmationAction(coordinated ? analysis : { ...analysis, smartPlan: null });
  const lead = action === null
    ? 'Choose another target or resolve the dependency conflict.'
    : decision.caution
      ? 'Review the highlighted evidence before upgrading.'
      : !analysis.verification.configured
        ? 'Configure build/test verification before upgrading.'
      : coordinated
        ? 'Review the added dependency changes, then use the coordinated upgrade.'
        : `Upgrade to ${analysis.targetVersion}, then run verification.`;
  const applyStep = action === null
    ? 'Resolve the dependency conflict or choose another target'
    : coordinated
      ? 'Apply the coordinated dependency changes'
      : 'Apply the reviewed version change';
  return (
    <section className="vuln-recommended" aria-labelledby="upgrade-recommended-heading">
      <div className="upgrade-recommendation__heading">
        <span className="upgrade-recommendation__heading-icon" aria-hidden="true"><IconListChecks /></span>
        <h3 className="manage-section-heading" id="upgrade-recommended-heading">Recommended action</h3>
      </div>
      <p className="upgrade-recommendation__lead">{lead}</p>
      <p className="vuln-recommended__message">Why: {decision.recommendation}</p>
      <ol className="upgrade-recommendation__steps">
        <li>{decision.caution ? 'Review highlighted evidence' : 'Confirm completed checks'}</li>
        <li>{analysis.verification.configured ? applyStep : 'Configure build/test verification'}</li>
        <li>{analysis.verification.configured ? 'Run the configured verification after the upgrade' : applyStep}</li>
      </ol>
    </section>
  );
}
