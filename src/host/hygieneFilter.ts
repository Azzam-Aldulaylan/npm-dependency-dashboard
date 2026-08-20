/**
 * Pure row filtering for on-screen hygiene findings. Dashboard rows are
 * direct dependencies, while duplicate-version findings may describe a
 * transitive package. A direct row therefore matches the duplicate filter
 * when either its own package has multiple resolved versions or one of the
 * duplicate paths starts from that direct dependency.
 */

import type { DependencyFinding } from '../core/hygiene/types.js';
import type { PackageRow } from '../core/types.js';

export type HygieneFilterId = 'all' | 'likely-unused' | 'duplicate-version';

export function rowMatchesHygieneFilter(
  row: PackageRow,
  filter: HygieneFilterId,
  findings: readonly DependencyFinding[]
): boolean {
  if (filter === 'all') return true;
  if (filter === 'likely-unused') {
    return findings.some((finding) => finding.kind === 'likely-unused' && finding.packageName === row.name);
  }
  return findings.some((finding) => {
    if (finding.evidence.kind !== 'duplicate-version') return false;
    if (finding.packageName === row.name) return true;
    return finding.evidence.versions.some((entry) =>
      entry.paths.some((path) => path[0] === row.name)
    );
  });
}

export function hygieneFilterPredicate(
  filter: HygieneFilterId,
  findings: readonly DependencyFinding[]
): (row: PackageRow) => boolean {
  return (row) => rowMatchesHygieneFilter(row, filter, findings);
}

export function hygieneFilterCounts(
  rows: readonly PackageRow[],
  findings: readonly DependencyFinding[]
): Record<Exclude<HygieneFilterId, 'all'>, number> {
  let likelyUnused = 0;
  let duplicateVersion = 0;
  for (const row of rows) {
    if (rowMatchesHygieneFilter(row, 'likely-unused', findings)) likelyUnused += 1;
    if (rowMatchesHygieneFilter(row, 'duplicate-version', findings)) duplicateVersion += 1;
  }
  return { 'likely-unused': likelyUnused, 'duplicate-version': duplicateVersion };
}
