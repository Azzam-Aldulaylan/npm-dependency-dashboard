import { useState } from 'react';
import type { ReactElement } from 'react';

import type { AttributedAdvisory, PackageRow, Severity } from '../../../src/core/types.js';
import { sortAdvisoriesBySeverity } from '../../../src/host/severityDisplay.js';
import { classifyRowUpdate } from '../../../src/host/updateClassification.js';
import type { ActionState, TransitiveRemediationUiState } from '../../../src/host/upgradeAction.js';
import { resolveActionState } from '../../../src/host/upgradeAction.js';
import { directUpgradeRecommendation } from '../../../src/host/vulnerabilityRecommendation.js';
import { IconCheck, IconExternalLink, IconRefresh, IconShield } from '../icons.js';
import { SeverityBadge } from './SeverityBadge.js';
import { patchedVersionText } from './VulnerabilityCard.js';

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'info'];
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
  info: 'Info',
};
const UPDATE_KIND_LABEL: Record<'major' | 'minor' | 'patch', string> = {
  major: 'Major',
  minor: 'Minor',
  patch: 'Patch',
};

type SeverityFilter = 'all' | Severity;

/** A compact "label / value" row — same shape as OverviewPanel's own GlanceRow, kept local since it's a 4-line pure helper duplicated per-panel throughout this workspace rather than shared. */
function GlanceRow({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="manage-glance__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Worst-first severity totals present on this row — never a zero count. */
function severityCounts(advisories: readonly AttributedAdvisory[]): [Severity, number][] {
  const counts = new Map<Severity, number>();
  for (const entry of advisories) counts.set(entry.advisory.severity, (counts.get(entry.advisory.severity) ?? 0) + 1);
  return SEVERITY_ORDER.filter((severity) => counts.has(severity)).map((severity) => [severity, counts.get(severity) as number]);
}

/**
 * One vulnerability's full detail — severity, title, and source link on one
 * row; flagged package / affected range / fixed-in / introduced-through as
 * four scannable columns below. Deliberately a fresh layout rather than a
 * reuse of the shared VulnerabilityCard (table drilldown + Upgrade review's
 * Security section both still render that unchanged) — this tab's own
 * horizontal-metadata presentation is what's being redesigned here. The
 * underlying facts (attribution, patched-version resolution) are never
 * recomputed: every field below reads straight off the already-resolved
 * `AttributedAdvisory` the host produced.
 */
function VulnerabilityDetailCard({
  entry,
  rootPackageName,
  onOpenAdvisory,
}: {
  entry: AttributedAdvisory;
  rootPackageName: string;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
}): ReactElement {
  return (
    <li className="vuln-card">
      <div className="vuln-card__head">
        <SeverityBadge severity={entry.advisory.severity} />
        <span className="vuln-card__title">{entry.advisory.title}</span>
        <button
          type="button"
          className="vuln-card__source"
          onClick={() => onOpenAdvisory(rootPackageName, entry.advisory.id, [...entry.path])}
        >
          View advisory source
          <IconExternalLink />
        </button>
      </div>
      <dl className="vuln-card__meta">
        <div className="vuln-card__meta-col">
          <dt>Flagged package</dt>
          <dd>
            <code>{entry.flaggedPackage}</code>
          </dd>
        </div>
        <div className="vuln-card__meta-col">
          <dt>Affected</dt>
          <dd>
            <code>{entry.advisory.vulnerableVersions}</code>
          </dd>
        </div>
        <div className="vuln-card__meta-col">
          <dt>Fixed in</dt>
          <dd className={entry.patchedVersion.status === 'known' ? 'vuln-card__fixed' : undefined}>
            {patchedVersionText(entry.patchedVersion)}
          </dd>
        </div>
        <div className="vuln-card__meta-col">
          <dt>{entry.path.length > 1 ? 'Introduced through' : 'Package'}</dt>
          <dd className="vuln-card__path">
            {entry.path.map((segment, index) => (
              <span className="vuln-card__path-segment" key={`${segment}-${index}`}>
                {index > 0 ? (
                  <span className="vuln-card__path-arrow" aria-hidden="true">
                    →
                  </span>
                ) : null}
                {segment}
              </span>
            ))}
          </dd>
        </div>
      </dl>
    </li>
  );
}

/**
 * The left column's third card — one sentence naming the best next move for
 * these vulnerabilities, plus the one CTA that applies. Never invents a
 * state resolveActionState (src/host/upgradeAction.ts) doesn't already
 * describe: the same decision Overview's own Upgrade card renders from,
 * just read for its message instead of its button. "Review upgrade" routes
 * through the identical `{ type: 'upgrade' }` preflight the Upgrade review
 * tab and Overview both use; "Check transitive fixes" starts the same
 * remediation analysis Overview's own card runs, then hands the user back
 * to Overview to watch it resolve — there is no second, tab-local copy of
 * either flow.
 */
function RecommendedActionCard({
  row,
  state,
  totalCount,
  actionsDisabled,
  onStartUpgradeReview,
  onStartTransitiveCheck,
}: {
  row: PackageRow;
  state: ActionState;
  totalCount: number;
  actionsDisabled: boolean;
  onStartUpgradeReview: (target: string) => void;
  onStartTransitiveCheck: () => void;
}): ReactElement {
  let message: string;
  let cta: { label: string; onClick: () => void } | null = null;
  let busy = false;

  if (state.kind === 'security-fix' || state.kind === 'update') {
    message = directUpgradeRecommendation(state.kind, row.name, state.target, totalCount);
    cta = { label: 'Review upgrade', onClick: () => onStartUpgradeReview(state.target) };
  } else if (state.kind === 'transitive-remediation') {
    message = state.tooltip;
    cta = { label: 'Check transitive fixes', onClick: onStartTransitiveCheck };
  } else if (state.kind === 'remediation-analyzing') {
    message = state.tooltip;
    busy = true;
  } else {
    message = state.tooltip;
  }

  return (
    <section className="vuln-recommended" aria-labelledby="vuln-recommended-heading">
      <h3 className="manage-section-heading" id="vuln-recommended-heading">
        Recommended action
      </h3>
      <p className="vuln-recommended__message">
        {busy ? <IconRefresh className="vuln-recommended__spin" /> : null}
        {message}
      </p>
      {cta !== null ? (
        <button type="button" className="button button--primary vuln-recommended__cta" disabled={actionsDisabled} onClick={cta.onClick}>
          {cta.label} →
        </button>
      ) : null}
    </section>
  );
}

/**
 * The Vulnerabilities tab — a left-column security summary (total +
 * severity breakdown, at-a-glance version facts, and the one recommended
 * next action) beside the right column's full, filterable advisory list.
 * The "tell me everything, and what to do about it" counterpart to
 * Overview's compact summary card (see OverviewPanel.tsx's own
 * VulnerabilitySummary) — this is the only place the full list renders.
 */
export function VulnerabilitiesPanel({
  row,
  remediation,
  actionsDisabled,
  updateResolutionAvailable,
  advisoriesAvailable,
  onOpenAdvisory,
  onStartUpgradeReview,
  onStartTransitiveCheck,
}: {
  row: PackageRow;
  remediation: TransitiveRemediationUiState | undefined;
  actionsDisabled: boolean;
  updateResolutionAvailable: boolean;
  advisoriesAvailable: boolean;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
  onStartUpgradeReview: (target: string) => void;
  onStartTransitiveCheck: () => void;
}): ReactElement {
  const [filter, setFilter] = useState<SeverityFilter>('all');

  if (!advisoriesAvailable) {
    return (
      <div className="manage-panel-empty">
        <IconShield className="manage-panel-empty__icon" />
        <p>Vulnerability data is unavailable for {row.name}. Refresh the dashboard to try again.</p>
      </div>
    );
  }

  if (row.advisories.length === 0) {
    return (
      <div className="manage-panel-empty">
        <IconCheck className="manage-panel-empty__icon manage-panel-empty__icon--ok" />
        <p>No known vulnerabilities for {row.name}.</p>
      </div>
    );
  }

  const sorted = sortAdvisoriesBySeverity(row.advisories);
  const counts = severityCounts(row.advisories);
  const total = row.advisories.length;
  const worstPresent = counts[0]?.[0] ?? 'info';
  const filtered = filter === 'all' ? sorted : sorted.filter((entry) => entry.advisory.severity === filter);
  const updateKind = classifyRowUpdate(row);
  const actionState = resolveActionState(row, remediation);
  const needsAttention = worstPresent === 'critical' || worstPresent === 'high';

  return (
    <div className="vuln-tab">
      <div className="vuln-tab__summary">
        <section className="vuln-summary-card" aria-labelledby="vuln-security-summary-heading">
          <h3 className="manage-section-heading" id="vuln-security-summary-heading">
            Security summary
          </h3>
          <div className="vuln-summary-card__total">
            <span className="vuln-summary-card__icon" aria-hidden="true">
              <IconShield />
            </span>
            <div>
              <span className="vuln-summary-card__count">{total}</span>
              <span className="vuln-summary-card__count-label">Total vulnerabilit{total === 1 ? 'y' : 'ies'}</span>
            </div>
          </div>
          <ul className="vuln-summary-card__breakdown">
            {counts.map(([severity, count]) => (
              <li key={severity} className={`vuln-summary-card__stat vuln-summary-card__stat--${severity}`}>
                <span className="vuln-summary-card__dot" aria-hidden="true" />
                {count} {SEVERITY_LABEL[severity]}
              </li>
            ))}
          </ul>
        </section>

        <section className="manage-summary-block" aria-labelledby="vuln-at-a-glance-heading">
          <h3 className="manage-section-heading" id="vuln-at-a-glance-heading">
            At a glance
          </h3>
          <dl className="manage-glance">
            <GlanceRow label="Installed version">{row.current ?? row.range}</GlanceRow>
            <GlanceRow label="Latest version">{updateResolutionAvailable ? row.latest ?? '—' : 'Unavailable'}</GlanceRow>
            <GlanceRow label="Update available">
              {!updateResolutionAvailable ? 'Unavailable' : row.upgradeTo === null ? 'None' : updateKind !== null ? UPDATE_KIND_LABEL[updateKind] : 'Yes'}
            </GlanceRow>
            <GlanceRow label="Status">
              <span className={`status-badge status-badge--${needsAttention ? 'warning' : 'neutral'}`}>
                {needsAttention ? 'Needs attention' : 'Review recommended'}
              </span>
            </GlanceRow>
          </dl>
        </section>

        <RecommendedActionCard
          row={row}
          state={actionState}
          totalCount={total}
          actionsDisabled={actionsDisabled}
          onStartUpgradeReview={onStartUpgradeReview}
          onStartTransitiveCheck={onStartTransitiveCheck}
        />
      </div>

      <div className="vuln-tab__details">
        <h3 className="manage-section-heading">Vulnerability details</h3>
        <div className="vuln-filters" role="tablist" aria-label="Filter by severity">
          <button
            type="button"
            className={`vuln-filter${filter === 'all' ? ' vuln-filter--active' : ''}`}
            role="tab"
            aria-selected={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All
            <span className="vuln-filter__count">{total}</span>
          </button>
          {counts.map(([severity, count]) => (
            <button
              key={severity}
              type="button"
              className={`vuln-filter vuln-filter--${severity}${filter === severity ? ' vuln-filter--active' : ''}`}
              role="tab"
              aria-selected={filter === severity}
              onClick={() => setFilter(severity)}
            >
              {SEVERITY_LABEL[severity]}
              <span className="vuln-filter__count">{count}</span>
            </button>
          ))}
        </div>
        <ul className="vuln-card-list">
          {filtered.map((entry, index) => (
            <VulnerabilityDetailCard
              entry={entry}
              rootPackageName={row.name}
              onOpenAdvisory={onOpenAdvisory}
              key={`${String(entry.advisory.id)}:${entry.path.join('>')}:${index}`}
            />
          ))}
        </ul>
        <p className="vuln-tab__showing">
          Showing {filtered.length} vulnerabilit{filtered.length === 1 ? 'y' : 'ies'}
        </p>
      </div>
    </div>
  );
}
