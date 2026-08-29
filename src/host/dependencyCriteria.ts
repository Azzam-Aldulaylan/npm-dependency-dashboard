/**
 * Pure criteria matching for the "Manage dependencies" picker — build a
 * selection by toggling chips (unused/duplicated/deprecated, prod/dev,
 * vulnerability severity, has-update/major-update) rather than picking one
 * action first. A chip within a group is OR'd with its siblings; a group
 * with nothing selected imposes no constraint at all; non-empty groups are
 * AND'd together. Same discipline as hygieneFilter.ts/summaryMetrics.ts:
 * everything here reads only fields already present on `PackageRow` (or the
 * findings already sent alongside it) — no additional fetch, cheap enough
 * to recompute on every keystroke/toggle.
 */

import type { DependencyFinding } from '../core/hygiene/types.js';
import type { PackageRow, Severity } from '../core/types.js';
import type { DependencyTypeFilter } from './dependencyTypeFilter.js';
import type { HygieneFilterId } from './hygieneFilter.js';
import { rowMatchesHygieneFilter } from './hygieneFilter.js';
import { rowHasUpdate, rowIsMajorUpdate } from './summaryMetrics.js';

export type HealthCriterion = 'likely-unused' | 'duplicate-version' | 'deprecated';
export type TypeCriterion = 'prod' | 'dev';
/** Same four levels summaryMetrics.ts's own cards break vulnerabilities down by — 'info' is never surfaced as its own user-facing category anywhere in this dashboard. */
export type SeverityCriterion = Exclude<Severity, 'info'>;
export type UpdateCriterion = 'has-update' | 'major-update';

export interface SelectedCriteria {
  health: ReadonlySet<HealthCriterion>;
  type: ReadonlySet<TypeCriterion>;
  severity: ReadonlySet<SeverityCriterion>;
  updates: ReadonlySet<UpdateCriterion>;
}

export function emptyCriteria(): SelectedCriteria {
  return { health: new Set(), type: new Set(), severity: new Set(), updates: new Set() };
}

/** Carry the dashboard's visible maintenance scope into the bulk picker. */
export function criteriaFromDashboardFilters(
  hygieneFilter: HygieneFilterId,
  dependencyType: DependencyTypeFilter
): SelectedCriteria {
  return {
    health: hygieneFilter === 'all' ? new Set() : new Set([hygieneFilter]),
    type: dependencyType === 'all' ? new Set() : new Set([dependencyType]),
    severity: new Set(),
    updates: new Set(),
  };
}

/** Single source of truth for chip/tag text — both the picker's chips and a matched row's "why matched" tags read from here, so they never drift apart. */
export const HEALTH_LABELS: Record<HealthCriterion, string> = {
  'likely-unused': 'Likely unused',
  'duplicate-version': 'Duplicated',
  deprecated: 'Deprecated',
};
export const TYPE_LABELS: Record<TypeCriterion, string> = { prod: 'Prod', dev: 'Dev' };
export const SEVERITY_LABELS: Record<SeverityCriterion, string> = {
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
};
export const UPDATE_LABELS: Record<UpdateCriterion, string> = {
  'has-update': 'Update available',
  'major-update': 'Major update',
};

export function hasAnyCriterionSelected(selected: SelectedCriteria): boolean {
  return selected.health.size > 0 || selected.type.size > 0 || selected.severity.size > 0 || selected.updates.size > 0;
}

function matchesHealth(row: PackageRow, findings: readonly DependencyFinding[], selected: ReadonlySet<HealthCriterion>): boolean {
  if (selected.size === 0) return true;
  return [...selected].some((criterion) => {
    if (criterion === 'deprecated') return row.deprecated !== undefined;
    return rowMatchesHygieneFilter(row, criterion, findings);
  });
}

function matchesType(row: PackageRow, selected: ReadonlySet<TypeCriterion>): boolean {
  if (selected.size === 0) return true;
  return [...selected].some((criterion) => (criterion === 'dev' ? row.dev : !row.dev));
}

function matchesSeverity(row: PackageRow, selected: ReadonlySet<SeverityCriterion>): boolean {
  if (selected.size === 0) return true;
  // 'info' is deliberately not a SeverityCriterion — see its own comment — so it never matches any severity selection.
  return row.worstSeverity !== null && row.worstSeverity !== 'info' && selected.has(row.worstSeverity);
}

function matchesUpdates(row: PackageRow, selected: ReadonlySet<UpdateCriterion>): boolean {
  if (selected.size === 0) return true;
  return [...selected].some((criterion) => (criterion === 'major-update' ? rowIsMajorUpdate(row) : rowHasUpdate(row)));
}

export function rowMatchesCriteria(
  row: PackageRow,
  findings: readonly DependencyFinding[],
  selected: SelectedCriteria
): boolean {
  return (
    matchesHealth(row, findings, selected.health) &&
    matchesType(row, selected.type) &&
    matchesSeverity(row, selected.severity) &&
    matchesUpdates(row, selected.updates)
  );
}

/**
 * Which of the *currently selected* criteria a specific row actually
 * satisfies — the "why matched" tags shown next to a row once it's part of
 * a selection, e.g. "Unused · Dev · High". Only ever describes selected,
 * satisfied criteria; a group with nothing selected never contributes a tag,
 * and a group with a selection the row doesn't happen to satisfy on its own
 * (but the row still matches overall via another group) contributes nothing
 * either — this is "why", not "everything true about this row".
 */
export function matchReasonTags(
  row: PackageRow,
  findings: readonly DependencyFinding[],
  selected: SelectedCriteria
): string[] {
  const tags: string[] = [];
  for (const criterion of selected.health) {
    const matched = criterion === 'deprecated' ? row.deprecated !== undefined : rowMatchesHygieneFilter(row, criterion, findings);
    if (matched) tags.push(HEALTH_LABELS[criterion]);
  }
  for (const criterion of selected.type) {
    if ((criterion === 'dev') === row.dev) tags.push(TYPE_LABELS[criterion]);
  }
  for (const criterion of selected.severity) {
    if (row.worstSeverity === criterion) tags.push(SEVERITY_LABELS[criterion]);
  }
  for (const criterion of selected.updates) {
    const matched = criterion === 'major-update' ? rowIsMajorUpdate(row) : rowHasUpdate(row);
    if (matched) tags.push(UPDATE_LABELS[criterion]);
  }
  return tags;
}

export interface CriteriaSummaryLine {
  group: string;
  text: string;
}

/**
 * Plain-language "what this selection matches" summary, one line per
 * non-empty group — e.g. `{ group: 'Health', text: 'Unused or Duplicated' }`
 * — for the picker's compact active-criteria explainer. Never technical
 * AND/OR syntax; chips within a line are joined with "or" (matching the
 * OR-within-a-group semantics above), and a line is omitted entirely when
 * its group has no selection (an empty group imposes no constraint, so
 * there is nothing true to say about it). Group order matches the picker's
 * own Health/Security/Updates/Type layout; a group's own chip order is the
 * canonical label order, not selection order, so toggling chips in a
 * different sequence never changes the sentence.
 */
export function criteriaSummaryLines(selected: SelectedCriteria): CriteriaSummaryLine[] {
  const lines: CriteriaSummaryLine[] = [];
  const health = (Object.keys(HEALTH_LABELS) as HealthCriterion[]).filter((c) => selected.health.has(c));
  if (health.length > 0) lines.push({ group: 'Health', text: health.map((c) => HEALTH_LABELS[c]).join(' or ') });
  const severity = (Object.keys(SEVERITY_LABELS) as SeverityCriterion[]).filter((c) => selected.severity.has(c));
  if (severity.length > 0) {
    lines.push({ group: 'Security', text: severity.map((c) => SEVERITY_LABELS[c]).join(' or ') });
  }
  const updates = (Object.keys(UPDATE_LABELS) as UpdateCriterion[]).filter((c) => selected.updates.has(c));
  if (updates.length > 0) lines.push({ group: 'Updates', text: updates.map((c) => UPDATE_LABELS[c]).join(' or ') });
  const type = (Object.keys(TYPE_LABELS) as TypeCriterion[]).filter((c) => selected.type.has(c));
  if (type.length > 0) lines.push({ group: 'Type', text: type.map((c) => TYPE_LABELS[c]).join(' or ') });
  return lines;
}

export function criteriaPredicate(
  selected: SelectedCriteria,
  findings: readonly DependencyFinding[]
): (row: PackageRow) => boolean {
  return (row) => rowMatchesCriteria(row, findings, selected);
}

export interface CriteriaCounts {
  health: Record<HealthCriterion, number>;
  type: Record<TypeCriterion, number>;
  severity: Record<SeverityCriterion, number>;
  updates: Record<UpdateCriterion, number>;
}

/**
 * Faceted per-chip counts: a group's chip counts are computed against rows
 * already narrowed by every *other* group's current selection — so picking
 * "Likely unused" under Health immediately lowers what Type/Severity/
 * Updates show, reflecting the actual AND-across-groups match, not a count
 * frozen at "how many rows have this property in the whole table". A
 * group's own current selection is deliberately excluded from narrowing
 * *itself* — chips within one group still OR together, so selecting one
 * chip must not zero out its own siblings; only the *other* groups narrow
 * a given group's numbers.
 */
export function criteriaCounts(
  rows: readonly PackageRow[],
  findings: readonly DependencyFinding[],
  selected: SelectedCriteria
): CriteriaCounts {
  const health: Record<HealthCriterion, number> = { 'likely-unused': 0, 'duplicate-version': 0, deprecated: 0 };
  const type: Record<TypeCriterion, number> = { prod: 0, dev: 0 };
  const severity: Record<SeverityCriterion, number> = { critical: 0, high: 0, moderate: 0, low: 0 };
  const updates: Record<UpdateCriterion, number> = { 'has-update': 0, 'major-update': 0 };

  for (const row of rows) {
    if (matchesType(row, selected.type) && matchesSeverity(row, selected.severity) && matchesUpdates(row, selected.updates)) {
      if (rowMatchesHygieneFilter(row, 'likely-unused', findings)) health['likely-unused'] += 1;
      if (rowMatchesHygieneFilter(row, 'duplicate-version', findings)) health['duplicate-version'] += 1;
      if (row.deprecated !== undefined) health.deprecated += 1;
    }
    if (matchesHealth(row, findings, selected.health) && matchesSeverity(row, selected.severity) && matchesUpdates(row, selected.updates)) {
      if (row.dev) type.dev += 1;
      else type.prod += 1;
    }
    if (matchesHealth(row, findings, selected.health) && matchesType(row, selected.type) && matchesUpdates(row, selected.updates)) {
      if (row.worstSeverity !== null && row.worstSeverity !== 'info') severity[row.worstSeverity] += 1;
    }
    if (matchesHealth(row, findings, selected.health) && matchesType(row, selected.type) && matchesSeverity(row, selected.severity)) {
      if (rowHasUpdate(row)) updates['has-update'] += 1;
      if (rowIsMajorUpdate(row)) updates['major-update'] += 1;
    }
  }

  return { health, type, severity, updates };
}
