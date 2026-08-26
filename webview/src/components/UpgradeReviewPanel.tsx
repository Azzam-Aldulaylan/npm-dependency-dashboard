import type { ReactElement } from 'react';

import type { PackageRow, Severity } from '../../../src/core/types.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import type { UpgradeAnalysisSections as UpgradeAnalysisSectionsState } from '../../../src/host/upgradeAnalysisSections.js';
import { isUpgradeAnalysisSoftStale } from '../../../src/host/upgradeFreshness.js';
import { compatibilityOutcomeDisplay, upgradeSafetyHeadline } from '../../../src/host/outcomeCopy.js';
import { classifyUpdate } from '../../../src/host/updateClassification.js';
import { severityDisplay } from '../../../src/host/severityDisplay.js';
import { summarizeUpgradeSecurity } from '../../../src/host/upgradeSecuritySummary.js';
import { IconHistory, IconRefresh, IconTrendUp } from '../icons.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { SmartPlanSection } from './SmartPlanSection.js';
import {
  CompatibilityCheckCard,
  FilesModifiedCard,
  SecurityOutcomeCard,
  SimpleUpgradePlanCard,
  VerificationStepsCard,
} from './UpgradeAnalysisCards.js';
import { UpgradeAnalysisSections } from './UpgradeAnalysisSections.js';
import { primaryAction } from './UpgradeAnalysisModal.js';
import type { UsageRequestState } from './UsageReferencesPanel.js';

const UPDATE_KIND_LABEL: Record<'major' | 'minor' | 'patch', string> = {
  major: 'Major',
  minor: 'Minor',
  patch: 'Patch',
};

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'info'];

/** Worst-first pick among a set of severities — same rank as severityDisplay.ts's own, kept local since the inputs here (a mix of resolved advisories and still-remaining ones) don't share one common type to sort with sortAdvisoriesBySeverity directly. */
function worstOf(severities: readonly Severity[]): Severity | null {
  for (const severity of SEVERITY_ORDER) {
    if (severities.includes(severity)) return severity;
  }
  return null;
}

/** A compact "label / value" row — same shape used across every tab in this workspace. */
function GlanceRow({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="manage-glance__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function usageAnalysisLabel(usage: UsageRequestState | undefined): string {
  if (usage === undefined || usage.phase === 'analyzing') return 'Checking usage…';
  if (usage.phase === 'error') return 'Usage check failed';
  const count = usage.result.references.length;
  return count === 0 ? 'No references found' : `Used in ${count} file${count === 1 ? '' : 's'}`;
}

/**
 * Upgrade Summary — the one headline card: is this safe, what changes, and
 * what it does to this row's own known vulnerabilities. `upgradeSafetyHeadline`
 * is the exact same `compatibility.status` every other card reads; never a
 * second, independently-computed safety judgment.
 */
function UpgradeSummaryCard({ analysis }: { analysis: UpgradeAnalysisPresentation }): ReactElement {
  const headline = upgradeSafetyHeadline(analysis.compatibility.status);
  const updateKind = classifyUpdate(analysis.currentVersion, analysis.targetVersion);
  const security = analysis.security;
  const securitySummary = security === null ? null : summarizeUpgradeSecurity(security);
  const remainingAfter = security === null ? [] : security.remaining.filter((entry) => entry.status === 'remains');
  const beforeWorst =
    security === null
      ? null
      : worstOf([...security.resolvedAdvisories.map((entry) => entry.advisory.severity), ...security.remaining.map((entry) => entry.advisory.severity)]);
  // Do not attach a severity from only the proven-remains subset when another
  // unresolved advisory is undetermined (and might be more severe).
  const afterWorst = securitySummary !== null && securitySummary.unknownCount === 0 ? worstOf(remainingAfter.map((entry) => entry.advisory.severity)) : null;

  return (
    <section className="analysis-card" aria-labelledby="upgrade-summary-heading">
      <h3 className="manage-section-heading" id="upgrade-summary-heading">
        Upgrade summary
      </h3>
      <OutcomeStatus label={headline.label} className={headline.className} />
      <dl className="manage-glance">
        <GlanceRow label="Current version">{analysis.currentVersion}</GlanceRow>
        <GlanceRow label="Latest version">{analysis.targetVersion}</GlanceRow>
        <GlanceRow label="Update type">
          <span className="status-badge status-badge--neutral">{updateKind !== null ? UPDATE_KIND_LABEL[updateKind] : 'Unknown'}</span>
        </GlanceRow>
        {securitySummary !== null ? (
          <GlanceRow label="Vulnerabilities">
            <span className="upgrade-summary__before-after">
              {securitySummary.beforeCount} {beforeWorst !== null ? severityDisplay(beforeWorst).label : ''} <span aria-hidden="true">→</span>{' '}
              {securitySummary.afterLabel}
              {afterWorst !== null ? ` ${severityDisplay(afterWorst).label}` : ''}
            </span>
          </GlanceRow>
        ) : null}
      </dl>
    </section>
  );
}

function AtAGlanceCard({
  row,
  analysis,
  usage,
}: {
  row: PackageRow;
  analysis: UpgradeAnalysisPresentation;
  usage: UsageRequestState | undefined;
}): ReactElement {
  const needsAttention = row.worstSeverity === 'critical' || row.worstSeverity === 'high';

  return (
    <section className="analysis-card upgrade-at-a-glance" aria-labelledby="upgrade-at-a-glance-heading">
      <h3 className="manage-section-heading" id="upgrade-at-a-glance-heading">
        At a glance
      </h3>
      <dl className="manage-glance">
        <GlanceRow label="Vulnerabilities">
          {row.advisories.length === 0 ? (
            'None'
          ) : (
            <span className={`status-badge status-badge--${needsAttention ? 'warning' : 'neutral'}`}>
              {row.advisories.length} {severityDisplay(row.worstSeverity).label}
            </span>
          )}
        </GlanceRow>
        <GlanceRow label="Usage">{usageAnalysisLabel(usage)}</GlanceRow>
        <GlanceRow label="Status">
          <span className={`status-badge status-badge--${needsAttention ? 'warning' : 'neutral'}`}>
            {needsAttention ? 'Needs attention' : 'Looks fine'}
          </span>
        </GlanceRow>
      </dl>
    </section>
  );
}

/**
 * Recommended action — one sentence composed from the exact same
 * compatibility/security detail every other card already derives (see
 * overallStatusDetail/overallDetail), never a new independent judgment.
 */
function RecommendedActionCard({
  analysis,
  busy,
  onConfirm,
  onUseSmartPlan,
}: {
  analysis: UpgradeAnalysisPresentation;
  busy: boolean;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
}): ReactElement {
  const action = primaryAction(analysis);
  const compatDetail = compatibilityOutcomeDisplay(analysis.compatibility.status).label;
  const security = analysis.security;
  const resolvedCount = security?.resolvedAdvisories.length ?? 0;
  const remainingCount = security?.remaining.filter((entry) => entry.status === 'remains').length ?? 0;
  const resolvedWorst = security !== null ? worstOf(security.resolvedAdvisories.map((entry) => entry.advisory.severity)) : null;

  let message: string;
  if (analysis.compatibility.status === 'conflict') {
    message =
      analysis.smartPlan !== null
        ? `${compatDetail} — a coordinated upgrade resolves it.`
        : `${compatDetail}. No safe path is currently available.`;
  } else {
    const safe = analysis.compatibility.status === 'compatible' ? 'safe' : 'compatible';
    if (security === null) {
      message = `This is a ${safe} update.`;
    } else if (security.status === 'resolved') {
      const severityPrefix = resolvedWorst !== null ? `${severityDisplay(resolvedWorst).label.toLowerCase()} severity ` : '';
      message = `This is a ${safe} update that fixes ${resolvedCount} ${severityPrefix}vulnerabilit${resolvedCount === 1 ? 'y' : 'ies'}.`;
    } else if (security.status === 'remains') {
      message =
        resolvedCount > 0
          ? `This update fixes ${resolvedCount} vulnerabilit${resolvedCount === 1 ? 'y' : 'ies'}, but ${remainingCount} remain${remainingCount === 1 ? 's' : ''}. Review Security outcome before proceeding.`
          : `This update does not resolve the ${remainingCount} known vulnerabilit${remainingCount === 1 ? 'y' : 'ies'} — review Security outcome before proceeding.`;
    } else {
      message = `This is a ${safe} update. Some vulnerabilities could not be confirmed as fixed or remaining.`;
    }
  }

  return (
    <section className="vuln-recommended" aria-labelledby="upgrade-recommended-heading">
      <h3 className="manage-section-heading" id="upgrade-recommended-heading">
        Recommended action
      </h3>
      <p className="vuln-recommended__message">{message}</p>
      {action !== null ? (
        <button
          type="button"
          className="button vuln-recommended__cta upgrade-recommended__cta"
          disabled={busy}
          onClick={action.onClick === 'confirm' ? onConfirm : onUseSmartPlan}
        >
          Proceed with upgrade →
        </button>
      ) : null}
    </section>
  );
}

function UpgradePreviewCard({ analysis }: { analysis: UpgradeAnalysisPresentation }): ReactElement {
  const updateKind = classifyUpdate(analysis.currentVersion, analysis.targetVersion);

  return (
    <section className="analysis-card" aria-labelledby="upgrade-preview-heading">
      <div className="usage-card__head">
        <h3 className="analysis-card__title" id="upgrade-preview-heading">
          Upgrade preview
        </h3>
      </div>
      <div className="manage-action-card__versions upgrade-preview__versions">
        <span className="manage-action-card__version">{analysis.currentVersion}</span>
        <span className="manage-action-card__version-arrow" aria-hidden="true">
          →
        </span>
        <span className="manage-action-card__version manage-action-card__version--target">{analysis.targetVersion}</span>
        {updateKind !== null ? <span className="status-badge status-badge--neutral">{UPDATE_KIND_LABEL[updateKind]} update</span> : null}
      </div>
    </section>
  );
}

function formatUpgradeAnalysisAge(analyzedAt: string, now: number): string {
  const timestamp = Date.parse(analyzedAt);
  if (!Number.isFinite(timestamp)) return 'previously';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ago`;
}

/**
 * Soft (time-based, ~1hr) vs hard (structural — the project changed since
 * this analysis ran) freshness for the analysis currently on screen. The
 * soft case reuses the dashboard's own `.stale-status` tone verbatim
 * (non-alarming, matching App.tsx's whole-scan revalidation banner); the
 * hard case gets a `.stale-status--hard` warning tone and also disables
 * Confirm/Use-smart-plan (see the primary action button below) — pure time
 * passing never does that on its own. Refresh is not a new mechanism: it
 * simply re-runs analysis (Cancel + Analyze) — the host's own STALE_SOURCE
 * recheck at confirm time remains the sole authority regardless of what
 * this bar shows.
 */
function UpgradeFreshnessBar({
  analyzedAt,
  hardStale,
  now,
  onRefresh,
}: {
  analyzedAt: string;
  hardStale: boolean;
  now: number;
  onRefresh: () => void;
}): ReactElement | null {
  const softStale = isUpgradeAnalysisSoftStale(analyzedAt, now);
  if (!softStale && !hardStale) return null;
  return (
    <p className={`stale-status${hardStale ? ' stale-status--hard' : ''}`}>
      <IconRefresh className="stale-status__icon stale-status__icon--static" />
      {hardStale
        ? 'Project files changed since this analysis ran. Refresh before continuing.'
        : `Dependency data may be out of date. Last analyzed ${formatUpgradeAnalysisAge(analyzedAt, now)}.`}
      <button type="button" className="button button--subtle stale-status__action" onClick={onRefresh}>
        Refresh
      </button>
    </p>
  );
}

/**
 * The Upgrade review tab — the exact same review/confirm experience
 * UpgradeAnalysisModal renders for a bulk upgrade, but laid out as this
 * workspace's own Upgrade Summary / At a glance / Recommended action rail
 * beside a full preview on the right, instead of reusing that modal's own
 * card grid verbatim (see UpgradeAnalysisBody for the shared body still used
 * by the bulk-upgrade modal — deliberately untouched by this redesign).
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
  sections,
  hardStale,
  now,
  busy,
  usage,
  onAnalyzeUpgrade,
  onConfirm,
  onUseSmartPlan,
  onCancel,
  onConfigureVerification,
  onRefresh,
  onChangeTab,
}: {
  row: PackageRow;
  active: boolean;
  /** The upgrade target this row currently offers, or null when none is available. */
  targetVersion: string | null;
  analyzingPhase: 'compatibility' | 'smart-plan' | null;
  analysis: UpgradeAnalysisPresentation | null;
  /** Per-section progressive state, rendered while `analysis` is still null — see src/host/upgradeAnalysisSections.ts. */
  sections: UpgradeAnalysisSectionsState;
  /** True when the host has flagged `analysis` as structurally stale — see UpgradeFreshnessBar. */
  hardStale: boolean;
  now: number;
  busy: boolean;
  usage: UsageRequestState | undefined;
  onAnalyzeUpgrade: (target: string) => void;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
  onCancel: () => void;
  onConfigureVerification: () => void;
  onRefresh: () => void;
  onChangeTab: (tab: ManageTabId) => void;
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
      <div className="review-panel__empty review-panel__empty--upgrade">
        <span className="review-panel__empty-icon" aria-hidden="true">
          <IconTrendUp />
        </span>
        <h3 className="review-panel__empty-heading">Upgrade review</h3>
        <p className="review-panel__empty-versions">
          {row.current ?? row.range}
          <span aria-hidden="true"> → </span>
          {targetVersion}
        </p>
        <p className="review-panel__empty-status">Not analyzed yet</p>
        <button type="button" className="button review-panel__empty-cta" onClick={() => onAnalyzeUpgrade(targetVersion)}>
          Analyze upgrade →
        </button>
      </div>
    );
  }

  if (analysis === null) {
    return (
      <div className="review-panel">
        <UpgradeAnalysisSections
          row={row}
          targetVersion={targetVersion}
          sections={sections}
          onChangeTab={onChangeTab}
          onConfigureVerification={onConfigureVerification}
        />
      </div>
    );
  }

  const action = primaryAction(analysis);

  return (
    <div className="review-panel">
      <UpgradeFreshnessBar analyzedAt={analysis.analyzedAt} hardStale={hardStale} now={now} onRefresh={onRefresh} />
      <div className="upgrade-tab">
        <div className="upgrade-tab__summary">
          <UpgradeSummaryCard analysis={analysis} />
          <AtAGlanceCard row={row} analysis={analysis} usage={usage} />
          <RecommendedActionCard analysis={analysis} busy={busy} onConfirm={onConfirm} onUseSmartPlan={onUseSmartPlan} />
        </div>
        <div className="upgrade-tab__details">
          <UpgradePreviewCard analysis={analysis} />
          <CompatibilityCheckCard compatibility={analysis.compatibility} majorUpdate={analysis.majorUpdate} />
          {analysis.smartPlan !== null ? <SmartPlanSection smartPlan={analysis.smartPlan} /> : <SimpleUpgradePlanCard row={row} changes={analysis.changes} />}
          <SecurityOutcomeCard row={row} security={analysis.security} onChangeTab={onChangeTab} />
          <div className="upgrade-tab__bottom-grid">
            <FilesModifiedCard files={analysis.files} />
            <VerificationStepsCard verification={analysis.verification} onConfigureVerification={onConfigureVerification} />
          </div>
        </div>
      </div>

      <div className="review-panel__footer">
        {analysis.files.rollbackAvailable ? (
          <p className="manage-modal__footer-note">
            <IconHistory className="manage-modal__footer-note-icon" aria-hidden="true" />
            A restore point will be created before upgrading. You can roll back if something goes wrong.
          </p>
        ) : null}
        <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
          {analysis.compatibility.status === 'conflict' && analysis.smartPlan === null ? 'Close review' : 'Cancel analysis'}
        </button>
        {action !== null ? (
          <button
            type="button"
            className={`button${analysis.compatibility.status === 'warning' || analysis.compatibility.status === 'unknown' ? ' button--subtle' : ''}`}
            onClick={action.onClick === 'confirm' ? onConfirm : onUseSmartPlan}
            disabled={busy || hardStale}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
