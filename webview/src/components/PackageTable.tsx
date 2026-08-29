import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { DependencyFinding } from '../../../src/core/hygiene/types.js';
import { introducedDuplicateFindings, ownDuplicateFinding } from '../../../src/host/dependencyDetailsCopy.js';
import { dependencyRowSearchTargetsAdvisory } from '../../../src/host/vulnerabilityUiState.js';
import type { SortColumn, TableSortState } from '../../../src/host/tableSort.js';
import { IconChevronRight, IconSliders, IconSortArrow, IconSortNeutral } from '../icons.js';
import { AdvisoryDetails } from './AdvisoryDetails.js';
import { PackageIcon } from './PackageIcon.js';
import { SeverityBadge } from './SeverityBadge.js';
import { StatusBadge } from './StatusBadge.js';
import { InfoTooltip } from './Tooltip.js';
import {
  AvailableHeaderInfo,
  AvailableHeaderLabel,
  AvailableVersionCell,
  CurrentHeaderInfo,
  CurrentHeaderLabel,
  CurrentVersionCell,
} from './VersionCell.js';

/**
 * The "why does this badge show up" explanation for every tag the Package
 * column can attach to a row — one place, read once, rather than a reader
 * having to infer meaning from five differently-worded `title` attributes.
 * Mirrors AvailableHeaderInfo's own dl-of-terms pattern (VersionCell.tsx).
 */
function PackageTagsInfo(): ReactElement {
  return (
    <InfoTooltip
      label="What these tags mean"
      content={
        <dl>
          <dt>Dev</dt>
          <dd>Declared in devDependencies — used while developing, not at runtime.</dd>
          <dt>Deprecated</dt>
          <dd>The maintainer marked this exact version unsupported on the registry.</dd>
          <dt>Duplicate versions</dt>
          <dd>More than one version of this package is installed somewhere in the dependency tree.</dd>
          <dt>Introduces duplicates</dt>
          <dd>A package this one depends on resolves to more than one version elsewhere in the tree — this row is the direct dependency responsible for pulling one of those versions in.</dd>
          <dt>Likely / possibly unused</dt>
          <dd>No reference to this package was found in your source files. "Possibly" means the scan was less certain — the file scan hit its cap, or this package is commonly loaded without a direct import (a CLI tool, a config-driven plugin).</dd>
        </dl>
      }
    />
  );
}

/**
 * What the Action column's one button does — every row uses the identical
 * button, regardless of this row's own upgrade/vulnerability/removal state.
 * Manage opens the full dependency workspace (see ManageDependencyModal.tsx)
 * — Overview, Vulnerabilities, Usage & references, Upgrade review, and
 * Removal review all live there now; nothing about risk or eligibility is
 * encoded in the button itself.
 */
function ActionColumnInfo(): ReactElement {
  return (
    <InfoTooltip
      label="What the action button means"
      content={
        <dl>
          <dt>Manage</dt>
          <dd>
            Opens the dependency workspace — overview, full vulnerability details, usage &amp; references, and Upgrade
            or Removal review, all in one place.
          </dd>
        </dl>
      }
    />
  );
}

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
      {/*
       * The row itself (not just the button) carries the click handler so the
       * whole header cell stays clickable the way a bare `flex: 1` button
       * previously achieved — but a stretched button pushed `extra` (the info
       * trigger) all the way to the cell's far edge, away from `label`. Sizing
       * the button to its content and letting `extra` sit immediately after it
       * keeps "CURRENT ⓘ" adjacent while a click anywhere in the row still
       * sorts.
       *
       * The `<button>` itself carries no click handler of its own — a native
       * click (mouse, or Enter/Space while it's focused) bubbles up to this
       * row's own onClick, so keyboard activation still works and nothing
       * fires the sort twice. InfoTooltip's own trigger calls
       * stopPropagation on click, so clicking the icon opens the popover
       * instead of also triggering a sort.
       */}
      <span
        className="sortable-header__row"
        onClick={() => {
          onSort(column);
        }}
      >
        <button type="button" className="sort-header">
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
 * The row's one entry point into Upgrade/Remove/Check-transitive-fixes —
 * see ManageDependencyModal.tsx. Deliberately the identical button on every
 * row regardless of this row's own upgrade/vulnerability/removal state:
 * risk and eligibility are communicated inside the modal (badges, versions,
 * structured reasons), never by varying this button's color or label — see
 * the redesign brief's own "do not use different button colors with the
 * same text to encode hidden risk meaning."
 */
function ManageButton({ row, onOpenManage }: { row: PackageRow; onOpenManage: (packageName: string) => void }): ReactElement {
  return (
    <button
      type="button"
      className="button packages__manage-button"
      onClick={() => {
        onOpenManage(row.name);
      }}
    >
      <IconSliders />
      Manage
    </button>
  );
}

export function PackageTable({
  rows,
  unavailableUpdatePackages,
  advisoriesAvailable,
  searchQuery,
  sortState,
  onSort,
  onOpenAdvisory,
  hygieneFindings,
  onOpenManage,
}: {
  rows: readonly PackageRow[];
  unavailableUpdatePackages: ReadonlySet<string>;
  advisoriesAvailable: boolean;
  searchQuery: string;
  sortState: TableSortState;
  onSort: (column: SortColumn) => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[], reference?: string) => void;
  /** Deprecated + duplicate-version findings from the current scan, plus any likely-unused findings from a completed "Analyze cleanup" run — see App.tsx. */
  hygieneFindings: readonly DependencyFinding[];
  onOpenManage: (packageName: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const [suppressedSearchExpansion, setSuppressedSearchExpansion] = useState<{
    query: string;
    packageNames: ReadonlySet<string>;
  }>(() => ({ query: normalizedSearchQuery, packageNames: new Set() }));

  useEffect(() => {
    setSuppressedSearchExpansion({ query: normalizedSearchQuery, packageNames: new Set() });
  }, [normalizedSearchQuery]);

  const toggle = (name: string, isOpen: boolean, autoExpansionEligible: boolean): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (isOpen) next.delete(name);
      else next.add(name);
      return next;
    });
    if (autoExpansionEligible) {
      setSuppressedSearchExpansion((previous) => {
        const packageNames = new Set(
          previous.query === normalizedSearchQuery ? previous.packageNames : []
        );
        if (isOpen) packageNames.add(name);
        else packageNames.delete(name);
        return { query: normalizedSearchQuery, packageNames };
      });
    }
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
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="packages__disclosure" />
            <SortableHeader
              column="package"
              label="Package"
              extra={<PackageTagsInfo />}
              sortState={sortState}
              onSort={onSort}
            />
            <SortableHeader
              column="current"
              label={<CurrentHeaderLabel />}
              extra={<CurrentHeaderInfo />}
              sortState={sortState}
              onSort={onSort}
            />
            <SortableHeader
              column="available"
              label={<AvailableHeaderLabel />}
              extra={<AvailableHeaderInfo />}
              sortState={sortState}
              onSort={onSort}
            />
            <SortableHeader column="vulnerabilities" label="Vulnerabilities" sortState={sortState} onSort={onSort} />
            <th scope="col" className="packages__action-header">
              <span className="column-header-with-info">
                Action
                <ActionColumnInfo />
              </span>
            </th>
          </tr>
        </thead>
        {rows.map((row) => {
          const expandable = row.advisories.length > 0;
          const autoExpansionEligible =
            expandable && dependencyRowSearchTargetsAdvisory(row, searchQuery);
          const autoExpanded =
            autoExpansionEligible &&
            !(
              suppressedSearchExpansion.query === normalizedSearchQuery &&
              suppressedSearchExpansion.packageNames.has(row.name)
            );
          const isOpen = expandable && (expanded.has(row.name) || autoExpanded);
          const duplicateFinding = ownDuplicateFinding(hygieneFindings, row.name);
          const introducedDuplicates = introducedDuplicateFindings(hygieneFindings, row.name);
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
                        toggle(row.name, isOpen, autoExpansionEligible);
                      }}
                    >
                      <IconChevronRight />
                    </button>
                  ) : null}
                </td>
                <th scope="row" className="packages__name">
                  <button
                    type="button"
                    className="packages__name-primary packages__name-button"
                    onClick={() => {
                      onOpenManage(row.name);
                    }}
                  >
                    <PackageIcon name={row.name} />
                    <span className="packages__name-text">{row.name}</span>
                  </button>
                  {row.dev ||
                  row.deprecated !== undefined ||
                  duplicateFinding !== undefined ||
                  introducedDuplicates.length > 0 ||
                  unusedFinding !== undefined ? (
                    <span className="packages__name-tags">
                      {row.dev ? <StatusBadge label="Dev" /> : null}
                      {row.deprecated !== undefined ? (
                        <StatusBadge label="Deprecated" tone="warning" title={row.deprecated} />
                      ) : null}
                      {duplicateFinding !== undefined ? (
                        <StatusBadge label="Duplicate versions" tone="warning" title={duplicateFinding.summary} />
                      ) : null}
                      {introducedDuplicates.length > 0 ? (
                        <StatusBadge
                          label="Introduces duplicates"
                          tone="warning"
                          title={introducedDuplicates.map((finding) => finding.summary).join('\n')}
                        />
                      ) : null}
                      {unusedFinding?.evidence.kind === 'likely-unused' ? (
                        <StatusBadge
                          label={unusedFinding.confidence === 'high' ? 'Likely unused' : 'Possibly unused'}
                          tone="warning"
                          title={unusedFinding.evidence.reason}
                        />
                      ) : null}
                    </span>
                  ) : null}
                </th>
                <td className="packages__wrap">
                  <CurrentVersionCell row={row} />
                </td>
                <td className="packages__wrap">
                  <AvailableVersionCell row={row} resolutionAvailable={!unavailableUpdatePackages.has(row.name)} />
                </td>
                <td>
                  <SeverityBadge severity={row.worstSeverity} advisoriesAvailable={advisoriesAvailable} />
                </td>
                <td className="packages__action-cell">
                  <div className="packages__actions">
                    <ManageButton row={row} onOpenManage={onOpenManage} />
                  </div>
                </td>
              </tr>
              {isOpen ? (
                <tr className="packages__details">
                  <td colSpan={6}>
                    <AdvisoryDetails row={row} searchQuery={searchQuery} onOpenAdvisory={onOpenAdvisory} />
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
