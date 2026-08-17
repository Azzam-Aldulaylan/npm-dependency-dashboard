/**
 * Table sorting — both the five clickable-header comparators and the
 * "intelligent default" order each summary card implies before the user
 * ever touches a header. Pure and local: nothing here re-fetches or
 * re-scans, matching the rest of src/host's display-only pure functions
 * (see severityDisplay.ts for why this lives here rather than webview/src).
 */

import semver from 'semver';

import type { PackageRow, Severity } from '../core/types.js';
import type { SummaryFilterId } from './summaryMetrics.js';
import { UPDATE_KIND_RANK, classifyRowUpdate } from './updateClassification.js';

export type SortColumn = 'package' | 'current' | 'available' | 'vulnerabilities' | 'type';
export type SortDirection = 'asc' | 'desc';

export interface ColumnSortState {
  column: SortColumn;
  direction: SortDirection;
}

/**
 * `null` means "no manual sort" — the table falls back to whichever order
 * the selected summary card implies (see cardDefaultComparator). Set by a
 * header click; cleared by cycling a third click (desc -> none) or by
 * selecting a different summary card, which always re-asserts that card's
 * own default over anything manual — see the App.tsx wiring.
 */
export type TableSortState = ColumnSortState | null;

/**
 * `none -> ascending -> descending -> none` — the three-state cycle a
 * header click drives. Clicking a *different* column always starts that
 * column fresh at `ascending`, regardless of the previous column's state.
 */
export function nextColumnSortState(current: TableSortState, clicked: SortColumn): TableSortState {
  if (current === null || current.column !== clicked) return { column: clicked, direction: 'asc' };
  if (current.direction === 'asc') return { column: clicked, direction: 'desc' };
  return null;
}

function byName(a: PackageRow, b: PackageRow): number {
  return a.name.localeCompare(b.name);
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

/** Higher is worse/more urgent. `null` (no advisories) ranks below every real severity. */
function severityRank(severity: Severity | null): number {
  return severity === null ? -1 : SEVERITY_RANK[severity];
}

/**
 * Critical > High > (a reserved slot for a future compatibility/blocked-
 * upgrade signal, rank 2 — PackageRow carries no such data today, so this
 * task doesn't populate it; see rowNeedsAttention's own doc) > Deprecated >
 * everything else. Only meaningful among rows `rowNeedsAttention` already
 * selected (critical/high severity or deprecated); anything else sorts to
 * the bottom by falling through to 0, which never happens once the Needs
 * Attention filter has already narrowed the rows this ranks.
 */
function attentionRank(row: PackageRow): number {
  if (row.worstSeverity === 'critical') return 4;
  if (row.worstSeverity === 'high') return 3;
  // rank 2 reserved for a compatibility/blocked-upgrade signal, not yet available.
  if (row.deprecated !== undefined) return 1;
  return 0;
}

/** `null`/invalid-semver values always sort after every real version, in either direction. */
function compareVersions(a: string | null, b: string | null): number {
  const validA = a !== null && semver.valid(a) !== null;
  const validB = b !== null && semver.valid(b) !== null;
  if (!validA && !validB) return 0;
  if (!validA) return 1;
  if (!validB) return -1;
  return semver.compare(a as string, b as string);
}

/** The single version this row's "Available" column represents, for sorting purposes only. */
function availableSortValue(row: PackageRow): string | null {
  return row.latest ?? row.wanted ?? null;
}

const COLUMN_COMPARATORS: Record<SortColumn, (a: PackageRow, b: PackageRow) => number> = {
  package: byName,
  current: (a, b) => compareVersions(a.current, b.current),
  available: (a, b) => compareVersions(availableSortValue(a), availableSortValue(b)),
  vulnerabilities: (a, b) => severityRank(a.worstSeverity) - severityRank(b.worstSeverity),
  type: (a, b) => Number(a.dev) - Number(b.dev),
};

/**
 * Whether a row has no sortable value at all for a column — a missing
 * current/available version, never a "worst" position on some real scale
 * (a clean `worstSeverity: null` row is a legitimate, sortable "Safe", not
 * empty). Only these two columns need this: their rows must stay pinned
 * after every real value in *both* directions, which a plain sign flip on
 * the base comparator cannot express — negating "always last" for a
 * descending sort would turn it into "always first".
 */
const COLUMN_IS_EMPTY: Partial<Record<SortColumn, (row: PackageRow) => boolean>> = {
  current: (row) => row.current === null || semver.valid(row.current) === null,
  available: (row) => {
    const value = availableSortValue(row);
    return value === null || semver.valid(value) === null;
  },
};

/**
 * A manual header sort — always tie-broken by package name (ascending,
 * regardless of the column's own direction) so equal-ranked rows don't
 * visibly shuffle between renders.
 */
export function columnSortComparator(
  column: SortColumn,
  direction: SortDirection
): (a: PackageRow, b: PackageRow) => number {
  const base = COLUMN_COMPARATORS[column];
  const isEmpty = COLUMN_IS_EMPTY[column];
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    if (isEmpty !== undefined) {
      const emptyA = isEmpty(a);
      const emptyB = isEmpty(b);
      if (emptyA || emptyB) {
        if (emptyA && emptyB) return byName(a, b);
        return emptyA ? 1 : -1;
      }
    }
    return sign * base(a, b) || byName(a, b);
  };
}

/**
 * The order a summary card implies before any header is clicked — see the
 * spec's "Intelligent Default Sorting". `updates` and `vulnerabilities`
 * rank by tier/severity, not by the literal version number, which is a
 * deliberately different question from the `available`/`vulnerabilities`
 * *column* comparators above (those sort by actual value on request).
 */
function updateTierRank(row: PackageRow): number {
  const kind = classifyRowUpdate(row);
  return kind === null ? 0 : UPDATE_KIND_RANK[kind];
}

export function cardDefaultComparator(filter: SummaryFilterId): (a: PackageRow, b: PackageRow) => number {
  if (filter === 'updates') {
    return (a, b) => updateTierRank(b) - updateTierRank(a) || byName(a, b);
  }
  if (filter === 'vulnerabilities') {
    return (a, b) => severityRank(b.worstSeverity) - severityRank(a.worstSeverity) || byName(a, b);
  }
  if (filter === 'attention') {
    return (a, b) => attentionRank(b) - attentionRank(a) || byName(a, b);
  }
  return byName;
}

/** Resolves the active comparator: a manual header sort if one is set, otherwise the selected card's default. */
export function resolveSortComparator(
  sortState: TableSortState,
  filter: SummaryFilterId
): (a: PackageRow, b: PackageRow) => number {
  if (sortState !== null) return columnSortComparator(sortState.column, sortState.direction);
  return cardDefaultComparator(filter);
}

export function sortRows(
  rows: readonly PackageRow[],
  sortState: TableSortState,
  filter: SummaryFilterId
): PackageRow[] {
  return [...rows].sort(resolveSortComparator(sortState, filter));
}
