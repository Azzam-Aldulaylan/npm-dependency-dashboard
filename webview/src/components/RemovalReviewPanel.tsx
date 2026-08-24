import type { ReactElement } from 'react';

import type { PackageRow, RemovalAssessment, RemovalEvidence } from '../../../src/core/types.js';
import type {
  RemoveAnalysisFiles,
  RemoveAnalysisPresentation,
  UpgradeAnalysisVerification,
} from '../../../src/host/webviewProtocol.js';
import { CLASSIFICATION_LABEL, classificationOf } from '../dependencyClassification.js';
import {
  IconAlertTriangle,
  IconCheck,
  IconFile,
  IconGear,
  IconHelpCircle,
  IconHistory,
  IconListChecks,
  IconPackage,
  IconRefresh,
  IconRoute,
  IconTarget,
  IconTrash,
} from '../icons.js';
import type { RemovalImpactState } from '../removalImpactState.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import type { UsageRequestState } from './UsageReferencesPanel.js';

type CheckTone = 'ok' | 'warning' | 'blocked' | 'unknown';

function GlanceRow({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="manage-glance__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-1) ?? path;
}

function evidenceOfKind(assessment: RemovalAssessment | undefined, ...kinds: RemovalEvidence['kind'][]): RemovalEvidence[] {
  if (assessment === undefined) return [];
  return assessment.evidence.filter((entry) => kinds.includes(entry.kind));
}

function sourceReferenceCount(usage: UsageRequestState | undefined): number | null {
  if (usage === undefined || usage.phase !== 'done') return null;
  const sourcePaths = new Set(
    usage.result.references
      .filter(
        (reference) =>
          reference.kind === 'import' || reference.kind === 'require' || reference.kind === 'dynamic-import'
      )
      .map((reference) => reference.filePath)
  );
  return sourcePaths.size;
}

function statusCopy(assessment: RemovalAssessment | undefined): {
  label: string;
  className: 'compatible' | 'warning' | 'conflict' | 'unknown';
  detail: string;
} {
  if (assessment === undefined || assessment.status === 'unknown') {
    return {
      label: 'Removal impact unknown',
      className: 'unknown',
      detail: assessment?.evidence[0]?.summary ?? 'Removal impact analysis did not produce a complete result.',
    };
  }
  if (assessment.status === 'blocked') {
    return {
      label: 'Removal blocked',
      className: 'conflict',
      detail: assessment.evidence[0]?.summary ?? 'A required peer dependency blocks this removal.',
    };
  }
  if (assessment.status === 'review') {
    return {
      label: 'Review required',
      className: 'warning',
      detail: assessment.evidence[0]?.summary ?? 'Known references should be reviewed before removal.',
    };
  }
  return {
    label: 'Low risk',
    className: 'compatible',
    detail: 'No known source, script, config, or required peer reference was found.',
  };
}

function actionLabel(packageName: string, assessment: RemovalAssessment | undefined): string {
  if (assessment?.status === 'review') return 'Remove anyway';
  return `Remove ${packageName}`;
}

function RemovalSummaryCard({
  row,
  analysis,
  assessment,
}: {
  row: PackageRow;
  analysis: RemoveAnalysisPresentation;
  assessment: RemovalAssessment | undefined;
}): ReactElement {
  const status = statusCopy(assessment);
  const change = analysis.changes.find((candidate) => candidate.packageName === row.name) ?? analysis.changes[0];
  const requiredBy = change?.stillRequiredBy.length ?? 0;

  return (
    <section className="analysis-card" aria-labelledby="removal-summary-heading">
      <h3 className="manage-section-heading" id="removal-summary-heading">
        Removal summary
      </h3>
      <OutcomeStatus label={status.label} className={status.className} detail={status.detail} />
      <dl className="manage-glance removal-summary__facts">
        <GlanceRow label="Version">{row.current ?? row.range}</GlanceRow>
        <GlanceRow label="Required by">{`${requiredBy} package${requiredBy === 1 ? '' : 's'}`}</GlanceRow>
        {row.advisories.length > 0 ? <GlanceRow label="Vulnerabilities">{String(row.advisories.length)}</GlanceRow> : null}
      </dl>
    </section>
  );
}

function AtAGlanceCard({
  row,
  analysis,
  assessment,
  usage,
}: {
  row: PackageRow;
  analysis: RemoveAnalysisPresentation;
  assessment: RemovalAssessment | undefined;
  usage: UsageRequestState | undefined;
}): ReactElement {
  const change = analysis.changes.find((candidate) => candidate.packageName === row.name) ?? analysis.changes[0];
  const requiredBy = change?.stillRequiredBy.length ?? 0;
  const sourceCount = sourceReferenceCount(usage);
  const sourceEvidence = evidenceOfKind(assessment, 'source-reference')[0];
  const usedInCode =
    sourceCount !== null
      ? `${sourceCount} file${sourceCount === 1 ? '' : 's'}`
      : sourceEvidence?.summary ?? (assessment !== undefined && assessment.status !== 'unknown' ? '0 files' : 'Unknown');

  return (
    <section className="analysis-card" aria-labelledby="removal-glance-heading">
      <h3 className="manage-section-heading" id="removal-glance-heading">
        At a glance
      </h3>
      <dl className="manage-glance">
        <GlanceRow label="Installed version">{row.current ?? row.range}</GlanceRow>
        <GlanceRow label="Required by">{`${requiredBy} package${requiredBy === 1 ? '' : 's'}`}</GlanceRow>
        <GlanceRow label="Used in code">{usedInCode}</GlanceRow>
        <GlanceRow label="Vulnerabilities">{String(row.advisories.length)}</GlanceRow>
        <GlanceRow label="Package type">{CLASSIFICATION_LABEL[change?.classification ?? classificationOf(row)]}</GlanceRow>
      </dl>
    </section>
  );
}

function RecommendedActionCard({
  row,
  assessment,
  busy,
  onConfirm,
  onViewReferences,
}: {
  row: PackageRow;
  assessment: RemovalAssessment | undefined;
  busy: boolean;
  onConfirm: () => void;
  onViewReferences: () => void;
}): ReactElement {
  const allowed = assessment?.status === 'low-risk' || assessment?.status === 'review';
  const message =
    assessment?.status === 'low-risk'
      ? 'No known project reference or required peer dependency was found.'
      : assessment?.status === 'review'
        ? 'Review the detected references before choosing to remove this dependency.'
        : assessment?.status === 'blocked'
          ? 'Resolve the required peer dependency before removing this package.'
          : 'Re-run impact analysis before allowing a destructive removal.';

  return (
    <section className="vuln-recommended removal-recommended" aria-labelledby="removal-recommended-heading">
      <h3 className="manage-section-heading" id="removal-recommended-heading">
        Recommended action
      </h3>
      <p className="vuln-recommended__message">{message}</p>
      {assessment?.status === 'review' ? (
        <button type="button" className="usage-show-all removal-recommended__references" onClick={onViewReferences}>
          View references →
        </button>
      ) : null}
      {allowed ? (
        <button type="button" className="button button--danger removal-recommended__cta" onClick={onConfirm} disabled={busy}>
          {actionLabel(row.name, assessment)}
          <IconTrash aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}

function DependencyCheckItem({ tone, label, value }: { tone: CheckTone; label: string; value: string }): ReactElement {
  const icon =
    tone === 'ok' ? <IconCheck /> : tone === 'warning' || tone === 'blocked' ? <IconAlertTriangle /> : <IconHelpCircle />;
  return (
    <div className={`removal-check__item removal-check__item--${tone}`}>
      <span className="removal-check__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="removal-check__copy">
        <span className="removal-check__label">{label}</span>
        <span className="removal-check__value">{value}</span>
      </span>
    </div>
  );
}

function DependencyCheckCard({
  analysis,
  assessment,
  usage,
}: {
  analysis: RemoveAnalysisPresentation;
  assessment: RemovalAssessment | undefined;
  usage: UsageRequestState | undefined;
}): ReactElement {
  const requiredBy = analysis.changes.reduce((total, change) => total + change.stillRequiredBy.length, 0);
  const sourceCount = sourceReferenceCount(usage);
  const sourceEvidence = evidenceOfKind(assessment, 'source-reference')[0];
  const peerEvidence = evidenceOfKind(assessment, 'peer-requirement');
  const projectEvidence = evidenceOfKind(assessment, 'script-reference', 'config-reference');
  const known = assessment !== undefined && assessment.status !== 'unknown';
  const sourceValue =
    sourceCount !== null
      ? sourceCount === 0
        ? 'No references found'
        : `${sourceCount} reference${sourceCount === 1 ? '' : 's'} found`
      : sourceEvidence?.summary ?? (known ? 'No references found' : 'Not checked');

  return (
    <section className="analysis-card" aria-labelledby="removal-dependency-check-heading">
      <h3 className="analysis-card__title" id="removal-dependency-check-heading">
        <IconRoute className="analysis-card__title-icon" />
        Dependency check
      </h3>
      <div className="removal-check">
        <DependencyCheckItem
          tone={requiredBy > 0 ? 'warning' : 'ok'}
          label="Dependent packages"
          value={requiredBy === 0 ? 'None' : `${requiredBy} package${requiredBy === 1 ? '' : 's'}`}
        />
        <DependencyCheckItem
          tone={!known && sourceCount === null ? 'unknown' : sourceCount !== null ? (sourceCount > 0 ? 'warning' : 'ok') : sourceEvidence !== undefined ? 'warning' : 'ok'}
          label="Used in source code"
          value={sourceValue}
        />
        <DependencyCheckItem
          tone={!known ? 'unknown' : peerEvidence.length === 0 ? 'ok' : assessment?.status === 'blocked' ? 'blocked' : 'warning'}
          label="Peer dependencies"
          value={!known ? 'Not checked' : peerEvidence.length === 0 ? 'No conflicts' : `${peerEvidence.length} requirement${peerEvidence.length === 1 ? '' : 's'}`}
        />
        <DependencyCheckItem
          tone={!known ? 'unknown' : projectEvidence.length === 0 ? 'ok' : 'warning'}
          label="Scripts & configuration"
          value={!known ? 'Not checked' : projectEvidence.length === 0 ? 'No references found' : `${projectEvidence.length} reference${projectEvidence.length === 1 ? '' : 's'}`}
        />
      </div>
    </section>
  );
}

function WhatWillBeRemovedCard({ row, analysis }: { row: PackageRow; analysis: RemoveAnalysisPresentation }): ReactElement {
  const change = analysis.changes.find((candidate) => candidate.packageName === row.name) ?? analysis.changes[0];
  return (
    <section className="analysis-card" aria-labelledby="removal-selected-heading">
      <h3 className="analysis-card__title" id="removal-selected-heading">
        What will be removed
      </h3>
      <div className="removal-package">
        <IconPackage className="removal-package__icon" aria-hidden="true" />
        <span className="removal-package__identity">
          <strong>{row.name}</strong>
          <span>{row.current ?? row.range}</span>
          <span>{CLASSIFICATION_LABEL[change?.classification ?? classificationOf(row)]} direct dependency</span>
        </span>
      </div>
    </section>
  );
}

function ImpactItem({
  icon,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  icon: ReactElement;
  label: string;
  value: string;
  detail: string;
  tone?: 'good' | 'warning' | 'neutral';
}): ReactElement {
  return (
    <div className="removal-impact__item">
      <span className="removal-impact__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="removal-impact__copy">
        <span className="removal-impact__label">{label}</span>
        <strong className={`removal-impact__value removal-impact__value--${tone}`}>{value}</strong>
        <span className="removal-impact__detail">{detail}</span>
      </span>
    </div>
  );
}

function ImpactAfterRemovalCard({
  analysis,
  assessment,
  usage,
}: {
  analysis: RemoveAnalysisPresentation;
  assessment: RemovalAssessment | undefined;
  usage: UsageRequestState | undefined;
}): ReactElement {
  const requiredBy = analysis.changes.reduce((total, change) => total + change.stillRequiredBy.length, 0);
  const sourceCount = sourceReferenceCount(usage);
  const sourceEvidence = evidenceOfKind(assessment, 'source-reference')[0];
  const known = assessment !== undefined && assessment.status !== 'unknown';
  const usageValue =
    sourceCount !== null
      ? sourceCount === 0
        ? 'No references'
        : `${sourceCount} reference${sourceCount === 1 ? '' : 's'}`
      : sourceEvidence?.summary ?? (known ? 'No references' : 'Unknown');

  return (
    <section className="analysis-card" aria-labelledby="removal-impact-heading">
      <h3 className="analysis-card__title" id="removal-impact-heading">
        Impact after removal
      </h3>
      <div className="removal-impact">
        <ImpactItem
          icon={<IconPackage />}
          label="Dependency relationship"
          value={requiredBy === 0 ? 'Direct declaration removed' : `Still required by ${requiredBy}`}
          detail={requiredBy === 0 ? 'No remaining dependency path found' : 'The package may remain transitively installed'}
          tone={requiredBy === 0 ? 'good' : 'warning'}
        />
        <ImpactItem
          icon={<IconTarget />}
          label="Source usage"
          value={usageValue}
          detail={known ? (sourceEvidence === undefined && sourceCount === 0 ? 'No source files affected' : 'Review before removal') : 'Analysis incomplete'}
          tone={!known ? 'neutral' : sourceEvidence !== undefined || (sourceCount ?? 0) > 0 ? 'warning' : 'good'}
        />
        <ImpactItem
          icon={<IconGear />}
          label="Application impact"
          value="Unknown"
          detail="Static analysis cannot guarantee runtime behavior"
        />
      </div>
    </section>
  );
}

function FilesModifiedCard({ files }: { files: RemoveAnalysisFiles }): ReactElement {
  return (
    <section className="analysis-card" aria-labelledby="removal-files-heading">
      <h3 className="analysis-card__title" id="removal-files-heading">
        <IconFile className="analysis-card__title-icon" />
        Files to be modified
      </h3>
      <p className="usage-card__subtitle">The following files will be updated.</p>
      <ul className="usage-ref-list upgrade-files-list">
        {[files.manifestPath, files.lockfilePath].map((path) => (
          <li className="usage-ref__button usage-ref__button--static upgrade-files-list__item" key={path}>
            <IconFile className="usage-ref__icon" aria-hidden="true" />
            <span className="usage-ref__path">{baseName(path)}</span>
            <span className="status-badge status-badge--neutral">Modified</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VerificationStepsCard({
  verification,
  onConfigureVerification,
}: {
  verification: UpgradeAnalysisVerification;
  onConfigureVerification: () => void;
}): ReactElement {
  return (
    <section className="analysis-card" aria-labelledby="removal-verification-heading">
      <h3 className="analysis-card__title" id="removal-verification-heading">
        <IconListChecks className="analysis-card__title-icon" />
        Verification steps
      </h3>
      <p className="usage-card__subtitle">We'll run these checks after removal.</p>
      <ul className="verification-steps">
        <li className="verification-steps__item">
          <span>Install dependencies</span>
          <span className="status-badge status-badge--neutral">Queued</span>
        </li>
        {verification.configured ? (
          verification.scriptNames.map((name) => (
            <li className="verification-steps__item" key={name}>
              <span>
                Run <code>{name}</code>
              </span>
              <span className="status-badge status-badge--neutral">Queued</span>
            </li>
          ))
        ) : (
          <li className="verification-steps__item">
            <span>Build / test verification</span>
            <span className="status-badge status-badge--warning">Not configured</span>
          </li>
        )}
      </ul>
      {!verification.configured ? (
        <button type="button" className="button button--secondary verification__configure" onClick={onConfigureVerification}>
          <IconGear />
          Configure verification
        </button>
      ) : null}
    </section>
  );
}

/** Composes existing host-owned preflight and impact results; it never re-derives transaction eligibility in the webview. */
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
      <div className="review-panel__empty review-panel__empty--remove">
        <span className="review-panel__empty-icon" aria-hidden="true">
          <IconTrash />
        </span>
        <h3 className="review-panel__empty-heading">Removal review</h3>
        <p className="review-panel__empty-status">Not analyzed yet</p>
        <button type="button" className="button review-panel__empty-cta" onClick={onAnalyzeRemoval}>
          Analyze removal →
        </button>
      </div>
    );
  }

  const impactEntry = removalImpact.phase === 'done' ? removalImpact.assessments.get(row.name) : undefined;
  const assessment = impactEntry?.assessment;
  const impactAnalyzing = removalImpact.phase === 'analyzing';

  if (analysis === null && removalImpact.phase === 'error') {
    return (
      <div className="review-panel removal-review">
        <section className="analysis-card removal-review__unknown" aria-label="Removal impact unknown">
          <OutcomeStatus
            label="Removal impact unknown"
            className="unknown"
            detail={removalImpact.message}
          />
          <button type="button" className="button button--secondary" onClick={onAnalyzeRemoval}>
            <IconRefresh />
            Re-run analysis
          </button>
        </section>
      </div>
    );
  }

  if (analysis === null || impactAnalyzing) {
    return (
      <div className="review-panel removal-review">
        <div className="analysis-loading removal-review__loading" role="status" aria-live="polite">
          <IconRefresh className="removal-review__loading-icon" aria-hidden="true" />
          <p className="analysis-loading__title">Analyzing removal impact…</p>
          <p className="analysis-loading__detail">
            {impactAnalyzing && removalImpact.total > 0
              ? `${removalImpact.scanned} of ${removalImpact.total} files checked`
              : 'Checking dependency relationships and transaction details…'}
          </p>
        </div>
      </div>
    );
  }

  const removalAllowed = assessment?.status === 'low-risk' || assessment?.status === 'review';
  const blocked = assessment?.status === 'blocked';

  return (
    <div className="review-panel removal-review">
      <div className="removal-tab">
        <div className="removal-tab__summary">
          <RemovalSummaryCard row={row} analysis={analysis} assessment={assessment} />
          <AtAGlanceCard row={row} analysis={analysis} assessment={assessment} usage={usage} />
          <RecommendedActionCard
            row={row}
            assessment={assessment}
            busy={busy}
            onConfirm={onConfirm}
            onViewReferences={onViewReferences}
          />
        </div>
        <div className="removal-tab__details">
          <DependencyCheckCard analysis={analysis} assessment={assessment} usage={usage} />
          <WhatWillBeRemovedCard row={row} analysis={analysis} />
          <ImpactAfterRemovalCard analysis={analysis} assessment={assessment} usage={usage} />
          <div className="removal-tab__bottom-grid">
            <FilesModifiedCard files={analysis.files} />
            <VerificationStepsCard verification={analysis.verification} onConfigureVerification={onConfigureVerification} />
          </div>
        </div>
      </div>

      <div className="review-panel__footer removal-review__footer">
        {analysis.files.rollbackAvailable ? (
          <p className="manage-modal__footer-note removal-review__rollback">
            <IconHistory className="manage-modal__footer-note-icon" aria-hidden="true" />
            <span>
              A restore point will be created before removing.
              <br />
              You can rollback if something goes wrong.
            </span>
          </p>
        ) : null}
        <button
          type="button"
          className="button button--danger removal-review__footer-action"
          onClick={onConfirm}
          disabled={busy || !removalAllowed}
          title={blocked ? 'Removal is blocked by a required peer dependency.' : !removalAllowed ? 'Removal impact must be known before proceeding.' : undefined}
        >
          <IconTrash aria-hidden="true" />
          {actionLabel(row.name, assessment)}
        </button>
      </div>
    </div>
  );
}
