import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';

import type { AttributedAdvisory, PackageRow, Severity } from '../../../src/core/types.js';
import { sortAdvisoriesBySeverity } from '../../../src/host/severityDisplay.js';
import { classifyRowUpdate } from '../../../src/host/updateClassification.js';
import type { TransitiveRemediationUiState } from '../../../src/host/upgradeAction.js';
import { hasEligibleTransitiveFix, resolveActionState } from '../../../src/host/upgradeAction.js';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconHelpCircle,
  IconRefresh,
  IconRoute,
  IconShield,
  IconSliders,
  IconTrash,
  IconTrendUp,
  IconX,
} from '../icons.js';
import { REMOVAL_IMPACT_LABEL } from '../removalImpactState.js';
import type { RemovalImpactState } from '../removalImpactState.js';
import { PackageIcon } from './PackageIcon.js';
import { SeverityBadge } from './SeverityBadge.js';
import { patchedVersionText } from './VulnerabilityCard.js';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const CLASSIFICATION_LABEL: Record<'prod' | 'dev' | 'optional', string> = {
  prod: 'Production',
  dev: 'Development',
  optional: 'Optional',
};

function classificationOf(row: PackageRow): 'prod' | 'dev' | 'optional' {
  if (row.optional) return 'optional';
  return row.dev ? 'dev' : 'prod';
}

const UPDATE_KIND_LABEL: Record<'major' | 'minor' | 'patch', string> = {
  major: 'Major',
  minor: 'Minor',
  patch: 'Patch',
};

/** A compact "label / value" row for the left-column At a Glance list. */
function GlanceRow({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="manage-glance__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * One deliberate action card on the right — Upgrade / Remove / Check
 * transitive fixes all share this shell: an icon, a title, a one-line
 * explanation, structured detail, and exactly one primary control. Never a
 * bare disabled button with no explanation — every unavailable/blocked state
 * renders through this same shell with `reason` filled in instead.
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
    <section className={`manage-action-card manage-action-card--${tone}`} aria-labelledby={undefined}>
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
 * "Review upgrade" sends the identical `{ type: 'upgrade', package, target
 * }` message through the identical host-owned preflight/confirm/install
 * pipeline — see App.tsx's onReviewUpgrade, which closes this modal and
 * opens the existing, unchanged UpgradeAnalysisModal. This never re-derives
 * eligibility or builds a second analyzer.
 */
function UpgradeCard({
  row,
  remediation,
  actionsDisabled,
  onReviewUpgrade,
}: {
  row: PackageRow;
  remediation: TransitiveRemediationUiState | undefined;
  actionsDisabled: boolean;
  onReviewUpgrade: (target: string) => void;
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
          onClick={() => onReviewUpgrade(state.target)}
        >
          Review upgrade →
        </button>
      </ActionCard>
    );
  }

  // Every remaining ActionState kind (unavailable, no-direct-fix,
  // remediation-*) means there is no direct upgrade to offer right now —
  // render the honest, structured reason rather than a bare disabled
  // button. Transitive-vulnerability states are also surfaced on their own
  // dedicated card below when relevant, so this is deliberately terse here.
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

/**
 * The Remove action card — before analysis, a structured "not analyzed yet"
 * state and an "Analyze removal →" CTA; after, the real assessment with its
 * evidence and, only then, the destructive Remove control. Shares the exact
 * same host-owned analyze-removal-impact engine (and the same client-side
 * `removalImpact` state) as the bulk Review step — see removalImpactState.ts.
 */
function RemoveCard({
  row,
  removalImpact,
  actionsDisabled,
  onAnalyzeRemovalImpact,
  onCancelRemovalImpact,
  onViewReferences,
  onRemove,
}: {
  row: PackageRow;
  removalImpact: RemovalImpactState;
  actionsDisabled: boolean;
  onAnalyzeRemovalImpact: () => void;
  onCancelRemovalImpact: () => void;
  onViewReferences: () => void;
  onRemove: () => void;
}): ReactElement {
  const entry = removalImpact.phase === 'done' ? removalImpact.assessments.get(row.name) : undefined;
  const analyzing = removalImpact.phase === 'analyzing';

  if (entry !== undefined) {
    const peerCount = entry.assessment.evidence.filter((e) => e.kind === 'peer-requirement').length;
    const sourceEvidence = entry.assessment.evidence.filter((e) => e.kind !== 'peer-requirement');
    const blocked = entry.assessment.status === 'blocked';
    return (
      <ActionCard icon={<IconTrash />} tone="remove" title="Remove dependency" description={`Check whether ${row.name} can be removed from this project.`}>
        <dl className="manage-glance manage-action-card__glance">
          <GlanceRow label="Removal risk">
            <span className={`status-badge status-badge--${entry.assessment.status === 'low-risk' ? 'neutral' : 'warning'}`}>
              {REMOVAL_IMPACT_LABEL[entry.assessment.status]}
            </span>
          </GlanceRow>
          <GlanceRow label="Required as peer">{peerCount > 0 ? `${peerCount}` : '0'}</GlanceRow>
        </dl>
        {sourceEvidence.length > 0 ? (
          <ul className="manage-action-card__evidence">
            {sourceEvidence.map((item, index) => (
              <li key={`${item.kind}-${index}`}>{item.summary}</li>
            ))}
          </ul>
        ) : (
          <p className="manage-action-card__status">
            No known source, script, config, or peer reference was found.
            <br />
            Static analysis cannot guarantee runtime safety.
          </p>
        )}
        <div className="manage-action-card__actions">
          <button type="button" className="button button--secondary" onClick={onViewReferences}>
            View references
          </button>
          <button
            type="button"
            className="button button--danger manage-action-card__cta"
            disabled={actionsDisabled || blocked}
            title={blocked ? 'Removal is blocked — see the peer requirement above.' : undefined}
            onClick={onRemove}
          >
            Remove dependency
          </button>
        </div>
      </ActionCard>
    );
  }

  return (
    <ActionCard icon={<IconTrash />} tone="remove" title="Remove dependency" description={`Check whether ${row.name} can be removed from this project.`}>
      <dl className="manage-glance manage-action-card__glance">
        <GlanceRow label="Usage references">Not analyzed</GlanceRow>
        <GlanceRow label="Peer requirements">Not analyzed</GlanceRow>
        <GlanceRow label="Removal risk">Unknown</GlanceRow>
      </dl>
      {analyzing ? (
        <div className="manage-action-card__progress" role="status" aria-live="polite">
          <IconRefresh className="manage-action-card__status-icon manage-action-card__status-icon--spin" />
          <span>
            Analyzing removal impact
            {removalImpact.total > 0 ? ` — ${removalImpact.scanned} of ${removalImpact.total} files checked` : '…'}
          </span>
          <button type="button" className="button button--secondary" onClick={onCancelRemovalImpact}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="button manage-action-card__cta" disabled={actionsDisabled} onClick={onAnalyzeRemovalImpact}>
          Analyze removal →
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
 * two most urgent advisories, worst-first (sortAdvisoriesBySeverity). Never
 * the full VulnerabilityCard list Dependency Details renders: this modal
 * answers "should I act on this", not "tell me everything" — see the
 * Manage-vs-Details split in the redesign brief. "View vulnerability
 * details" hands off to the existing Dependency Details modal, which owns
 * the complete advisory list.
 */
function ManageVulnerabilitySummary({
  row,
  onOpenDetails,
}: {
  row: PackageRow;
  onOpenDetails: () => void;
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
      <button type="button" className="manage-vulnerabilities__link" onClick={onOpenDetails}>
        View vulnerability details
        <IconChevronRight />
      </button>
    </section>
  );
}

/**
 * The unified "Manage dependency" entry point — a single modal shell that
 * replaces the row's former upgrade-specific button with one consistent
 * Manage action. Opening this is deliberately cheap: only data already on
 * `row` (from the last completed scan) renders immediately; the Upgrade,
 * Remove, and Check-transitive-fixes cards each trigger their own real
 * analysis only once the user chooses to, never automatically on open.
 *
 * Every mutating flow this modal offers reuses an existing, unchanged
 * host-owned pipeline end to end:
 *  - Upgrade: closes this modal and opens the existing UpgradeAnalysisModal
 *    via the identical `{ type: 'upgrade' }` message/preflight/confirm flow.
 *  - Remove: the same analyze-removal-impact preview the bulk Review step
 *    uses (removalImpactState.ts), then the existing single-removal
 *    transaction (the same `bulk-remove`/`confirm-remove` path, called with
 *    one package name).
 *  - Check transitive fixes: the existing analyze-remediation flow.
 */
export function ManageDependencyModal({
  row,
  remediation,
  removalImpact,
  actionsDisabled,
  onAnalyzeRemovalImpact,
  onCancelRemovalImpact,
  onReviewUpgrade,
  onAnalyzeRemediation,
  onRemove,
  onViewReferences,
  onClose,
}: {
  row: PackageRow;
  remediation: TransitiveRemediationUiState | undefined;
  removalImpact: RemovalImpactState;
  /** True while another upgrade/removal/remediation holds the panel-wide lock elsewhere — disables this modal's mutating CTAs, never the modal itself (opening Manage is always fast). */
  actionsDisabled: boolean;
  onAnalyzeRemovalImpact: (packages: readonly string[]) => void;
  onCancelRemovalImpact: () => void;
  onReviewUpgrade: (packageName: string, target: string) => void;
  onAnalyzeRemediation: (packageName: string) => void;
  onRemove: (packageName: string) => void;
  /** Opens Dependency Details for this package — reused by both the Remove card's "View references" and the Vulnerabilities summary's "View vulnerability details". */
  onViewReferences: (packageName: string) => void;
  onClose: () => void;
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Escape is refused only while a protected operation this modal
        // itself started (the removal-impact preview) is actively running —
        // it mutates nothing, so there's no destructive-close risk, but
        // closing mid-scan would orphan the host's single-flight analysis
        // guard until it naturally finishes. Cancel first, or wait.
        if (removalImpact.phase === 'analyzing') return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [onClose, removalImpact.phase]);

  const onOverlayClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget && removalImpact.phase !== 'analyzing') onClose();
  };

  const updateKind = classifyRowUpdate(row);
  const showTransitiveCard = hasEligibleTransitiveFix(row);
  const entry = removalImpact.phase === 'done' ? removalImpact.assessments.get(row.name) : undefined;
  const peerCount = entry?.assessment.evidence.filter((e) => e.kind === 'peer-requirement').length ?? null;

  return (
    <div className="modal-overlay" onClick={onOverlayClick}>
      <div
        className="modal manage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-dependency-title"
        ref={dialogRef}
      >
        <header className="modal__header">
          <div className="modal__header-text">
            <span className="manage-modal__header-icon" aria-hidden="true">
              <IconSliders />
            </span>
            <div>
              <h2 className="modal__title" id="manage-dependency-title">
                Manage dependency
              </h2>
              <p className="modal__subtitle">Choose an action for {row.name}.</p>
            </div>
          </div>
          <button type="button" className="modal__close" onClick={onClose} ref={closeButtonRef} aria-label="Close">
            <IconX />
          </button>
        </header>

        <div className="manage-modal__body">
          <div className="manage-modal__summary">
            <div className="manage-summary">
              <div className="manage-summary__identity">
                <PackageIcon name={row.name} />
                <div>
                  <p className="manage-summary__name">{row.name}</p>
                  {row.description !== undefined ? <p className="manage-summary__description">{row.description}</p> : null}
                </div>
              </div>
              <p className="manage-summary__version">
                {row.current ?? row.range}
                <span className="status-badge">{CLASSIFICATION_LABEL[classificationOf(row)]}</span>
              </p>

              <dl className="manage-glance">
                <GlanceRow label="Installed version">{row.current ?? row.range}</GlanceRow>
                <GlanceRow label="Latest version">{row.latest ?? '—'}</GlanceRow>
                <GlanceRow label="Update available">
                  {row.upgradeTo === null ? 'None' : updateKind !== null ? UPDATE_KIND_LABEL[updateKind] : 'Yes'}
                </GlanceRow>
                <GlanceRow label="Usage analysis">
                  {entry === undefined ? 'Not analyzed' : REMOVAL_IMPACT_LABEL[entry.assessment.status]}
                </GlanceRow>
                <GlanceRow label="Required as peer">{peerCount === null ? 'Not analyzed' : `${peerCount}`}</GlanceRow>
              </dl>
            </div>

            <ManageVulnerabilitySummary row={row} onOpenDetails={() => onViewReferences(row.name)} />
          </div>

          <div className="manage-modal__actions">
            <h3 className="manage-modal__actions-heading">Available actions</h3>
            <div className="manage-action-cards">
              <UpgradeCard row={row} remediation={remediation} actionsDisabled={actionsDisabled} onReviewUpgrade={(target) => onReviewUpgrade(row.name, target)} />
              <RemoveCard
                row={row}
                removalImpact={removalImpact}
                actionsDisabled={actionsDisabled}
                onAnalyzeRemovalImpact={() => onAnalyzeRemovalImpact([row.name])}
                onCancelRemovalImpact={onCancelRemovalImpact}
                onViewReferences={() => onViewReferences(row.name)}
                onRemove={() => onRemove(row.name)}
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

        <footer className="modal__footer">
          <p className="manage-modal__footer-note">
            Analysis does not modify your project. Registry metadata and the local package manager may be used during
            analysis.
          </p>
          <button type="button" className="button button--secondary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
