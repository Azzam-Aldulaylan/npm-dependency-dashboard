import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type {
  CompatibilityFindingKind,
  UpgradeAnalysisFiles,
  UpgradeAnalysisPresentation,
  UpgradeAnalysisVerification,
} from '../../../src/host/webviewProtocol.js';
import { compatibilityOutcomeDisplay, securityOutcomeDisplay } from '../../../src/host/outcomeCopy.js';
import { severityDisplay } from '../../../src/host/severityDisplay.js';
import { IconAlertTriangle, IconCheck, IconFile, IconGear, IconHelpCircle, IconListChecks, IconRoute, IconShield } from '../icons.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { overallStatusDetail } from './UpgradeAnalysisModal.js';

/**
 * The five Upgrade review cards shared between the fully-populated review
 * (UpgradeReviewPanel.tsx) and the progressive per-section loading view
 * (UpgradeAnalysisSections.tsx) — each takes only the narrow slice of data
 * it actually renders (not the whole `UpgradeAnalysisPresentation`) so
 * either caller can feed it a section's data as soon as that section alone
 * is ready. Lives in its own module, not either caller's own file, so the
 * two don't import from each other.
 */

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
export function CompatibilityCheckCard({
  compatibility,
  majorUpdate,
}: {
  compatibility: UpgradeAnalysisPresentation['compatibility'];
  majorUpdate: boolean;
}): ReactElement {
  const summary = overallStatusDetail({ compatibility });
  const summaryTone = compatibilityOutcomeDisplay(compatibility.status).className;
  const peerFindings = compatibility.findings.filter((finding) => PEER_FINDING_KINDS.has(finding.kind));
  const peerProblems = peerFindings.filter((finding) => finding.status !== 'compatible');
  // An empty peer-findings list is never claimed as "no peer dependencies" —
  // the underlying compatibility check (see CompatibilitySection.tsx's own
  // fallback copy) can't distinguish "genuinely has none" from "nothing was
  // available to check", so both collapse to the same honest "Not checked"
  // this card already uses for the two checks with no detector at all.
  const peerTone: CompatCheckTone = peerFindings.length === 0 ? 'unknown' : peerProblems.length > 0 ? 'warn' : 'ok';
  const peerValue =
    peerFindings.length === 0
      ? 'Not checked'
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
      {summary !== undefined ? (
        <p className={`usage-status${summaryTone === 'compatible' ? ' usage-status--ok' : summaryTone === 'conflict' ? ' usage-status--error' : ''}`}>
          {summaryTone === 'compatible' ? (
            <IconCheck className="usage-status__icon" />
          ) : summaryTone === 'conflict' ? (
            <IconAlertTriangle className="usage-status__icon" />
          ) : (
            <IconHelpCircle className="usage-status__icon" />
          )}
          {summary}
        </p>
      ) : null}
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
 * The plain, non-conflict case — every real proposed change (`changes`),
 * numbered, reusing the exact same `.smart-plan__*` markup SmartPlanSection
 * uses for the genuinely-coordinated-conflict case. No risk/impact score is
 * shown: this codebase has no such rating anywhere in the upgrade pipeline,
 * so showing one would be invented, not derived.
 */
export function SimpleUpgradePlanCard({
  row,
  changes,
}: {
  row: PackageRow;
  changes: UpgradeAnalysisPresentation['changes'];
}): ReactElement {
  const steps = changes;
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
export function SecurityOutcomeCard({
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
export function FilesModifiedCard({ files }: { files: UpgradeAnalysisFiles }): ReactElement {
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
export function VerificationStepsCard({
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
