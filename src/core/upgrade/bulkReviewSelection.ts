import type { RemovalAssessment } from '../types.js';
import { MAX_BULK_REMOVE_CHANGES } from './validate.js';

export interface BulkReviewRow {
  name: string;
}

export interface BulkReviewAssessmentEntry {
  assessment: Pick<RemovalAssessment, 'status'>;
}

export type BulkReviewAssessments = ReadonlyMap<string, BulkReviewAssessmentEntry>;

export interface BulkReviewBatch<Row extends BulkReviewRow> {
  rows: readonly Row[];
  totalCount: number;
  overflowCount: number;
}

/** One ordered batch shared by the review UI and every action launched from it. */
export function canonicalBulkReviewBatch<Row extends BulkReviewRow>(rows: readonly Row[]): BulkReviewBatch<Row> {
  return {
    rows: rows.slice(0, MAX_BULK_REMOVE_CHANGES),
    totalCount: rows.length,
    overflowCount: Math.max(0, rows.length - MAX_BULK_REMOVE_CHANGES),
  };
}

/** A missing entry belongs to a different/partial result and remains unanalyzed. */
export function bulkReviewStatus(
  packageName: string,
  completedAssessments: BulkReviewAssessments | undefined
): RemovalAssessment['status'] | undefined {
  if (completedAssessments === undefined) return undefined;
  return completedAssessments.get(packageName)?.assessment.status;
}

/** Review findings may be deliberately overridden; unknown and blocked findings may not. */
export function canIndividuallySelectBulkReviewRow(status: RemovalAssessment['status'] | undefined): boolean {
  return status !== 'blocked' && status !== 'unknown';
}

/** Bulk selection is deliberately narrower after analysis: it only opts in low-risk rows. */
export function canBulkSelectBulkReviewRow(status: RemovalAssessment['status'] | undefined): boolean {
  return status === undefined || status === 'low-risk';
}

/** Completed impact analysis defaults every result except low-risk to unselected. */
export function deselectNonLowRiskRows<Row extends BulkReviewRow>(
  previous: ReadonlySet<string>,
  rows: readonly Row[],
  assessments: BulkReviewAssessments
): ReadonlySet<string> {
  const next = new Set(previous);
  for (const row of rows) {
    const status = bulkReviewStatus(row.name, assessments);
    if (status !== undefined && status !== 'low-risk') next.add(row.name);
  }
  return next;
}

/**
 * The review's single bulk control changes only rows that are safe for bulk
 * selection in the current context. It never clears a blocked/unknown row's
 * deselection marker.
 */
export function toggleSafeBulkReviewSelection<Row extends BulkReviewRow>(
  previous: ReadonlySet<string>,
  rows: readonly Row[],
  completedAssessments: BulkReviewAssessments | undefined
): ReadonlySet<string> {
  const selectableNames = rows
    .filter((row) => canBulkSelectBulkReviewRow(bulkReviewStatus(row.name, completedAssessments)))
    .map((row) => row.name);
  if (selectableNames.length === 0) return previous;

  const clearSelectable = selectableNames.every((name) => !previous.has(name));
  const next = new Set(previous);
  for (const name of selectableNames) {
    if (clearSelectable) next.add(name);
    else next.delete(name);
  }
  return next;
}

/** Derives the only rows actions may receive, independently of checkbox rendering. */
export function selectedBulkReviewRows<Row extends BulkReviewRow>(
  rows: readonly Row[],
  deselected: ReadonlySet<string>,
  completedAssessments: BulkReviewAssessments | undefined
): readonly Row[] {
  return rows.filter((row) => {
    if (deselected.has(row.name)) return false;
    return canIndividuallySelectBulkReviewRow(bulkReviewStatus(row.name, completedAssessments));
  });
}

/** Exact equality between the current selection and a sorted, unique analysis package list. */
export function canonicalPackageSelectionMatches(
  selectedNames: readonly string[],
  analyzedPackages: readonly string[]
): boolean {
  if (selectedNames.length !== analyzedPackages.length) return false;
  const canonicalSelection = [...new Set(selectedNames)].sort((left, right) => left.localeCompare(right));
  return (
    canonicalSelection.length === selectedNames.length &&
    canonicalSelection.every((name, index) => analyzedPackages[index] === name)
  );
}
