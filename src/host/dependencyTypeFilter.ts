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
