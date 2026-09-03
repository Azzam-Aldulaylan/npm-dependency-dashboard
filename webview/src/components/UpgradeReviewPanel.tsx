import { memo } from 'react';
import type { ReactElement } from 'react';

import type { PackageRow, Severity } from '../../../src/core/types.js';
import { semanticButtonClassName, upgradeConfirmationAction } from '../../../src/host/actionButtonSemantics.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import type { UpgradeAnalysisSections as UpgradeAnalysisSectionsState } from '../../../src/host/upgradeAnalysisSections.js';
import { hasPlannerAddedCoordination, upgradeAnalysisFreshness } from '../../../src/host/upgradeReviewUiState.js';
import { deriveUpgradeReviewDecision } from '../../../src/host/upgradeReviewDecision.js';
import { summarizeProjectCompatibility } from '../../../src/host/projectCompatibilityUiState.js';
import { classifyUpdate } from '../../../src/host/updateClassification.js';
import { severityDisplay } from '../../../src/host/severityDisplay.js';
import { summarizeUpgradeSecurity } from '../../../src/host/upgradeSecuritySummary.js';
import { IconFile, IconRefresh, IconTrendUp } from '../icons.js';
import { DirectionalButton } from './DirectionalButton.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import {
  CompatibilityCheckCard,
  CoordinatedUpgradePlanCard,
  CoordinationUnavailableCard,
  SecurityOutcomeCard,
  SimpleUpgradePlanCard,
  VerificationStepsCard,
} from './UpgradeAnalysisCards.js';
import { UpgradeAnalysisSections } from './UpgradeAnalysisSections.js';
import { ProjectCompatibilitySection } from './ProjectCompatibilitySection.js';
import { StatusBanner } from './StatusBanner.js';
import { UpgradeTargetSelector } from './UpgradeTargetSelector.js';
import { UpgradeRecommendationCard } from './UpgradeRecommendationCard.js';
import type { UpgradeTargetLoadState } from './UpgradeTargetSelector.js';
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

function joinedReviewAreas(areas: readonly string[]): string {
  if (areas.length < 2) return areas[0] ?? 'the analysis details below';
  if (areas.length === 2) return `${areas[0]} and ${areas[1]}`;
  return `${areas.slice(0, -1).join(', ')}, and ${areas.at(-1)}`;
}

function upgradeReviewAreas(analysis: UpgradeAnalysisPresentation, coordinated: boolean): string[] {
  const areas: string[] = [];
  if (analysis.compatibility.status === 'conflict') {
    areas.push(coordinated ? 'the coordinated dependency changes' : 'the unresolved dependency conflict');
  } else if (analysis.compatibility.status === 'warning') {
    const count = analysis.compatibility.findings.length;
    areas.push(count > 0 ? `${count} dependency compatibility ${count === 1 ? 'warning' : 'warnings'}` : 'the dependency compatibility warnings');
  }
  if (analysis.compatibility.status === 'unknown' || analysis.compatibility.completeness !== 'complete') {
    areas.push('the incomplete dependency checks');
  }

  const projectSummary = summarizeProjectCompatibility(analysis.projectCompatibility);
  if (projectSummary.total > 0) {
    areas.push(`${projectSummary.total} project compatibility ${projectSummary.total === 1 ? 'finding' : 'findings'}`);
  }
  const applicableIncompleteAnalyzers = projectSummary.incompleteAnalyzers.filter((entry) => !(
    entry.reason === 'deprecated-api-rules-unavailable' && analysis.projectCompatibility.identity.packageName !== 'next'
  ));
  if (analysis.projectCompatibility.analyzers.length === 0) {
    areas.push('the missing project compatibility checks');
  } else if (applicableIncompleteAnalyzers.length > 0) {
    areas.push(`${applicableIncompleteAnalyzers.length} incomplete project ${applicableIncompleteAnalyzers.length === 1 ? 'check' : 'checks'}`);
  }

  if (analysis.security !== null) {
    const security = summarizeUpgradeSecurity(analysis.security);
    if (security.confirmedRemainingCount > 0) {
      areas.push(`${security.confirmedRemainingCount} ${security.confirmedRemainingCount === 1 ? 'vulnerability that remains' : 'vulnerabilities that remain'}`);
    }
    if (security.unknownCount > 0) {
      areas.push(`${security.unknownCount} undetermined security ${security.unknownCount === 1 ? 'outcome' : 'outcomes'}`);
    }
  }
  return areas;
}

/**
 * One scoped headline derived from dependency and project evidence, shared
 * with the recommendation and confirmation action.
 */
function UpgradeSummaryCard({ analysis }: { analysis: UpgradeAnalysisPresentation }): ReactElement {
  const { headline } = deriveUpgradeReviewDecision(analysis);
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
        <GlanceRow label="Target version">{analysis.targetVersion}</GlanceRow>
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
  advisoriesAvailable,
}: {
  row: PackageRow;
  analysis: UpgradeAnalysisPresentation;
  usage: UsageRequestState | undefined;
  advisoriesAvailable: boolean;
}): ReactElement {
  const needsAttention = row.worstSeverity === 'critical' || row.worstSeverity === 'high';

  return (
    <section className="analysis-card upgrade-at-a-glance" aria-labelledby="upgrade-at-a-glance-heading">
      <h3 className="manage-section-heading" id="upgrade-at-a-glance-heading">
        At a glance
      </h3>
      <dl className="manage-glance">
        <GlanceRow label="Vulnerabilities">
          {!advisoriesAvailable ? (
            'Unavailable'
          ) : row.advisories.length === 0 ? (
            'None'
          ) : (
            <span className={`status-badge status-badge--${needsAttention ? 'warning' : 'neutral'}`}>
              {row.advisories.length} {severityDisplay(row.worstSeverity).label}
            </span>
          )}
        </GlanceRow>
        <GlanceRow label="Usage">{usageAnalysisLabel(usage)}</GlanceRow>
        <GlanceRow label="Status">
          <span className={`status-badge status-badge--${needsAttention || !advisoriesAvailable ? 'warning' : 'neutral'}`}>
            {!advisoriesAvailable ? 'Data incomplete' : needsAttention ? 'Needs attention' : 'Looks fine'}
          </span>
        </GlanceRow>
      </dl>
    </section>
  );
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-1) ?? path;
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
      <p className="upgrade-preview__files">
        <IconFile aria-hidden="true" />
        <span>
          Will update <code>{baseName(analysis.files.manifestPath)}</code> and <code>{baseName(analysis.files.lockfilePath)}</code>
          {analysis.files.rollbackAvailable ? ' · Restore point included' : ''}
        </span>
      </p>
    </section>
  );
}

/**
 * This is the evidence-heavy half of a completed review. It does not depend
 * on the freshness clock, so memoizing it avoids reconciling compatibility
 * findings, vulnerability paths, and verification rows every minute while
 * the surrounding freshness/action chrome still updates normally.
 */
const UpgradeReviewDetails = memo(function UpgradeReviewDetails({
  row,
  analysis,
  coordinated,
  onChangeTab,
  onOpenAdvisory,
  onOpenUsageReference,
  onConfigureVerification,
}: {
  row: PackageRow;
  analysis: UpgradeAnalysisPresentation;
  coordinated: boolean;
  onChangeTab: (tab: ManageTabId) => void;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[], reference?: string) => void) | undefined;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
  onConfigureVerification: () => void;
}): ReactElement {
  return (
    <div className="upgrade-tab__details">
      <UpgradePreviewCard analysis={analysis} />
      <CompatibilityCheckCard compatibility={analysis.compatibility} projectCompatibility={analysis.projectCompatibility} />
      <ProjectCompatibilitySection analysis={analysis.projectCompatibility} onOpenUsageReference={onOpenUsageReference} />
      {analysis.smartPlan !== null && coordinated ? (
        <CoordinatedUpgradePlanCard
          requestedChanges={analysis.changes}
          smartPlan={analysis.smartPlan}
          compatibility={analysis.compatibility}
        />
      ) : analysis.compatibility.status === 'conflict' ? (
        <CoordinationUnavailableCard row={row} changes={analysis.changes} />
      ) : (
        <SimpleUpgradePlanCard row={row} changes={analysis.changes} />
      )}
      <SecurityOutcomeCard row={row} security={analysis.security} onChangeTab={onChangeTab} onOpenAdvisory={onOpenAdvisory} />
      <VerificationStepsCard verification={analysis.verification} onConfigureVerification={onConfigureVerification} />
    </div>
  );
});

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
  expiresAt,
  hardStale,
  now,
  onRefresh,
}: {
  analyzedAt: string;
  expiresAt: string;
  hardStale: boolean;
  now: number;
  onRefresh: () => void;
}): ReactElement | null {
  const freshness = upgradeAnalysisFreshness(analyzedAt, expiresAt, now);
  const expired = freshness === 'expired';
  if (freshness === 'fresh' && !hardStale) return null;
  return (
    <p className={`stale-status${hardStale || expired ? ' stale-status--hard' : ''}`}>
      <IconRefresh className="stale-status__icon stale-status__icon--static" />
      {hardStale
        ? 'Project files changed since this analysis ran. Refresh before continuing.'
        : expired
          ? 'This analysis expired and can no longer authorize an upgrade. Analyze again to continue.'
          : `Analysis is more than one hour old. Refresh is recommended; project files have not been marked as changed. Last analyzed ${formatUpgradeAnalysisAge(analyzedAt, now)}.`}
      <button type="button" className="button button--subtle stale-status__action" onClick={onRefresh}>
        {expired ? 'Analyze again' : 'Refresh'}
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
  targetState,
  analyzingPhase,
  analysis,
  sections,
  hardStale,
  now,
  busy,
  error,
  disabled,
  usage,
  advisoriesAvailable,
  onAnalyzeUpgrade,
  onTargetChange,
  onConfirm,
  onUseSmartPlan,
  onCancel,
  onConfigureVerification,
  onRefresh,
  onChangeTab,
  onOpenAdvisory,
  onOpenUsageReference,
}: {
  row: PackageRow;
  active: boolean;
  /** The upgrade target this row currently offers, or null when none is available. */
  targetVersion: string | null;
  targetState: UpgradeTargetLoadState;
  analyzingPhase: 'compatibility' | 'project-compatibility' | 'smart-plan' | null;
  analysis: UpgradeAnalysisPresentation | null;
  /** Per-section progressive state, rendered while `analysis` is still null — see src/host/upgradeAnalysisSections.ts. */
  sections: UpgradeAnalysisSectionsState;
  /** True when the host has flagged `analysis` as structurally stale — see UpgradeFreshnessBar. */
  hardStale: boolean;
  now: number;
  busy: boolean;
  error: string | null;
  disabled: boolean;
  usage: UsageRequestState | undefined;
  advisoriesAvailable: boolean;
  onAnalyzeUpgrade: (target: string) => void;
  onTargetChange: (target: string) => void;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
  onCancel: () => void;
  onConfigureVerification: () => void;
  onRefresh: () => void;
  onChangeTab: (tab: ManageTabId) => void;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[], reference?: string) => void) | undefined;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
}): ReactElement {
  const targetSelector = row.upgradeTo === null ? null : (
    <UpgradeTargetSelector
      state={targetState}
      selectedVersion={targetVersion}
      fallbackVersion={row.upgradeTo}
      disabled={busy || disabled}
      onChange={onTargetChange}
    />
  );
  const withTargetSelector = (content: ReactElement): ReactElement => (
    <div className="upgrade-review-stack">
      {targetSelector}
      {error !== null ? (
        <StatusBanner
          tone="error"
          className="upgrade-review__error"
          action={{
            label: 'Refresh data',
            onClick: onRefresh,
            disabled: busy || disabled,
            icon: <IconRefresh />,
          }}
        >
          {error}
        </StatusBanner>
      ) : null}
      {content}
    </div>
  );

  if (!active) {
    if (row.upgradeTo === null) {
      return withTargetSelector(
        <div className="review-panel__empty review-panel__empty--upgrade">
          <span className="review-panel__empty-icon" aria-hidden="true">
            <IconTrendUp />
          </span>
          <h3 className="review-panel__empty-heading">Upgrade review</h3>
          <p className="review-panel__empty-versions">{row.current ?? row.range}</p>
          <p className="review-panel__empty-status">No newer version is currently available for {row.name}.</p>
        </div>
      );
    }
    if (targetVersion === null) {
      return withTargetSelector(
        <div className="manage-panel-empty">
          <p>Choose a target version to continue.</p>
        </div>
      );
    }
    return withTargetSelector(
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
        <DirectionalButton
          direction="forward"
          className="button button--primary review-panel__empty-cta"
          disabled={busy || disabled || targetState.phase === 'loading'}
          onClick={() => onAnalyzeUpgrade(targetVersion)}
        >
          Analyze upgrade
        </DirectionalButton>
      </div>
    );
  }

  // An active request always records a concrete target before posting to the
  // host. This branch is defensive for an impossible state transition.
  if (targetVersion === null) {
    return withTargetSelector(
      <div className="manage-panel-empty">
        <p>Choose a target version and analyze again.</p>
      </div>
    );
  }

  if (analysis === null) {
    return withTargetSelector(
      <div className="review-panel">
        <UpgradeAnalysisSections
          row={row}
          targetVersion={targetVersion}
          sections={sections}
          onChangeTab={onChangeTab}
          onConfigureVerification={onConfigureVerification}
          onOpenAdvisory={onOpenAdvisory}
          onOpenUsageReference={onOpenUsageReference}
        />
      </div>
    );
  }

  const coordinated =
    analysis.smartPlan !== null && hasPlannerAddedCoordination(analysis.changes, analysis.smartPlan.changes);
  const expired = upgradeAnalysisFreshness(analysis.analyzedAt, analysis.expiresAt, now) === 'expired';
  const executionBlocked = hardStale || expired;
  const action = upgradeConfirmationAction(coordinated ? analysis : { ...analysis, smartPlan: null });
  const decision = deriveUpgradeReviewDecision(analysis, coordinated);
  const reviewAreas = upgradeReviewAreas(analysis, coordinated);

  return withTargetSelector(
    <div className="review-panel">
      <UpgradeFreshnessBar
        analyzedAt={analysis.analyzedAt}
        expiresAt={analysis.expiresAt}
        hardStale={hardStale}
        now={now}
        onRefresh={onRefresh}
      />
      {decision.caution ? (
        <StatusBanner tone="warning" className="upgrade-review__summary-banner">
          <strong>{decision.headline.label}.</strong> Review {joinedReviewAreas(reviewAreas)} before upgrading.
        </StatusBanner>
      ) : null}
      <div className="upgrade-tab">
        <div className="upgrade-tab__summary">
          <UpgradeSummaryCard analysis={analysis} />
          <AtAGlanceCard row={row} analysis={analysis} usage={usage} advisoriesAvailable={advisoriesAvailable} />
          <UpgradeRecommendationCard
            analysis={analysis}
            coordinated={coordinated}
            executionBlocked={executionBlocked}
            busy={busy}
            onConfirm={onConfirm}
            onUseSmartPlan={onUseSmartPlan}
          />
        </div>
        <UpgradeReviewDetails
          row={row}
          analysis={analysis}
          coordinated={coordinated}
          onChangeTab={onChangeTab}
          onOpenAdvisory={onOpenAdvisory}
          onOpenUsageReference={onOpenUsageReference}
          onConfigureVerification={onConfigureVerification}
        />
      </div>

      <div className="review-panel__footer">
        <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
          {analysis.compatibility.status === 'conflict' && !coordinated ? 'Close review' : 'Cancel analysis'}
        </button>
        {action !== null ? (
          <button
            type="button"
            className={semanticButtonClassName(action.variant)}
            onClick={action.onClick === 'confirm' ? onConfirm : onUseSmartPlan}
            disabled={busy || executionBlocked}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
