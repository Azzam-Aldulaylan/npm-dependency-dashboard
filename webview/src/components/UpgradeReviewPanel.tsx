import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { primaryAction, UpgradeAnalysisBody } from './UpgradeAnalysisModal.js';

/**
 * The Upgrade review tab — the exact same review/confirm experience
 * UpgradeAnalysisModal renders for a bulk upgrade, embedded in place here
 * instead of opening a second dialog (see UpgradeAnalysisBody's own doc).
 * `active` is true exactly when this row's own upgrade is the one App.tsx
 * currently has loaded (`upgradeOrigin === 'manage-dependency' &&
 * activeUpgrade === row.name`) — false means either nothing has been
 * analyzed yet, or the target version is simply displayed from `row` while
 * waiting for "Analyze upgrade" to be clicked.
 */
export function UpgradeReviewPanel({
  row,
  active,
  targetVersion,
  analyzingPhase,
  analysis,
  busy,
  onAnalyzeUpgrade,
  onConfirm,
  onUseSmartPlan,
  onCancel,
  onConfigureVerification,
  onOpenAdvisory,
}: {
  row: PackageRow;
  active: boolean;
  /** The upgrade target this row currently offers, or null when none is available. */
  targetVersion: string | null;
  analyzingPhase: 'compatibility' | 'smart-plan' | null;
  analysis: UpgradeAnalysisPresentation | null;
  busy: boolean;
  onAnalyzeUpgrade: (target: string) => void;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
  onCancel: () => void;
  onConfigureVerification: () => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
}): ReactElement {
  if (!active || targetVersion === null) {
    if (targetVersion === null) {
      return (
        <div className="manage-panel-empty">
          <p>No upgrade is currently available for {row.name}.</p>
        </div>
      );
    }
    return (
      <div className="review-panel__empty">
        <h3 className="review-panel__empty-heading">Upgrade review</h3>
        <p className="review-panel__empty-versions">
          {row.current ?? row.range}
          <span aria-hidden="true"> → </span>
          {targetVersion}
        </p>
        <p className="review-panel__empty-status">Not analyzed yet</p>
        <button type="button" className="button" onClick={() => onAnalyzeUpgrade(targetVersion)}>
          Analyze upgrade →
        </button>
      </div>
    );
  }

  const action = analysis !== null ? primaryAction(analysis) : null;

  return (
    <div className="review-panel">
      <UpgradeAnalysisBody
        packageName={row.name}
        targetVersion={targetVersion}
        analyzingPhase={analyzingPhase}
        analysis={analysis}
        onOpenAdvisory={onOpenAdvisory}
        onConfigureVerification={onConfigureVerification}
      />
      <div className="review-panel__footer">
        <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
          {analysis !== null && analysis.compatibility.status === 'conflict' && analysis.smartPlan === null
            ? 'Close review'
            : 'Cancel analysis'}
        </button>
        {action !== null ? (
          <button
            type="button"
            className={`button${analysis?.compatibility.status === 'warning' || analysis?.compatibility.status === 'unknown' ? ' button--subtle' : ''}`}
            onClick={action.onClick === 'confirm' ? onConfirm : onUseSmartPlan}
            disabled={busy || analysis === null}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
