import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type {
  CompatibilityFindingKind,
  ProjectCompatibilityAnalysis,
  UpgradeAnalysisPresentation,
  UpgradeAnalysisSmartPlan,
  UpgradeAnalysisVerification,
} from '../../../src/host/webviewProtocol.js';
import { compatibilityOutcomeDisplay, securityOutcomeDisplay } from '../../../src/host/outcomeCopy.js';
import { summarizeProjectCompatibility } from '../../../src/host/projectCompatibilityUiState.js';
import {
  plannerAddedUpgradeChanges,
  remainingVulnerabilityPatchedVersionLabel,
} from '../../../src/host/upgradeReviewUiState.js';
import { IconAlertTriangle, IconCheck, IconExternalLink, IconGear, IconHelpCircle, IconListChecks, IconRoute, IconShield } from '../icons.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { overallStatusDetail } from './UpgradeAnalysisModal.js';
import { SeverityBadge } from './SeverityBadge.js';
import { patchedVersionText } from './VulnerabilityCard.js';

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
 * The compact compatibility grid. Peer results remain dependency-tree facts;
 * runtime and project compatibility come only from the new host analyzers.
 * A major version alone is deliberately not rendered as a breaking-change
 * claim. Deprecated API analysis is still not implemented and stays honest.
 */
export function CompatibilityCheckCard({
  compatibility,
  projectCompatibility,
}: {
  compatibility: UpgradeAnalysisPresentation['compatibility'];
  projectCompatibility?: ProjectCompatibilityAnalysis | undefined;
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

  const projectSummary = projectCompatibility === undefined ? null : summarizeProjectCompatibility(projectCompatibility);
  const hasProjectAnalyzers = projectCompatibility !== undefined && projectCompatibility.analyzers.length > 0;
  const runtimeFindings = projectCompatibility?.findings.filter((finding) => finding.category === 'runtime') ?? [];
  const runtimeTone: CompatCheckTone =
    projectSummary === null || projectSummary.runtimeStatus === 'missing' || projectSummary.runtimeStatus === 'unavailable' || projectSummary.runtimeStatus === 'cancelled'
      ? 'unknown'
      : runtimeFindings.length > 0
        ? 'warn'
        : projectSummary.runtimeStatus === 'partial'
          ? 'unknown'
          : 'ok';
  const runtimeValue =
    projectSummary === null || projectSummary.runtimeStatus === 'missing'
      ? 'Not checked'
      : projectSummary.runtimeStatus === 'unavailable' || projectSummary.runtimeStatus === 'cancelled'
        ? 'Could not verify'
        : runtimeFindings.length > 0
          ? `${runtimeFindings.length} issue${runtimeFindings.length === 1 ? '' : 's'}`
          : projectSummary.runtimeStatus === 'partial'
            ? 'Partially checked'
            : 'No conflicts found';
  const projectTone: CompatCheckTone =
    projectSummary === null || !hasProjectAnalyzers || projectSummary.incompleteAnalyzers.length > 0
      ? projectSummary !== null && projectSummary.total > 0 ? 'warn' : 'unknown'
      : projectSummary.total > 0
        ? 'warn'
        : 'ok';
  const projectValue =
    projectSummary === null || !hasProjectAnalyzers
      ? 'Not checked'
      : projectSummary.total > 0
        ? `${projectSummary.total} finding${projectSummary.total === 1 ? '' : 's'}`
        : projectSummary.incompleteAnalyzers.length > 0
          ? 'Checks incomplete'
          : 'No issues found';

  return (
    <section className="analysis-card" aria-labelledby="upgrade-compat-heading">
      <h3 className="analysis-card__title" id="upgrade-compat-heading">
        <IconRoute className="analysis-card__title-icon" />
        Compatibility check
      </h3>
      {summary !== undefined ? (
        <p className={`usage-status upgrade-compatibility__summary${summaryTone === 'compatible' ? ' usage-status--ok' : summaryTone === 'conflict' ? ' usage-status--error' : ''}`}>
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
        <CompatCheckItem tone={runtimeTone} label="Engine requirements" value={runtimeValue} />
        <CompatCheckItem tone={projectTone} label="Project compatibility" value={projectValue} />
        <CompatCheckItem tone="unknown" label="Deprecated APIs" value="Not checked" />
      </div>
    </section>
  );
}

/**
 * The plain, non-conflict case. This is deliberately called "Upgrade plan",
 * not "Smart plan": `changes` is the requested host-validated proposal, and
 * no coordinated search was needed.
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
        Upgrade plan
      </h3>
      <p className="usage-card__subtitle">
        Requested version change for {row.name}
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

/** A host-found coordinated plan, including only host-provided reasons. */
export function CoordinatedUpgradePlanCard({
  requestedChanges,
  smartPlan,
  compatibility,
}: {
  requestedChanges: UpgradeAnalysisPresentation['changes'];
  smartPlan: UpgradeAnalysisSmartPlan;
  compatibility: UpgradeAnalysisPresentation['compatibility'];
}): ReactElement {
  const reasonIds = new Set(smartPlan.reasonFindingIds);
  const reasons = compatibility.findings.filter((finding) => reasonIds.has(finding.id));
  const plannerAdded = plannerAddedUpgradeChanges(requestedChanges, smartPlan.changes);
  const additionalCount = plannerAdded.length;

  return (
    <section className="smart-plan-banner" aria-labelledby="upgrade-coordinated-plan-heading">
      <h3 className="smart-plan-banner__title" id="upgrade-coordinated-plan-heading">
        <IconRoute className="smart-plan-banner__title-icon" />
        Coordinated upgrade
      </h3>
      <p className="smart-plan-banner__hint smart-plan-banner__hint--lead">
        The planner found {additionalCount} additional dependency change{additionalCount === 1 ? '' : 's'} needed to resolve the conflict.
      </p>
      <ol className="smart-plan__changes">
        {smartPlan.changes.map((change) => (
          <li className="smart-plan__change" key={change.packageName}>
            <span className="smart-plan__package">{change.packageName}</span>
            <span className="smart-plan__versions">
              {change.currentVersion} → {change.targetVersion}
            </span>
          </li>
        ))}
      </ol>
      {reasons.length > 0 ? (
        <div className="coordinated-plan__reasons">
          <p className="coordinated-plan__reasons-label">Why coordination is needed</p>
          <ul>
            {reasons.map((finding) => <li key={finding.id}>{finding.explanation}</li>)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The protocol does not expose whether planning ended as impossible,
 * unknown, or limit-reached. Keep this state neutral instead of claiming
 * that no safe plan exists when the host only sent `smartPlan: null`.
 */
export function CoordinationUnavailableCard({ row, changes }: { row: PackageRow; changes: UpgradeAnalysisPresentation['changes'] }): ReactElement {
  const requested = changes.find((change) => change.packageName === row.name) ?? changes[0];
  return (
    <section className="analysis-card" aria-labelledby="upgrade-coordination-unavailable-heading">
      <h3 className="analysis-card__title" id="upgrade-coordination-unavailable-heading">
        <IconAlertTriangle className="analysis-card__title-icon" />
        Coordinated plan not confirmed
      </h3>
      {requested !== undefined ? (
        <p className="upgrade-plan__requested">
          Requested: <code>{requested.packageName}@{requested.targetVersion}</code>
        </p>
      ) : null}
      <p className="usage-card__subtitle">
        A dependency conflict was found, but this analysis did not confirm a coordinated resolution.
      </p>
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
  onOpenAdvisory,
}: {
  row: PackageRow;
  security: UpgradeAnalysisPresentation['security'];
  onChangeTab: (tab: ManageTabId) => void;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[]) => void) | undefined;
}): ReactElement | null {
  if (security === null) return null;
  const beforeCount = security.resolvedAdvisories.length + security.remaining.length;
  const resolvedCount = security.resolvedAdvisories.length;
  const remainingCount = security.remaining.filter((entry) => entry.status === 'remains').length;
  const unknownCount = security.remaining.filter((entry) => entry.status === 'unknown').length;
  const remainingGroups = [
    {
      status: 'remains' as const,
      label: 'Confirmed to remain',
      description: 'The proposed dependency tree still resolves to an affected version.',
      entries: security.remaining.filter((entry) => entry.status === 'remains'),
    },
    {
      status: 'unknown' as const,
      label: 'Undetermined',
      description: 'The available resolver evidence could not confirm whether this advisory is fixed.',
      entries: security.remaining.filter((entry) => entry.status === 'unknown'),
    },
  ].filter((group) => group.entries.length > 0);
  const after = securityOutcomeDisplay(security.status);
  const contexts = security.contexts ?? [];
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
            {beforeCount} known vulnerabilit{beforeCount === 1 ? 'y' : 'ies'}
          </p>
          <p className="security-outcome__detail">From this analysis</p>
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
      {contexts.length > 0 ? (
        <details className="vulnerability-contexts">
          <summary className="vulnerability-contexts__summary">
            Dependency paths and remediation evidence
          </summary>
          <ul className="vulnerability-contexts__list">
            {contexts.map((context) => {
              const primaryPath = context.primaryPath.nodes.map((node) => node.packageName);
              const contextRootPackage = primaryPath[0] ?? row.name;
              return (
                <li className="vulnerability-context" key={`${String(context.advisory.id)}:${context.flaggedPackage}:${context.flaggedVersion ?? ''}`}>
                  <div className="vulnerability-context__head">
                    <SeverityBadge severity={context.advisory.severity} />
                    <strong>{context.advisory.title}</strong>
                  </div>
                  <dl className="vulnerability-context__meta">
                    <dt>Flagged package</dt>
                    <dd><code>{context.flaggedPackage}{context.flaggedVersion === null ? '' : `@${context.flaggedVersion}`}</code></dd>
                    <dt>Introduced through</dt>
                    <dd><code>{context.primaryPath.nodes.map((node) => `${node.packageName}${node.version === null ? '' : `@${node.version}`}`).join(' → ')}</code></dd>
                    <dt>Direct {context.directRoots.length === 1 ? 'dependency' : 'dependencies'}</dt>
                    <dd>
                      {context.directRoots.map((root) => (
                        <code key={`${root.packageName}:${root.version ?? ''}`}>{root.packageName}{root.version === null ? '' : `@${root.version}`}</code>
                      ))}
                    </dd>
                    <dt>{remainingVulnerabilityPatchedVersionLabel(context.flaggedPackage)}</dt>
                    <dd><code>{patchedVersionText(context.patchedVersion)}</code></dd>
                  </dl>
                  {context.paths.length > 1 ? (
                    <details className="vulnerability-context__paths">
                      <summary>
                        View {context.pathsTruncated === true ? `first ${context.paths.length}` : `all ${context.paths.length}`} dependency paths
                      </summary>
                      <ol>
                        {context.paths.map((path, index) => (
                          <li key={`${String(context.advisory.id)}:path:${index}`}>
                            <code>{path.nodes.map((node) => node.packageName).join(' → ')}</code>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                  {context.provenResolution !== null ? (
                    <p className="vulnerability-context__resolution">
                      <IconCheck aria-hidden="true" />
                      {context.provenResolution.directDependencyChanges.length === 1 ? 'Resolved by upgrading ' : 'Resolved by coordinated upgrades: '}
                      {context.provenResolution.directDependencyChanges.map((change, index) => (
                        <span key={change.packageName}>
                          {index > 0 ? ', ' : ''}<code>{change.packageName}</code> to <code>{change.targetVersion}</code>
                        </span>
                      ))}
                    </p>
                  ) : null}
                  {onOpenAdvisory !== undefined ? (
                    <button
                      type="button"
                      className="advisory__source"
                      onClick={() => onOpenAdvisory(contextRootPackage, context.advisory.id, primaryPath)}
                    >
                      View advisory source
                      <IconExternalLink />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {security.remaining.length > 0 ? (
        <details className="security-remaining">
          <summary className="security-remaining__summary">
            Inspect {remainingCount > 0 ? `${remainingCount} remaining` : ''}
            {remainingCount > 0 && unknownCount > 0 ? ' and ' : ''}
            {unknownCount > 0 ? `${unknownCount} undetermined` : ''}
          </summary>
          <div className="security-remaining__content">
            {remainingGroups.map((group) => (
              <section className="security-remaining__group" key={group.status} aria-labelledby={`security-remaining-${group.status}`}>
                <h4 id={`security-remaining-${group.status}`}>{group.label}</h4>
                <p>{group.description}</p>
                <ul className="security-remaining__list">
                  {group.entries.map((entry, index) => (
                    <li className="security-remaining__item" key={`${String(entry.advisory.id)}:${entry.flaggedPackage}:${index}`}>
                      <div className="security-remaining__head">
                        <SeverityBadge severity={entry.advisory.severity} />
                        <strong>{entry.advisory.title}</strong>
                        <code className="security-remaining__advisory-id">{String(entry.advisory.id)}</code>
                      </div>
                      <dl className="security-remaining__meta">
                        <dt>Flagged package</dt>
                        <dd><code>{entry.flaggedPackage}</code></dd>
                        <dt>Dependency path</dt>
                        <dd><code>{entry.path.join(' → ')}</code></dd>
                        <dt>{remainingVulnerabilityPatchedVersionLabel(entry.flaggedPackage)}</dt>
                        <dd><code>{patchedVersionText(entry.patchedVersion)}</code></dd>
                        {entry.resolvedVersion !== null ? (
                          <>
                            <dt>Proposed resolved version</dt>
                            <dd><code>{entry.resolvedVersion}</code></dd>
                          </>
                        ) : null}
                      </dl>
                      {onOpenAdvisory !== undefined ? (
                        <button
                          type="button"
                          className="advisory__source"
                          onClick={() => onOpenAdvisory(row.name, entry.advisory.id, [...entry.path])}
                        >
                          View advisory source
                          <IconExternalLink />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </details>
      ) : null}
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
