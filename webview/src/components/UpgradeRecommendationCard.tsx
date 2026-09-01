import type { ReactElement } from 'react';

import { semanticButtonClassName, upgradeConfirmationAction } from '../../../src/host/actionButtonSemantics.js';
import { deriveUpgradeReviewDecision } from '../../../src/host/upgradeReviewDecision.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { DirectionalButton } from './DirectionalButton.js';

/** Shared decision copy and action semantics; no independent safety judgment. */
export function UpgradeRecommendationCard({ analysis, coordinated, executionBlocked, busy, onConfirm, onUseSmartPlan }: {
  analysis: UpgradeAnalysisPresentation;
  coordinated: boolean;
  executionBlocked: boolean;
  busy: boolean;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
}): ReactElement {
  const decision = deriveUpgradeReviewDecision(analysis, coordinated);
  const action = upgradeConfirmationAction(coordinated ? analysis : { ...analysis, smartPlan: null });
  return (
    <section className="vuln-recommended" aria-labelledby="upgrade-recommended-heading">
      <h3 className="manage-section-heading" id="upgrade-recommended-heading">Recommended action</h3>
      <p className="vuln-recommended__message">{decision.recommendation}</p>
      {action !== null ? (
        <DirectionalButton
          direction="forward"
          className={semanticButtonClassName(action.variant, 'vuln-recommended__cta upgrade-recommended__cta')}
          disabled={busy || executionBlocked}
          onClick={action.onClick === 'confirm' ? onConfirm : onUseSmartPlan}
        >
          {action.label}
        </DirectionalButton>
      ) : null}
    </section>
  );
}
