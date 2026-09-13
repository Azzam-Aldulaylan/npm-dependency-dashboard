import { memo, useRef } from 'react';
import type { ReactElement, RefObject } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import { semanticButtonClassName, upgradeConfirmationAction } from '../../../src/host/actionButtonSemantics.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import type { UpgradeAnalysisSections as UpgradeAnalysisSectionsState } from '../../../src/host/upgradeAnalysisSections.js';
import { hasPlannerAddedCoordination, upgradeAnalysisFreshness } from '../../../src/host/upgradeReviewUiState.js';
import { deriveUpgradeReviewDecision } from '../../../src/host/upgradeReviewDecision.js';
import { summarizeProjectCompatibility } from '../../../src/host/projectCompatibilityUiState.js';
import { classifyUpdate } from '../../../src/host/updateClassification.js';
import { summarizeUpgradeSecurity } from '../../../src/host/upgradeSecuritySummary.js';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconFile,
  IconHelpCircle,
  IconListChecks,
  IconRefresh,
  IconRoute,
  IconShield,
  IconTrendUp,
  IconXCircle,
} from '../icons.js';
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
import { buildUpgradeReviewSignals, UpgradeAnalysisSections, UpgradeReviewDisclosure } from './UpgradeAnalysisSections.js';
import type { UpgradeReviewArea, UpgradeReviewSignal, UpgradeReviewTone as ReviewTone } from './UpgradeAnalysisSections.js';
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
    const count = analysis.compatibility.findings.filter((finding) => finding.status !== 'compatible').length;
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

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-1) ?? path;
}

function iconForReviewSignal(area: UpgradeReviewSignal['area'], tone: ReviewTone): ReactElement {
  if (area === 'security') return <IconShield />;
  if (area === 'verification') return <IconListChecks />;
  if (tone === 'error') return <IconXCircle />;
  if (tone === 'warning') return <IconAlertTriangle />;
  if (tone === 'unknown') return <IconHelpCircle />;
  return area === 'dependency' ? <IconRoute /> : <IconCheck />;
}

function UpgradeReviewSignalRow({ signal, onOpen }: {
  signal: UpgradeReviewSignal;
  onOpen: (area: UpgradeReviewArea) => void;
}): ReactElement {
  const content = (
    <>
      <span className="upgrade-decision__signal-icon" aria-hidden="true">{iconForReviewSignal(signal.area, signal.tone)}</span>
      <span className="upgrade-decision__signal-label">{signal.label}</span>
      <span className="upgrade-decision__signal-value">{signal.value}</span>
      <IconChevronRight className="upgrade-decision__signal-arrow" />
    </>
  );
  return (
    <li className={`upgrade-decision__signal upgrade-decision__signal--${signal.tone}`}>
      <button type="button" onClick={() => onOpen(signal.area)} aria-label={`${signal.label}: ${signal.value}. View details`}>
        {content}
      </button>
    </li>
  );
}

function UpgradeDecisionBrief({
  row,
  analysis,
  coordinated,
  signals,
  usage,
  onOpenArea,
}: {
  row: PackageRow;
  analysis: UpgradeAnalysisPresentation;
  coordinated: boolean;
  signals: readonly UpgradeReviewSignal[];
  usage: UsageRequestState | undefined;
  onOpenArea: (area: UpgradeReviewArea) => void;
}): ReactElement {
  const decision = deriveUpgradeReviewDecision(analysis, coordinated);
  const updateKind = classifyUpdate(analysis.currentVersion, analysis.targetVersion);
  const reviewAreas = upgradeReviewAreas(analysis, coordinated);
  const signalsNeedingReview = signals.filter((signal) => signal.needsReview);
  const firstReviewSignal = signalsNeedingReview[0];

  return (
    <section className={`upgrade-decision upgrade-decision--${decision.headline.className}`} aria-labelledby="upgrade-decision-heading">
      <div className="upgrade-decision__lead">
        <OutcomeStatus label={decision.headline.label} className={decision.headline.className} size="large" />
        <h3 id="upgrade-decision-heading">Upgrade {row.name}</h3>
        <div className="upgrade-decision__versions">
          <code>{analysis.currentVersion}</code>
          <span aria-hidden="true">→</span>
          <code>{analysis.targetVersion}</code>
          <span className="status-badge status-badge--neutral">{updateKind !== null ? UPDATE_KIND_LABEL[updateKind] : 'Unknown'} update</span>
        </div>
        <p className="upgrade-decision__reason">
          {decision.caution
            ? `Review ${joinedReviewAreas(reviewAreas)} before upgrading.`
            : 'No issues were found in completed checks. Run verification after upgrading.'}
        </p>
        {decision.caution && firstReviewSignal !== undefined ? (
          <button type="button" className="button button--secondary upgrade-decision__review" onClick={() => onOpenArea(firstReviewSignal.area)}>
            Start with {firstReviewSignal.label}
            <IconChevronRight />
          </button>
        ) : null}
        <div className="upgrade-decision__context">
          <span><IconFile /> {usageAnalysisLabel(usage)}</span>
          <span>
            Will update <code>{baseName(analysis.files.manifestPath)}</code> and <code>{baseName(analysis.files.lockfilePath)}</code>
            {analysis.files.rollbackAvailable ? ' · Restore point included' : ''}
          </span>
        </div>
      </div>
      <ul className="upgrade-decision__signals" aria-label="Upgrade review status">
        {signals.map((signal) => <UpgradeReviewSignalRow signal={signal} onOpen={onOpenArea} key={signal.area} />)}
      </ul>
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
  signals,
  sectionRefs,
  onChangeTab,
  onOpenAdvisory,
  onOpenUsageReference,
  onConfigureVerification,
}: {
  row: PackageRow;
  analysis: UpgradeAnalysisPresentation;
  coordinated: boolean;
  signals: readonly UpgradeReviewSignal[];
  sectionRefs: Readonly<Record<UpgradeReviewArea, RefObject<HTMLDetailsElement | null>>>;
  onChangeTab: (tab: ManageTabId) => void;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[], reference?: string) => void) | undefined;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
  onConfigureVerification: () => void;
}): ReactElement {
  const signal = (area: UpgradeReviewSignal['area']): UpgradeReviewSignal => {
    const match = signals.find((entry) => entry.area === area);
    if (match === undefined) throw new Error(`Missing upgrade review signal for ${area}`);
    return match;
  };
  const openProjectDetails = (): void => {
    const section = sectionRefs.project.current;
    if (section === null) return;
    section.open = true;
    requestAnimationFrame(() => {
      section.scrollIntoView({ block: 'start' });
      section.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    });
  };
  const dependency = signal('dependency');
  const project = signal('project');
  const security = signal('security');
  const verification = signal('verification');
  const planTone: ReviewTone = analysis.compatibility.status === 'conflict' && !coordinated
    ? 'error'
    : coordinated
      ? 'warning'
      : 'neutral';
  const planValue = coordinated
    ? `${analysis.smartPlan?.changes.length ?? analysis.changes.length} coordinated ${analysis.smartPlan?.changes.length === 1 ? 'change' : 'changes'}`
    : analysis.compatibility.status === 'conflict'
      ? 'No coordinated resolution'
      : `${analysis.changes.length} selected ${analysis.changes.length === 1 ? 'change' : 'changes'}`;

  return (
    <div className="upgrade-tab__details">
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.dependency}
        label={dependency.label}
        value={dependency.value}
        tone={dependency.tone}
      >
        <CompatibilityCheckCard
          compatibility={analysis.compatibility}
          projectCompatibility={analysis.projectCompatibility}
          context={{ package: row.name, currentVersion: analysis.currentVersion }}
          onViewProjectDetails={openProjectDetails}
        />
      </UpgradeReviewDisclosure>
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.project}
        label={project.label}
        value={project.value}
        tone={project.tone}
      >
        <ProjectCompatibilitySection analysis={analysis.projectCompatibility} onOpenUsageReference={onOpenUsageReference} />
      </UpgradeReviewDisclosure>
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.security}
        label={security.label}
        value={security.value}
        tone={security.tone}
      >
        {analysis.security !== null ? (
          <SecurityOutcomeCard row={row} security={analysis.security} onChangeTab={onChangeTab} onOpenAdvisory={onOpenAdvisory} />
        ) : (
          <p className="usage-card__subtitle">Security impact was not assessed for this review. Check the Vulnerabilities tab before upgrading.</p>
        )}
      </UpgradeReviewDisclosure>
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.plan}
        label="Planned dependency changes"
        value={planValue}
        tone={planTone}
      >
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
      </UpgradeReviewDisclosure>
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.verification}
        label={verification.label}
        value={verification.value}
        tone={verification.tone}
      >
        <VerificationStepsCard verification={analysis.verification} onConfigureVerification={onConfigureVerification} />
      </UpgradeReviewDisclosure>
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
 * The Upgrade review tab — the same host-owned review/confirm experience
 * UpgradeAnalysisModal renders for a bulk upgrade, presented here as a
 * decision brief followed by prioritized evidence and recommendation guidance.
 * UpgradeAnalysisBody remains the shared body used by the bulk-upgrade modal.
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
  const dependencyRef = useRef<HTMLDetailsElement>(null);
  const projectRef = useRef<HTMLDetailsElement>(null);
  const securityRef = useRef<HTMLDetailsElement>(null);
  const planRef = useRef<HTMLDetailsElement>(null);
  const verificationRef = useRef<HTMLDetailsElement>(null);
  const sectionRefs: Readonly<Record<UpgradeReviewArea, RefObject<HTMLDetailsElement | null>>> = {
    dependency: dependencyRef,
    project: projectRef,
    security: securityRef,
    plan: planRef,
    verification: verificationRef,
  };
  const openReviewArea = (area: UpgradeReviewArea): void => {
    const section = sectionRefs[area].current;
    if (section === null) return;
    section.open = true;
    requestAnimationFrame(() => {
      section.scrollIntoView({ block: 'start' });
      section.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    });
  };
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
              advisoriesAvailable={advisoriesAvailable}
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
  const signals = buildUpgradeReviewSignals(analysis, advisoriesAvailable);

  return withTargetSelector(
    <div className="review-panel">
      <UpgradeFreshnessBar
        analyzedAt={analysis.analyzedAt}
        expiresAt={analysis.expiresAt}
        hardStale={hardStale}
        now={now}
        onRefresh={onRefresh}
      />
      <UpgradeDecisionBrief
        row={row}
        analysis={analysis}
        coordinated={coordinated}
        signals={signals}
        usage={usage}
        onOpenArea={openReviewArea}
      />
      <div className="upgrade-tab">
        <UpgradeReviewDetails
          row={row}
          analysis={analysis}
          coordinated={coordinated}
          signals={signals}
          sectionRefs={sectionRefs}
          onChangeTab={onChangeTab}
          onOpenAdvisory={onOpenAdvisory}
          onOpenUsageReference={onOpenUsageReference}
          onConfigureVerification={onConfigureVerification}
        />
        <div className="upgrade-tab__recommendation">
          <UpgradeRecommendationCard
            analysis={analysis}
            coordinated={coordinated}
          />
        </div>
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
