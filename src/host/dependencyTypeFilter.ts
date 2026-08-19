/**
 * All/Production/Dev filtering — a thin wrapper over `PackageRow.dev`,
 * which is already the classification the manifest parser derived. Pure
 * and local, like every other predicate in summaryMetrics.ts, which this
 * combines with in the webview rather than replaces.
 */

import type { PackageRow } from '../core/types.js';

export type DependencyTypeFilter = 'all' | 'prod' | 'dev';

export function dependencyTypeFilterPredicate(filter: DependencyTypeFilter): (row: PackageRow) => boolean {
  if (filter === 'prod') return (row) => !row.dev;
  if (filter === 'dev') return (row) => row.dev;
  return () => true;
}

export interface DependencyTypeFilterCounts {
  all: number;
  prod: number;
  dev: number;
}

/**
 * Counts for each option's own button label. `rows` is expected to already
 * be narrowed by whatever *other* filter is active (the Finding filter, in
 * the dashboard toolbar) — this function itself never applies the type
 * filter to its own input, so All/Production/Dev counts move together as a
 * set when another filter changes, the same faceted behavior
 * hygieneFilterCounts already has.
 */
export function dependencyTypeFilterCounts(rows: readonly PackageRow[]): DependencyTypeFilterCounts {
  let dev = 0;
  for (const row of rows) {
    if (row.dev) dev += 1;
  }
  return { all: rows.length, prod: rows.length - dev, dev };
}
