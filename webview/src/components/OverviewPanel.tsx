import type { ReactElement } from 'react';

import type { AttributedAdvisory, PackageRow, Severity } from '../../../src/core/types.js';
import { sortAdvisoriesBySeverity } from '../../../src/host/severityDisplay.js';
import { classifyRowUpdate } from '../../../src/host/updateClassification.js';
import type { TransitiveRemediationUiState } from '../../../src/host/upgradeAction.js';
import { hasEligibleTransitiveFix, resolveActionState } from '../../../src/host/upgradeAction.js';
import { CLASSIFICATION_LABEL, classificationOf } from '../dependencyClassification.js';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconHelpCircle,
  IconRefresh,
  IconRoute,
  IconShield,
  IconTrash,
  IconTrendUp,
} from '../icons.js';
import { REMOVAL_IMPACT_LABEL } from '../removalImpactState.js';
import type { RemovalImpactState } from '../removalImpactState.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { SeverityBadge } from './SeverityBadge.js';
import { CurrentVersionCell } from './VersionCell.js';
import { patchedVersionText } from './VulnerabilityCard.js';
import type { UsageRequestState } from './UsageReferencesPanel.js';

const UPDATE_KIND_LABEL: Record<'major' | 'minor' | 'patch', string> = {
  major: 'Major',
  minor: 'Minor',
  patch: 'Patch',
};

/** A compact "label / value" row for the left-column At a glance / Package overview lists. */
function GlanceRow({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="manage-glance__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A quiet "checking usage…" status — the one glanceable spinner both At a glance and the Remove card's Usage analysis stat box render, never a bare "Not analyzed" while a background scan is already known to be running. */
function UsageCheckingStatus(): ReactElement {
  return (
    <span className="manage-glance__status">
      <IconRefresh className="manage-glance__status-icon manage-glance__status-icon--spin" />
      Checking usage…
    </span>
  );
}

/**
 * One deliberate action card — Upgrade / Remove / Check transitive fixes all
 * share this shell: an icon, a title, a one-line explanation, structured
 * detail, and exactly one primary control. Never a bare disabled button with
 * no explanation — every unavailable/blocked state renders through this
 * same shell with `reason` filled in instead.
 */
function ActionCard({
  icon,
  tone,
  title,
  description,
  children,
}: {
  icon: ReactElement;
  tone: 'upgrade' | 'remove' | 'transitive';
  title: string;
  description: string;
  children: ReactElement | (ReactElement | null)[] | null;
}): ReactElement {
  return (
    <section className={`manage-action-card manage-action-card--${tone}`}>
      <div className="manage-action-card__head">
        <span className="manage-action-card__icon">{icon}</span>
        <div>
          <h3 className="manage-action-card__title">{title}</h3>
          <p className="manage-action-card__description">{description}</p>
        </div>
      </div>
      <div className="manage-action-card__body">{children}</div>
    </section>
  );
}

/**
 * The Upgrade action card — a thin presentational wrapper around
 * resolveActionState (src/host/upgradeAction.ts), the same host-derived
 * decision the row's own former upgrade button already rendered. Clicking
 * "Review upgrade" switches to the Upgrade review tab and starts the
 * identical `{ type: 'upgrade', package, target }` preflight — see
 * App.tsx's requestReviewUpgradeFromManage. This never re-derives
 * eligibility or builds a second analyzer, and never opens a second modal.
 */
function UpgradeCard({
  row,
  remediation,
  actionsDisabled,
  onStartUpgradeReview,
}: {
  row: PackageRow;
  remediation: TransitiveRemediationUiState | undefined;
  actionsDisabled: boolean;
  onStartUpgradeReview: (target: string) => void;
}): ReactElement {
  const state = resolveActionState(row, remediation);

  if (state.kind === 'up-to-date') {
    return (
      <ActionCard icon={<IconTrendUp />} tone="upgrade" title="Upgrade dependency" description="Upgrade this dependency to a newer version.">
        <p className="manage-action-card__status">
          <IconCheck className="manage-action-card__status-icon manage-action-card__status-icon--ok" />
          Up to date — already at the newest version allowed by its range.
        </p>
      </ActionCard>
    );
  }

  if (state.kind === 'security-fix' || state.kind === 'update') {
    const updateKind = state.kind === 'update' ? state.updateKind : classifyRowUpdate(row);
    return (
      <ActionCard
        icon={<IconTrendUp />}
        tone="upgrade"
        title="Upgrade dependency"
        description={`Upgrade ${row.name} to a newer version.`}
      >
        <div className="manage-action-card__versions">
          <span className="manage-action-card__version">{row.current ?? row.range}</span>
          <span className="manage-action-card__version-arrow" aria-hidden="true">→</span>
          <span className="manage-action-card__version manage-action-card__version--target">{state.target}</span>
        </div>
        <p className="manage-action-card__badges">
          {state.kind === 'security-fix' ? (
            <span className="status-badge status-badge--warning">Security fix</span>
          ) : null}
          {updateKind !== null ? <span className="status-badge">{UPDATE_KIND_LABEL[updateKind]} update</span> : null}
        </p>
        <button
          type="button"
          className="button manage-action-card__cta"
          disabled={actionsDisabled}
          title={actionsDisabled ? 'Another dependency operation is already in progress.' : state.tooltip}
          onClick={() => onStartUpgradeReview(state.target)}
        >
          Review upgrade →
        </button>
      </ActionCard>
    );
  }

  // Every remaining ActionState kind (unavailable, no-direct-fix,
  // remediation-*) means there is no direct upgrade to offer right now —
  // render the honest, structured reason rather than a bare disabled
  // button.
  const reason =
    state.kind === 'unavailable'
      ? state.tooltip
      : state.kind === 'no-direct-fix'
        ? state.tooltip
        : 'No direct upgrade is currently available for this dependency.';
  return (
    <ActionCard icon={<IconTrendUp />} tone="upgrade" title="Upgrade dependency" description="Upgrade this dependency to a newer version.">
      <p className="manage-action-card__status manage-action-card__status--muted">
        <IconHelpCircle className="manage-action-card__status-icon" />
        {reason}
      </p>
    </ActionCard>
  );
}

/** One compact stat box in the Remove card's three-box status row — Usage analysis / Peer requirements / Removal risk, replacing a plain label/value list. */
function RemovalStatBox({
  label,
  value,
  spinning,
}: {
  label: string;
  value: ReactElement | string;
  spinning?: boolean;
}): ReactElement {
  return (
    <div className="manage-removal-stat">
      <dt className="manage-removal-stat__label">{label}</dt>
      <dd className="manage-removal-stat__value">
        {spinning === true ? <IconRefresh className="manage-removal-stat__spinner" /> : null}
        {value}
      </dd>
    </div>
  );
}

/**
 * The Remove action card — compact status only. Before analysis, a
 * structured "not analyzed" state and an "Analyze removal →" CTA that
 * switches to the Removal review tab and starts the real preflight there
 * (App.tsx's onStartRemovalReview). Once analysis exists, this stays
 * compact ("Review removal →") — the full evidence list, affected files,
 * verification, and the actual Remove control all live in the Removal
 * review tab, never duplicated here.
 */
function RemoveCard({
  row,
  removalImpact,
  usage,
  actionsDisabled,
  onStartRemovalReview,
  onChangeTab,
}: {
  row: PackageRow;
  removalImpact: RemovalImpactState;
  usage: UsageRequestState | undefined;
  actionsDisabled: boolean;
  onStartRemovalReview: () => void;
  onChangeTab: (tab: ManageTabId) => void;
}): ReactElement {
  const entry = removalImpact.phase === 'done' ? removalImpact.assessments.get(row.name) : undefined;
  const analyzing = removalImpact.phase === 'analyzing';
  const usageChecking = usage === undefined || usage.phase === 'analyzing';

  const peerValue: ReactElement | string =
    entry !== undefined ? `${entry.assessment.evidence.filter((e) => e.kind === 'peer-requirement').length}` : 'Not analyzed';
  const riskValue: ReactElement | string =
    entry !== undefined ? (
      <span className={`status-badge status-badge--${entry.assessment.status === 'low-risk' ? 'neutral' : 'warning'}`}>
        {REMOVAL_IMPACT_LABEL[entry.assessment.status]}
      </span>
    ) : (
      'Unknown'
    );

  return (
    <ActionCard icon={<IconTrash />} tone="remove" title="Remove dependency" description={`Check whether ${row.name} can be removed from this project.`}>
      <dl className="manage-removal-stats">
        <RemovalStatBox label="Usage analysis" value={usageChecking ? 'Checking usage…' : usageAnalysisLabel(usage)} spinning={usageChecking} />
        <RemovalStatBox label="Peer requirements" value={peerValue} />
        <RemovalStatBox label="Removal risk" value={riskValue} />
      </dl>
      {analyzing ? (
        <div className="manage-action-card__progress" role="status" aria-live="polite">
          <IconRefresh className="manage-action-card__status-icon manage-action-card__status-icon--spin" />
          <span>
            Analyzing removal impact
            {removalImpact.total > 0 ? ` — ${removalImpact.scanned} of ${removalImpact.total} files checked` : '…'}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="button manage-action-card__cta"
          disabled={actionsDisabled}
          onClick={entry !== undefined ? () => onChangeTab('removal') : onStartRemovalReview}
        >
          {entry !== undefined ? 'Review removal →' : 'Analyze removal →'}
        </button>
      )}
      {removalImpact.phase === 'error' ? (
        <p className="manage-action-card__status manage-action-card__status--error">
          <IconAlertTriangle className="manage-action-card__status-icon" />
          Couldn't analyze removal impact: {removalImpact.message}
        </p>
      ) : null}
    </ActionCard>
  );
}

/**
 * The transitive-fix card — only rendered when this row has a transitive
 * vulnerability with no direct upgrade target (the exact same gate
 * resolveActionState applies before offering "Check transitive fix" —
 * mirrored here, not re-derived independently). Reuses the existing
 * analyze-remediation flow end to end; never a second resolver.
 */
function TransitiveFixCard({
  row,
  remediation,
  actionsDisabled,
  onAnalyzeRemediation,
}: {
  row: PackageRow;
  remediation: TransitiveRemediationUiState | undefined;
  actionsDisabled: boolean;
  onAnalyzeRemediation: () => void;
}): ReactElement {
  const first = row.advisories.find((entry) => entry.path.length > 1);
  const subject = first?.flaggedPackage ?? 'a transitive dependency';
  const introducedThrough = first !== undefined ? first.path.join(' → ') : row.name;

  return (
    <ActionCard
      icon={<IconRoute />}
      tone="transitive"
      title="Check transitive fixes"
      description="Check whether a vulnerable transitive package can be resolved to a fixed version without an unsafe direct change."
    >
      <p className="manage-action-card__status">
        <code>{subject}</code> is introduced through <code>{introducedThrough}</code>.
      </p>
      {remediation === undefined ? (
        <button type="button" className="button manage-action-card__cta" disabled={actionsDisabled} onClick={onAnalyzeRemediation}>
          Check transitive fixes →
        </button>
      ) : remediation.phase === 'analyzing' ? (
        <p className="manage-action-card__status">
          <IconRefresh className="manage-action-card__status-icon manage-action-card__status-icon--spin" />
          Analyzing…
        </p>
      ) : remediation.status === 'resolved' ? (
        <p className="manage-action-card__status">
          <IconCheck className="manage-action-card__status-icon manage-action-card__status-icon--ok" />
          The dependency tree can resolve {subject} to a non-vulnerable version without changing {row.name}'s own version.
        </p>
      ) : remediation.status === 'unknown' ? (
        <p className="manage-action-card__status manage-action-card__status--muted">
          <IconHelpCircle className="manage-action-card__status-icon" />
          Remediation could not be determined — the resolver check did not complete.
        </p>
      ) : (
        <p className="manage-action-card__status manage-action-card__status--muted">
          <IconAlertTriangle className="manage-action-card__status-icon" />
          No validated dependency change is currently known to remove the vulnerable version.
        </p>
      )}
    </ActionCard>
  );
}

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'info'];

/** Worst-first severity totals — e.g. `[['critical', 1], ['moderate', 1]]`. Never includes a zero count. */
function severityCounts(advisories: readonly AttributedAdvisory[]): [Severity, number][] {
  const counts = new Map<Severity, number>();
  for (const entry of advisories) counts.set(entry.advisory.severity, (counts.get(entry.advisory.severity) ?? 0) + 1);
  return SEVERITY_ORDER.filter((severity) => counts.has(severity)).map((severity) => [severity, counts.get(severity) as number]);
}

function fixLabel(patched: AttributedAdvisory['patchedVersion']): string {
  if (patched.status === 'known') return `Fixed in ${patched.version}`;
  if (patched.status === 'none') return 'No known fix';
  return `Fix unknown (${patchedVersionText(patched)})`;
}

const MAX_COMPACT_VULNERABILITIES = 2;

/**
 * The compact "VULNERABILITIES" summary — severity totals plus the one or
 * two most urgent advisories, worst-first. Never the full advisory list the
 * Vulnerabilities tab renders: this answers "should I act on this", not
 * "tell me everything" — see VulnerabilitiesPanel.tsx's own doc on the
 * split. "View vulnerabilities" switches to that tab; it never opens a
 * separate modal.
 */
function VulnerabilitySummary({
  row,
  onChangeTab,
}: {
  row: PackageRow;
  onChangeTab: (tab: ManageTabId) => void;
}): ReactElement | null {
  if (row.advisories.length === 0) return null;
  const sorted = sortAdvisoriesBySeverity(row.advisories);
  const shown = sorted.slice(0, MAX_COMPACT_VULNERABILITIES);
  const remaining = sorted.length - shown.length;

  return (
    <section className="manage-vulnerabilities" aria-labelledby="manage-vulnerabilities-heading">
      <h3 className="manage-vulnerabilities__heading" id="manage-vulnerabilities-heading">
        <IconShield className="manage-vulnerabilities__heading-icon" />
        Vulnerabilities
      </h3>
      <ul className="manage-vulnerabilities__counts">
        {severityCounts(row.advisories).map(([severity, count]) => (
          <li key={severity} className="manage-vulnerabilities__count">
            <SeverityBadge severity={severity} />
            <span>{count}</span>
          </li>
        ))}
      </ul>
      <ul className="manage-vulnerabilities__items">
        {shown.map((entry, index) => (
          <li key={`${String(entry.advisory.id)}:${entry.flaggedPackage}:${index}`} className="manage-vulnerabilities__item">
            <code className="manage-vulnerabilities__item-package">{entry.flaggedPackage}</code>
            <SeverityBadge severity={entry.advisory.severity} />
            <span className="manage-vulnerabilities__item-fix">{fixLabel(entry.patchedVersion)}</span>
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <p className="manage-vulnerabilities__more">
          +{remaining} more vulnerabilit{remaining === 1 ? 'y' : 'ies'}
        </p>
      ) : null}
      <button type="button" className="manage-vulnerabilities__link" onClick={() => onChangeTab('vulnerabilities')}>
        View vulnerabilities
        <IconChevronRight />
      </button>
    </section>
  );
}

function usageAnalysisLabel(usage: UsageRequestState | undefined): string {
  if (usage === undefined || usage.phase === 'analyzing') return 'Checking usage…';
  if (usage.phase === 'error') return 'Usage check failed';
  const count = usage.result.references.length;
  return count === 0 ? 'No references found' : `Used in ${count} file${count === 1 ? '' : 's'}`;
}

/**
 * The Overview tab — a compact "what is happening with this dependency, and
 * what can I do" summary. Left: identity and at-a-glance facts, all already
 * on `row`/`hygieneFindings`/`usage` — nothing here triggers a new host
 * round trip on its own. Right: the three deliberate action cards, each of
 * which switches to its own dedicated review tab rather than opening a
 * second modal.
 */
export function OverviewPanel({
  row,
  remediation,
  removalImpact,
  usage,
  actionsDisabled,
  onStartUpgradeReview,
  onStartRemovalReview,
  onAnalyzeRemediation,
  onChangeTab,
}: {
  row: PackageRow;
  remediation: TransitiveRemediationUiState | undefined;
  removalImpact: RemovalImpactState;
  usage: UsageRequestState | undefined;
  actionsDisabled: boolean;
  onStartUpgradeReview: (packageName: string, target: string) => void;
  onStartRemovalReview: (packageName: string) => void;
  onAnalyzeRemediation: (packageName: string) => void;
  onChangeTab: (tab: ManageTabId) => void;
}): ReactElement {
  const updateKind = classifyRowUpdate(row);
  const showTransitiveCard = hasEligibleTransitiveFix(row);
  const usageChecking = usage === undefined || usage.phase === 'analyzing';

  return (
    <div className="overview-panel">
      <div className="overview-panel__summary">
        <section className="manage-summary-block" aria-labelledby="manage-package-overview-heading">
          <h3 className="manage-section-heading" id="manage-package-overview-heading">
            Package overview
          </h3>
          <dl className="manage-glance">
            <GlanceRow label="Name">{row.name}</GlanceRow>
            <GlanceRow label="Version">
              <CurrentVersionCell row={row} />
            </GlanceRow>
            <GlanceRow label="Type">{CLASSIFICATION_LABEL[classificationOf(row)]}</GlanceRow>
            <GlanceRow label="License">{row.license ?? '—'}</GlanceRow>
          </dl>
        </section>

        <section className="manage-summary-block" aria-labelledby="manage-at-a-glance-heading">
          <h3 className="manage-section-heading" id="manage-at-a-glance-heading">
            At a glance
          </h3>
          <dl className="manage-glance">
            <GlanceRow label="Installed version">{row.current ?? row.range}</GlanceRow>
            <GlanceRow label="Latest version">{row.latest ?? '—'}</GlanceRow>
            <GlanceRow label="Update available">
              {row.upgradeTo === null ? 'None' : updateKind !== null ? UPDATE_KIND_LABEL[updateKind] : 'Yes'}
            </GlanceRow>
            <GlanceRow label="Vulnerabilities">
              {row.advisories.length === 0 ? 'None' : <SeverityBadge severity={row.worstSeverity} />}
            </GlanceRow>
            <GlanceRow label="Usage analysis">{usageChecking ? <UsageCheckingStatus /> : usageAnalysisLabel(usage)}</GlanceRow>
          </dl>
        </section>

        <VulnerabilitySummary row={row} onChangeTab={onChangeTab} />
      </div>

      <div className="overview-panel__actions">
        <h3 className="manage-section-heading">Available actions</h3>
        <div className="manage-action-cards">
          <UpgradeCard
            row={row}
            remediation={remediation}
            actionsDisabled={actionsDisabled}
            onStartUpgradeReview={(target) => onStartUpgradeReview(row.name, target)}
          />
          <RemoveCard
            row={row}
            removalImpact={removalImpact}
            usage={usage}
            actionsDisabled={actionsDisabled}
            onStartRemovalReview={() => onStartRemovalReview(row.name)}
            onChangeTab={onChangeTab}
          />
          {showTransitiveCard ? (
            <TransitiveFixCard
              row={row}
              remediation={remediation}
              actionsDisabled={actionsDisabled}
              onAnalyzeRemediation={() => onAnalyzeRemediation(row.name)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
