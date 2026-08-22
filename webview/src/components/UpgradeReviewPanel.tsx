import type { ReactElement } from 'react';

import type { PackageRow, Severity } from '../../../src/core/types.js';
import type {
  CompatibilityFindingKind,
  UpgradeAnalysisCompatibility,
  UpgradeAnalysisFiles,
  UpgradeAnalysisPresentation,
  UpgradeAnalysisVerification,
} from '../../../src/host/webviewProtocol.js';
import { compatibilityOutcomeDisplay, securityOutcomeDisplay, upgradeSafetyHeadline } from '../../../src/host/outcomeCopy.js';
import { classifyRowUpdate, classifyUpdate } from '../../../src/host/updateClassification.js';
import { severityDisplay } from '../../../src/host/severityDisplay.js';
import {
  IconAlertTriangle,
  IconCheck,
  IconFile,
  IconGear,
  IconHelpCircle,
  IconHistory,
  IconListChecks,
  IconRefresh,
  IconRoute,
  IconShield,
} from '../icons.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { SmartPlanSection } from './SmartPlanSection.js';
import { UpgradeAnalysisLoading } from './UpgradeAnalysisLoading.js';
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
  const before = security === null ? 0 : security.resolvedAdvisories.length + security.remaining.length;
  const remainingAfter = security === null ? [] : security.remaining.filter((entry) => entry.status === 'remains');
  const after = remainingAfter.length;
  const beforeWorst =
    security === null
      ? null
      : worstOf([...security.resolvedAdvisories.map((entry) => entry.advisory.severity), ...security.remaining.map((entry) => entry.advisory.severity)]);
  const afterWorst = worstOf(remainingAfter.map((entry) => entry.advisory.severity));

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
        {analysis.security !== null ? (
          <GlanceRow label="Vulnerabilities">
            <span className="upgrade-summary__before-after">
              {before} {beforeWorst !== null ? severityDisplay(beforeWorst).label : ''} <span aria-hidden="true">→</span> {after}
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
  const updateKind = classifyRowUpdate(row);
  const needsAttention = row.worstSeverity === 'critical' || row.worstSeverity === 'high';

  return (
    <section className="manage-summary-block" aria-labelledby="upgrade-at-a-glance-heading">
      <h3 className="manage-section-heading" id="upgrade-at-a-glance-heading">
        At a glance
      </h3>
      <dl className="manage-glance">
        <GlanceRow label="Installed version">{row.current ?? row.range}</GlanceRow>
        <GlanceRow label="Latest version">{row.latest ?? '—'}</GlanceRow>
        <GlanceRow label="Update available">
          {row.upgradeTo === null ? 'None' : updateKind !== null ? UPDATE_KIND_LABEL[updateKind] : 'Yes'}
        </GlanceRow>
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

function UpgradePreviewCard({
  analysis,
  busy,
  onReanalyze,
}: {
  analysis: UpgradeAnalysisPresentation;
  busy: boolean;
  onReanalyze: () => void;
}): ReactElement {
  const updateKind = classifyUpdate(analysis.currentVersion, analysis.targetVersion);

  return (
    <section className="analysis-card" aria-labelledby="upgrade-preview-heading">
      <div className="usage-card__head">
        <h3 className="analysis-card__title" id="upgrade-preview-heading">
          Upgrade preview
        </h3>
        <button type="button" className="button button--secondary" disabled={busy} onClick={onReanalyze}>
          <IconRefresh />
          Re-run preflight
        </button>
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

type CompatCheckTone = 'ok' | 'warn' | 'unknown';

function CompatCheckItem({ tone, label, value }: { tone: CompatCheckTone; label: string; value: string }): ReactElement {
  const icon = tone === 'ok' ? <IconCheck /> : tone === 'warn' ? <IconAlertTriangle /> : <IconHelpCircle />;
  return (
    <div className={`hygiene-strip__item${tone === 'warn' ? ' hygiene-strip__item--warn' : tone === 'unknown' ? ' hygiene-strip__item--unknown' : ''}`}>
      <span className="hygiene-strip__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="hygiene-strip__label">{label}</span>
      <span className="hygiene-strip__value">{value}</span>
    </div>
  );
}

const PEER_FINDING_KINDS: ReadonlySet<CompatibilityFindingKind> = new Set([
  'peer-compatible',
  'peer-incompatible',
  'peer-missing',
  'optional-peer-missing',
  'invalid-peer-range',
]);

/**
 * The 4-check compact grid. Only two of these four categories have a real
 * signal anywhere in this codebase today (peer dependencies, from
 * `compatibility.findings`; breaking changes, from the `major-version-change`
 * finding kind / `majorUpdate`) — engine-requirement and deprecated-API
 * detection do not exist in the analysis pipeline at all, so both render
 * "Not checked" rather than a fabricated "Compatible"/"None detected".
 */
function CompatibilityCheckCard({
  compatibility,
  majorUpdate,
}: {
  compatibility: UpgradeAnalysisCompatibility;
  majorUpdate: boolean;
}): ReactElement {
  const peerFindings = compatibility.findings.filter((finding) => PEER_FINDING_KINDS.has(finding.kind));
  const peerProblems = peerFindings.filter((finding) => finding.status !== 'compatible');
  const peerTone: CompatCheckTone = peerFindings.length === 0 ? 'unknown' : peerProblems.length > 0 ? 'warn' : 'ok';
  const peerValue =
    peerFindings.length === 0
      ? compatibility.completeness === 'partial'
        ? 'Unknown'
        : 'No peer dependencies'
      : peerProblems.length > 0
        ? `${peerProblems.length} conflict${peerProblems.length === 1 ? '' : 's'}`
        : 'No conflicts';

  const hasMajorFinding = compatibility.findings.some((finding) => finding.kind === 'major-version-change') || majorUpdate;

  return (
    <section className="analysis-card" aria-labelledby="upgrade-compat-heading">
      <h3 className="analysis-card__title" id="upgrade-compat-heading">
        <IconRoute className="analysis-card__title-icon" />
        Compatibility check
      </h3>
      <div className="hygiene-strip">
        <CompatCheckItem tone={peerTone} label="Peer dependencies" value={peerValue} />
        <CompatCheckItem tone="unknown" label="Engine requirements" value="Not checked" />
        <CompatCheckItem tone={hasMajorFinding ? 'warn' : 'ok'} label="Breaking changes" value={hasMajorFinding ? 'Major version change' : 'None detected'} />
        <CompatCheckItem tone="unknown" label="Deprecated APIs" value="Not checked" />
      </div>
    </section>
  );
}

/**
 * The plain, non-conflict case — every real proposed change (`analysis.changes`),
 * numbered, reusing the exact same `.smart-plan__*` markup SmartPlanSection
 * uses for the genuinely-coordinated-conflict case below. No risk/impact
 * score is shown: this codebase has no such rating anywhere in the upgrade
 * pipeline, so showing one would be invented, not derived.
 */
function SimpleUpgradePlanCard({ row, analysis }: { row: PackageRow; analysis: UpgradeAnalysisPresentation }): ReactElement {
  const steps = analysis.changes;
  return (
    <section className="analysis-card" aria-labelledby="upgrade-plan-heading">
      <h3 className="analysis-card__title" id="upgrade-plan-heading">
        Smart upgrade plan
      </h3>
      <p className="usage-card__subtitle">
        {steps.length} step{steps.length === 1 ? '' : 's'} to upgrade {row.name}
      </p>
      <ol className="smart-plan__changes">
        {steps.map((change) => (
          <li className="smart-plan__change" key={change.packageName}>
            <span className="smart-plan__package">
              Upgrade {change.packageName} from {change.currentVersion} → {change.targetVersion}
            </span>
            {change.majorUpdate ? <span className="status-badge status-badge--warning">Major update</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Before → after vulnerability counts, entirely from the host-computed
 * `SecurityOutcome` — never a second, webview-side security calculation.
 */
function SecurityOutcomeCard({
  row,
  security,
  onChangeTab,
}: {
  row: PackageRow;
  security: UpgradeAnalysisPresentation['security'];
  onChangeTab: (tab: ManageTabId) => void;
}): ReactElement | null {
  if (security === null || row.advisories.length === 0) return null;
  const before = severityDisplay(row.worstSeverity);
  const resolvedCount = security.resolvedAdvisories.length;
  const remainingCount = security.remaining.filter((entry) => entry.status === 'remains').length;
  const unknownCount = security.remaining.filter((entry) => entry.status === 'unknown').length;
  const after = securityOutcomeDisplay(security.status);
  const subtitle =
    security.status === 'resolved'
      ? 'This upgrade will improve your security posture.'
      : security.status === 'remains'
        ? resolvedCount > 0
          ? "This upgrade improves your security posture, but doesn't resolve every known vulnerability."
          : "This upgrade doesn't change your security posture."
        : 'The security outcome of this upgrade could not be fully verified.';

  return (
    <section className="analysis-card" aria-labelledby="upgrade-security-heading">
      <div className="usage-card__head">
        <h3 className="analysis-card__title" id="upgrade-security-heading">
          <IconShield className="analysis-card__title-icon" />
          Security outcome
        </h3>
        <button type="button" className="usage-show-all" onClick={() => onChangeTab('vulnerabilities')}>
          View vulnerabilities →
        </button>
      </div>
      <p className="usage-card__subtitle">{subtitle}</p>
      <div className="security-outcome">
        <div className="security-outcome__box">
          <p className="security-outcome__label">Before upgrade</p>
          <p className="security-outcome__value security-outcome__value--bad">
            {row.advisories.length} {before.label} vulnerabilit{row.advisories.length === 1 ? 'y' : 'ies'}
          </p>
          <p className="security-outcome__detail">Affecting {row.advisories.length} advisor{row.advisories.length === 1 ? 'y' : 'ies'}</p>
        </div>
        <span className="usage-path__arrow" aria-hidden="true">
          →
        </span>
        <div className="security-outcome__box">
          <p className="security-outcome__label">After upgrade</p>
          <p className={`security-outcome__value${remainingCount === 0 && unknownCount === 0 ? ' security-outcome__value--good' : ''}`}>
            {remainingCount} vulnerabilit{remainingCount === 1 ? 'y' : 'ies'}
            {unknownCount > 0 ? `, ${unknownCount} undetermined` : ''}
          </p>
          <p className="security-outcome__detail">{after.label}</p>
        </div>
      </div>
    </section>
  );
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-1) ?? path;
}

/** Only the manifest and lockfile — the only two files any upgrade transaction in this codebase ever modifies. Never a fabricated "+N more". */
function FilesModifiedCard({ files }: { files: UpgradeAnalysisFiles }): ReactElement {
  return (
    <section className="analysis-card" aria-labelledby="upgrade-files-heading">
      <h3 className="analysis-card__title" id="upgrade-files-heading">
        <IconFile className="analysis-card__title-icon" />
        Files to be modified
      </h3>
      <p className="usage-card__subtitle">This upgrade will modify the following files.</p>
      <ul className="usage-ref-list upgrade-files-list">
        <li className="usage-ref__button usage-ref__button--static upgrade-files-list__item">
          <IconFile className="usage-ref__icon" aria-hidden="true" />
          <span className="usage-ref__path">{baseName(files.manifestPath)}</span>
          <span className="status-badge status-badge--neutral">Modified</span>
        </li>
        <li className="usage-ref__button usage-ref__button--static upgrade-files-list__item">
          <IconFile className="usage-ref__icon" aria-hidden="true" />
          <span className="usage-ref__path">{baseName(files.lockfilePath)}</span>
          <span className="status-badge status-badge--neutral">Modified</span>
        </li>
      </ul>
    </section>
  );
}

/**
 * Verification steps, entirely from `UpgradeAnalysisVerification` — install
 * is the one step every upgrade transaction always runs; each configured
 * script name gets its own step, in its own words (never remapped to a
 * generic "Build project"/"Run tests" label the actual script might not
 * match). All shown as `Queued` — this is the pre-execution preview, before
 * the transaction has started.
 */
function VerificationStepsCard({
  verification,
  onConfigureVerification,
}: {
  verification: UpgradeAnalysisVerification;
  onConfigureVerification: () => void;
}): ReactElement {
  return (
    <section className="analysis-card" aria-labelledby="upgrade-verification-heading">
      <h3 className="analysis-card__title" id="upgrade-verification-heading">
        <IconListChecks className="analysis-card__title-icon" />
        Verification steps
      </h3>
      <p className="usage-card__subtitle">We'll run these checks after upgrading.</p>
      <ul className="verification-steps">
        <li className="verification-steps__item">
          <span>Install dependencies</span>
          <span className="status-badge status-badge--neutral">Queued</span>
        </li>
        {verification.configured
          ? verification.scriptNames.map((name) => (
              <li className="verification-steps__item" key={name}>
                <span>
                  Run <code>{name}</code>
                </span>
                <span className="status-badge status-badge--neutral">Queued</span>
              </li>
            ))
          : (
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
  busy,
  usage,
  onAnalyzeUpgrade,
  onConfirm,
  onUseSmartPlan,
  onCancel,
  onConfigureVerification,
  onChangeTab,
}: {
  row: PackageRow;
  active: boolean;
  /** The upgrade target this row currently offers, or null when none is available. */
  targetVersion: string | null;
  analyzingPhase: 'compatibility' | 'smart-plan' | null;
  analysis: UpgradeAnalysisPresentation | null;
  busy: boolean;
  usage: UsageRequestState | undefined;
  onAnalyzeUpgrade: (target: string) => void;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
  onCancel: () => void;
  onConfigureVerification: () => void;
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

  if (analysis === null) {
    return (
      <div className="review-panel">
        <UpgradeAnalysisLoading packageName={row.name} targetVersion={targetVersion} phase={analyzingPhase} />
      </div>
    );
  }

  const action = primaryAction(analysis);

  return (
    <div className="review-panel">
      <div className="upgrade-tab">
        <div className="upgrade-tab__summary">
          <UpgradeSummaryCard analysis={analysis} />
          <AtAGlanceCard row={row} analysis={analysis} usage={usage} />
          <RecommendedActionCard analysis={analysis} busy={busy} onConfirm={onConfirm} onUseSmartPlan={onUseSmartPlan} />
        </div>
        <div className="upgrade-tab__details">
          <UpgradePreviewCard analysis={analysis} busy={busy} onReanalyze={() => onAnalyzeUpgrade(targetVersion)} />
          <CompatibilityCheckCard compatibility={analysis.compatibility} majorUpdate={analysis.majorUpdate} />
          {analysis.smartPlan !== null ? <SmartPlanSection smartPlan={analysis.smartPlan} /> : <SimpleUpgradePlanCard row={row} analysis={analysis} />}
          <SecurityOutcomeCard row={row} security={analysis.security} onChangeTab={onChangeTab} />
          <FilesModifiedCard files={analysis.files} />
          <VerificationStepsCard verification={analysis.verification} onConfigureVerification={onConfigureVerification} />
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
            disabled={busy}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
