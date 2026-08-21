import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { RemoveAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { IconRefresh, IconTarget } from '../icons.js';
import { REMOVAL_IMPACT_LABEL } from '../removalImpactState.js';
import type { RemovalImpactState } from '../removalImpactState.js';
import { RemoveAnalysisBody } from './RemoveAnalysisModal.js';
import type { UsageRequestState } from './UsageReferencesPanel.js';

const EMPTY_MATCH_TAGS: ReadonlyMap<string, readonly string[]> = new Map();

function usageCountLabel(usage: UsageRequestState | undefined): string | null {
  if (usage === undefined || usage.phase !== 'done') return null;
  const count = usage.result.references.length;
  return count === 0 ? 'No source references found' : `Used in ${count} file${count === 1 ? '' : 's'}`;
}

/**
 * The Removal review tab — the same real removal preflight
 * RemoveAnalysisModal renders for a bulk removal (files, verification,
 * still-required-by, via the shared RemoveAnalysisBody), embedded here
 * instead of opening a second dialog, plus the lighter removal-impact
 * evidence (source/script/config references, peer requirements) and the
 * usage-reference count Overview and Usage & references already surface —
 * three existing engines combined into one review, never a fourth. `active`
 * is true exactly when this row's own removal is the one App.tsx currently
 * has loaded (`removeOrigin === 'manage-dependency' && activeRemove ===
 * row.name`).
 */
export function RemovalReviewPanel({
  row,
  active,
  analysis,
  busy,
  removalImpact,
  usage,
  onAnalyzeRemoval,
  onConfirm,
  onViewReferences,
  onConfigureVerification,
}: {
  row: PackageRow;
  active: boolean;
  analysis: RemoveAnalysisPresentation | null;
  busy: boolean;
  removalImpact: RemovalImpactState;
  usage: UsageRequestState | undefined;
  onAnalyzeRemoval: () => void;
  onConfirm: () => void;
  onViewReferences: () => void;
  onConfigureVerification: () => void;
}): ReactElement {
  if (!active) {
    return (
      <div className="review-panel__empty">
        <h3 className="review-panel__empty-heading">Removal review</h3>
        <p className="review-panel__empty-status">Not analyzed yet</p>
        <button type="button" className="button" onClick={onAnalyzeRemoval}>
          Analyze removal →
        </button>
      </div>
    );
  }

  const impactEntry = removalImpact.phase === 'done' ? removalImpact.assessments.get(row.name) : undefined;
  const impactAnalyzing = removalImpact.phase === 'analyzing';
  const sourceEvidence = impactEntry?.assessment.evidence.filter((e) => e.kind !== 'peer-requirement') ?? [];
  const peerCount = impactEntry?.assessment.evidence.filter((e) => e.kind === 'peer-requirement').length ?? 0;
  const usageLabel = usageCountLabel(usage);
  const blocked = impactEntry?.assessment.status === 'blocked';

  return (
    <div className="review-panel">
      {analysis !== null ? (
        <section className="analysis-card" aria-labelledby="removal-evidence-heading">
          <h3 className="analysis-card__title" id="removal-evidence-heading">
            <IconTarget className="analysis-card__title-icon" />
            Usage &amp; peer evidence
          </h3>
          {impactEntry !== undefined ? (
            <>
              <p className="manage-action-card__status">
                <span className={`status-badge status-badge--${impactEntry.assessment.status === 'low-risk' ? 'neutral' : 'warning'}`}>
                  {REMOVAL_IMPACT_LABEL[impactEntry.assessment.status]}
                </span>
                {peerCount > 0 ? <span> · required as peer by {peerCount}</span> : null}
              </p>
              {sourceEvidence.length > 0 ? (
                <ul className="manage-action-card__evidence">
                  {sourceEvidence.map((item, index) => (
                    <li key={`${item.kind}-${index}`}>{item.summary}</li>
                  ))}
                </ul>
              ) : (
                <p className="manage-action-card__status">No known source, script, config, or peer reference was found.</p>
              )}
            </>
          ) : impactAnalyzing ? (
            <p className="manage-action-card__status">
              <IconRefresh className="manage-action-card__status-icon manage-action-card__status-icon--spin" />
              Analyzing removal impact…
            </p>
          ) : (
            <p className="manage-action-card__status manage-action-card__status--muted">Peer/usage evidence not analyzed.</p>
          )}
          {usageLabel !== null ? (
            <p className="manage-action-card__status">
              {usageLabel}
              <button type="button" className="button button--subtle" onClick={onViewReferences}>
                View references
              </button>
            </p>
          ) : null}
        </section>
      ) : null}

      <RemoveAnalysisBody
        packages={[row.name]}
        analysis={analysis}
        matchTags={EMPTY_MATCH_TAGS}
        onConfigureVerification={onConfigureVerification}
      />

      {analysis !== null ? (
        <div className="review-panel__footer">
          <button
            type="button"
            className="button button--danger"
            onClick={onConfirm}
            disabled={busy || blocked}
            title={blocked ? 'Removal is blocked — see the peer requirement above.' : undefined}
          >
            Remove dependency
          </button>
        </div>
      ) : null}
    </div>
  );
}
