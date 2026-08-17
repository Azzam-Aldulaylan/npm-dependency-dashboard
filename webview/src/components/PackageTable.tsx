import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { DependencyFinding } from '../../../src/core/hygiene/types.js';
import { ownDuplicateFinding } from '../../../src/host/dependencyDetailsCopy.js';
import type { SortColumn, TableSortState } from '../../../src/host/tableSort.js';
import { resolveActionState } from '../../../src/host/upgradeAction.js';
import type { TransitiveRemediationUiState } from '../../../src/host/upgradeAction.js';
import {
  IconAlertTriangle,
  IconChevronRight,
  IconCheck,
  IconHelpCircle,
  IconRefresh,
  IconRoute,
  IconSortArrow,
  IconSortNeutral,
  IconTarget,
} from '../icons.js';
import { AdvisoryDetails } from './AdvisoryDetails.js';
import { PackageIcon } from './PackageIcon.js';
import { RowActionsMenu } from './RowActionsMenu.js';
import { SeverityBadge } from './SeverityBadge.js';
import { StatusBadge } from './StatusBadge.js';
import { InfoTooltip } from './Tooltip.js';
import {
  AvailableHeaderInfo,
  AvailableHeaderLabel,
  AvailableVersionCell,
  CurrentHeaderLabel,
  CurrentVersionCell,
} from './VersionCell.js';

/**
 * A `<th>` whose label doubles as a sort trigger — `none -> asc -> desc ->
 * none` on click, `aria-sort` kept in lockstep. `extra` renders as the
 * button's *sibling*, never its child: a `<button>` cannot legally contain
 * another interactive element (see VersionCell's AvailableHeaderInfo doc),
 * which the Available column's info trigger needs to be.
 */
function SortableHeader({
  column,
  label,
  extra,
  sortState,
  onSort,
}: {
  column: SortColumn;
  label: ReactNode;
  extra?: ReactNode;
  sortState: TableSortState;
  onSort: (column: SortColumn) => void;
}): ReactElement {
  const direction = sortState !== null && sortState.column === column ? sortState.direction : null;
  const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
  return (
    <th scope="col" aria-sort={ariaSort} className="sortable-header">
      <span className="sortable-header__row">
        <button
          type="button"
          className="sort-header"
          onClick={() => {
            onSort(column);
          }}
        >
          <span>{label}</span>
          {direction === null ? (
            <IconSortNeutral className="sort-header__icon sort-header__icon--neutral" />
          ) : (
            <IconSortArrow className={`sort-header__icon${direction === 'desc' ? ' sort-header__icon--desc' : ''}`} />
          )}
        </button>
        {extra}
      </span>
    </th>
  );
}

/**
 * The Action cell's quiet, non-clickable states — Up to date, Unavailable,
 * and every transitive-remediation result — share one layout: an icon, a
 * label, and (except Up to date, which needs no further explanation) an
 * InfoTooltip carrying the host-computed reason. Structured this way rather
 * than a `title` attribute so the reason is reachable by hover, focus, and
 * click alike — see Tooltip.tsx's own doc.
 */
function QuietAction({
  icon,
  label,
  tooltipLabel,
  tooltip,
  muted,
  tone,
}: {
  icon?: ReactNode;
  label: string;
  /** Omitted only for Up to date, which is self-explanatory without a popover. */
  tooltipLabel?: string;
  tooltip?: string;
  muted?: boolean;
  tone?: 'resolved';
}): ReactElement {
  return (
    <span className={`action-quiet${muted === true ? ' action-quiet--muted' : ''}${tone === 'resolved' ? ' action-quiet--resolved' : ''}`}>
      {icon}
      {label}
      {tooltipLabel !== undefined && tooltip !== undefined ? (
        <InfoTooltip label={tooltipLabel} content={<p>{tooltip}</p>} />
      ) : null}
    </span>
  );
}

/**
 * Every clickable branch here sends the identical `{ package, target }`
 * upgrade message through the identical host-owned validate/preflight/
 * confirm/install pipeline (see resolveActionState's own doc) — only the
 * label, tooltip, and visual weight change with what the host has already
 * decided is on offer. "Analyze remediation" is the one exception: it sends
 * only a package name (see analyze-remediation's own doc in
 * webviewProtocol.ts) through an entirely separate, read-only host flow.
 */
function UpgradeAction({
  row,
  activeUpgrade,
  onUpgrade,
  upgradesDisabled,
  remediation,
  onAnalyzeRemediation,
}: {
  row: PackageRow;
  /** The one package this webview asked to upgrade, or null. The host allows only one upgrade at a time for the whole panel, so every button is disabled while this is set — not just the row it names. */
  activeUpgrade: string | null;
  onUpgrade: (packageName: string, target: string) => void;
  /** UX only — the host rejects the request either way (see PackageTable's own doc). */
  upgradesDisabled: boolean;
  /** This row's own remediation-analysis phase/result, if any has been requested this session — see App.tsx. */
  remediation: TransitiveRemediationUiState | undefined;
  onAnalyzeRemediation: (packageName: string) => void;
}): ReactElement {
  const state = resolveActionState(row, remediation);

  if (state.kind === 'up-to-date') {
    return <QuietAction icon={<IconCheck className="action-quiet__icon" />} label="Up to date" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <QuietAction label="Unavailable" muted tooltipLabel="Why this dependency has no upgrade action" tooltip={state.tooltip} />
    );
  }
  if (state.kind === 'no-direct-fix') {
    return (
      <QuietAction
        icon={<IconAlertTriangle className="action-quiet__icon action-quiet__icon--warning" />}
        label="No direct fix"
        muted
        tooltipLabel="Why there is no direct fix"
        tooltip={state.tooltip}
      />
    );
  }
  if (state.kind === 'remediation-unknown') {
    return (
      <QuietAction
        icon={<IconHelpCircle className="action-quiet__icon" />}
        label="Remediation unknown"
        muted
        tooltipLabel="Why remediation is unknown"
        tooltip={state.tooltip}
      />
    );
  }
  if (state.kind === 'remediation-resolved') {
    return (
      <QuietAction
        icon={<IconCheck className="action-quiet__icon action-quiet__icon--resolved" />}
        label="Fix available"
        tone="resolved"
        tooltipLabel="How this fix works"
        tooltip={state.tooltip}
      />
    );
  }
  if (state.kind === 'remediation-analyzing') {
    return (
      <QuietAction
        icon={<IconRefresh className="action-quiet__icon action-quiet__icon--spin" />}
        label="Analyzing…"
        muted
      />
    );
  }

  const isThisRowUpgrading = activeUpgrade === row.name;
  const disabled = activeUpgrade !== null || upgradesDisabled;

  if (state.kind === 'transitive-remediation') {
    return (
      <button
        className="button button--analyze"
        type="button"
        disabled={disabled}
        title={
          upgradesDisabled ? 'Dependency data is being refreshed — try again once it finishes.' : state.tooltip
        }
        onClick={() => {
          onAnalyzeRemediation(row.name);
        }}
      >
        <IconRoute />
        {state.label}
      </button>
    );
  }

  const tone =
    state.kind === 'security-fix' ? 'button--security' : state.updateKind === 'major' ? 'button--analyze' : 'button--subtle';

  return (
    <button
      className={`button ${tone}`}
      type="button"
      disabled={disabled}
      title={
        isThisRowUpgrading
          ? 'Upgrade in progress…'
          : upgradesDisabled
            ? 'Dependency data is being refreshed — try again once it finishes.'
            : state.tooltip
      }
      onClick={() => {
        onUpgrade(row.name, state.target);
      }}
    >
      {isThisRowUpgrading ? 'Upgrading…' : state.label}
    </button>
  );
}

export function PackageTable({
  rows,
  activeUpgrade,
  onUpgrade,
  upgradesDisabled,
  sortState,
  onSort,
  onOpenAdvisory,
  remediationByPackage,
  onAnalyzeRemediation,
  hygieneFindings,
  onOpenDetails,
  onWhereUsed,
}: {
  rows: readonly PackageRow[];
  activeUpgrade: string | null;
  onUpgrade: (packageName: string, target: string) => void;
  /**
   * True whenever the host is displaying stale/revalidating data — a UX
   * nicety, not the security boundary: `DashboardController.isEligible`
   * independently rejects any Upgrade request the host itself considers
   * stale, regardless of what this prop says.
   */
  upgradesDisabled: boolean;
  sortState: TableSortState;
  onSort: (column: SortColumn) => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
  /** This webview session's own "Analyze remediation" phase/result per package — see App.tsx; never persisted, never a fact from the host's own scan. */
  remediationByPackage: ReadonlyMap<string, TransitiveRemediationUiState>;
  onAnalyzeRemediation: (packageName: string) => void;
  /** Deprecated + duplicate-version findings from the current scan, plus any likely-unused findings from a completed "Analyze cleanup" run — see App.tsx. */
  hygieneFindings: readonly DependencyFinding[];
  onOpenDetails: (packageName: string) => void;
  onWhereUsed: (packageName: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (name: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  };

  return (
    <div className="packages-container">
      <table className="packages">
        <colgroup>
          <col className="col-disclosure" />
          <col className="col-package" />
          <col className="col-current" />
          <col className="col-available" />
          <col className="col-vulnerabilities" />
          <col className="col-action" />
          <col className="col-row-menu" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="packages__disclosure" />
            <SortableHeader column="package" label="Package" sortState={sortState} onSort={onSort} />
            <SortableHeader column="current" label={<CurrentHeaderLabel />} sortState={sortState} onSort={onSort} />
            <SortableHeader
              column="available"
              label={<AvailableHeaderLabel />}
              extra={<AvailableHeaderInfo />}
              sortState={sortState}
              onSort={onSort}
            />
            <SortableHeader column="vulnerabilities" label="Vulnerabilities" sortState={sortState} onSort={onSort} />
            <th scope="col">Action</th>
            <th scope="col" className="packages__row-menu-header">
              <span className="sr-only">More actions</span>
            </th>
          </tr>
        </thead>
        {rows.map((row) => {
          const expandable = row.advisories.length > 0;
          const isOpen = expandable && expanded.has(row.name);
          const duplicateFinding = ownDuplicateFinding(hygieneFindings, row.name);
          const unusedFinding = hygieneFindings.find(
            (finding) => finding.kind === 'likely-unused' && finding.packageName === row.name
          );
          return (
            <tbody key={row.name}>
              <tr>
                <td className="packages__disclosure">
                  {expandable ? (
                    <button
                      className="disclosure"
                      type="button"
                      data-open={isOpen ? 'true' : undefined}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Hide' : 'Show'} advisories for ${row.name}`}
                      onClick={() => {
                        toggle(row.name);
                      }}
                    >
                      <IconChevronRight />
                    </button>
                  ) : null}
                </td>
                <th scope="row" className="packages__name">
                  <PackageIcon name={row.name} />
                  <span className="packages__name-text">{row.name}</span>
                  {row.dev ? <StatusBadge label="Dev" /> : null}
                  {row.deprecated !== undefined ? (
                    <StatusBadge label="Deprecated" tone="warning" title={row.deprecated} />
                  ) : null}
                  {duplicateFinding !== undefined ? (
                    <StatusBadge label="Duplicate versions" tone="warning" title={duplicateFinding.summary} />
                  ) : null}
                  {unusedFinding?.evidence.kind === 'likely-unused' ? (
                    <StatusBadge
                      label={unusedFinding.confidence === 'high' ? 'Likely unused' : 'Possibly unused'}
                      tone="warning"
                      title={unusedFinding.evidence.reason}
                    />
                  ) : null}
                </th>
                <td className="packages__wrap">
                  <CurrentVersionCell row={row} />
                </td>
                <td className="packages__wrap">
                  <AvailableVersionCell row={row} />
                </td>
                <td>
                  <SeverityBadge severity={row.worstSeverity} />
                </td>
                <td>
                  <UpgradeAction
                    row={row}
                    activeUpgrade={activeUpgrade}
                    onUpgrade={onUpgrade}
                    upgradesDisabled={upgradesDisabled}
                    remediation={remediationByPackage.get(row.name)}
                    onAnalyzeRemediation={onAnalyzeRemediation}
                  />
                </td>
                <td className="packages__row-menu">
                  <RowActionsMenu
                    label={`More actions for ${row.name}`}
                    items={[
                      {
                        key: 'where-used',
                        label: 'Where is this used?',
                        icon: <IconTarget />,
                        onSelect: () => {
                          onWhereUsed(row.name);
                        },
                      },
                      {
                        key: 'details',
                        label: 'Dependency details',
                        onSelect: () => {
                          onOpenDetails(row.name);
                        },
                      },
                    ]}
                  />
                </td>
              </tr>
              {isOpen ? (
                <tr className="packages__details">
                  <td colSpan={7}>
                    <AdvisoryDetails packageName={row.name} advisories={row.advisories} onOpenAdvisory={onOpenAdvisory} />
                  </td>
                </tr>
              ) : null}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
