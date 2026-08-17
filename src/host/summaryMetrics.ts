/**
 * Pure derivations for the dashboard's four summary cards (Total, Updates
 * Available, Vulnerabilities, Needs Attention) and the per-row predicates
 * that back their click-to-filter behavior.
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src. Everything here reads only fields already present on
 * `PackageRow` — no additional fetch, no re-running preflight, no calling
 * npm/the registry. Card counts must stay cheap because they are recomputed
 * on every render of the currently loaded rows.
 */

import type { PackageRow, Severity } from '../core/types.js';
import { classifyRowUpdate } from './updateClassification.js';

export type SummaryFilterId = 'all' | 'updates' | 'vulnerabilities' | 'attention';

export interface SummaryMetrics {
  total: number;
  updatesAvailable: number;
  majorUpdates: number;
  vulnerable: number;
  criticalVulnerabilities: number;
  highVulnerabilities: number;
  moderateVulnerabilities: number;
  lowVulnerabilities: number;
  needsAttention: number;
  deprecatedCount: number;
}

/**
 * A newer version than what's installed exists, per `npm outdated` semantics:
 * Wanted (highest in-range) differing from Current, or Latest (highest
 * stable overall) differing from Current — the latter is what surfaces an
 * update sitting outside the declared range (a major bump).
 *
 * A row with no resolved `current` (workspace link, file:/git: specifier, no
 * lockfile, ...) has nothing to compare against, so it never counts as
 * having an update — that mirrors the Action column, which never offers an
 * upgrade for the same rows (see isSafeUpgradeTarget).
 */
export function rowHasUpdate(row: PackageRow): boolean {
  if (row.current === null) return false;
  const wantedDiffers = row.wanted !== null && row.wanted !== row.current;
  const latestDiffers = row.latest !== null && row.latest !== row.current;
  return wantedDiffers || latestDiffers;
}

/** Whether the available update crosses a semver major boundary — see updateClassification.ts. */
export function rowIsMajorUpdate(row: PackageRow): boolean {
  return classifyRowUpdate(row) === 'major';
}

export function rowHasVulnerability(row: PackageRow): boolean {
  return row.worstSeverity !== null;
}

/**
 * Actionable beyond merely being outdated, using only what `PackageRow`
 * already carries: a critical/high advisory, or an upstream deprecation
 * notice. Compatibility conflicts and blocked upgrades are not represented
 * on `PackageRow` at all today (that analysis runs later, during the
 * upgrade-assistant preflight) — this deliberately does not invent a signal
 * the domain model doesn't yet expose.
 */
export function rowNeedsAttention(row: PackageRow): boolean {
  if (row.worstSeverity === 'critical' || row.worstSeverity === 'high') return true;
  if (row.deprecated !== undefined) return true;
  return false;
}

const CARD_PREDICATES: Record<Exclude<SummaryFilterId, 'all'>, (row: PackageRow) => boolean> = {
  updates: rowHasUpdate,
  vulnerabilities: rowHasVulnerability,
  attention: rowNeedsAttention,
};

/** The row-level test a given card's selection applies to the table — `all` matches everything. */
export function summaryFilterPredicate(filter: SummaryFilterId): (row: PackageRow) => boolean {
  if (filter === 'all') return () => true;
  return CARD_PREDICATES[filter];
}

function countSeverity(rows: readonly PackageRow[], severity: Severity): number {
  return rows.reduce((count, row) => (row.worstSeverity === severity ? count + 1 : count), 0);
}

export function summaryMetrics(rows: readonly PackageRow[]): SummaryMetrics {
  let updatesAvailable = 0;
  let majorUpdates = 0;
  let vulnerable = 0;
  let needsAttention = 0;
  let deprecatedCount = 0;

  for (const row of rows) {
    if (rowHasUpdate(row)) {
      updatesAvailable += 1;
      if (rowIsMajorUpdate(row)) majorUpdates += 1;
    }
    if (rowHasVulnerability(row)) vulnerable += 1;
    if (rowNeedsAttention(row)) needsAttention += 1;
    if (row.deprecated !== undefined) deprecatedCount += 1;
  }

  return {
    total: rows.length,
    updatesAvailable,
    majorUpdates,
    vulnerable,
    criticalVulnerabilities: countSeverity(rows, 'critical'),
    highVulnerabilities: countSeverity(rows, 'high'),
    moderateVulnerabilities: countSeverity(rows, 'moderate'),
    lowVulnerabilities: countSeverity(rows, 'low'),
    needsAttention,
    deprecatedCount,
  };
}

/**
 * The second line under each card's headline count — every card's version of
 * "why should I care," never filler. `null` means the card has nothing worth
 * saying beyond its own count.
 */

export function updatesCardSubtitle(metrics: SummaryMetrics): string {
  if (metrics.updatesAvailable === 0) return 'Up to date';
  if (metrics.majorUpdates > 0) return `${metrics.majorUpdates} major`;
  if (metrics.total === 0) return '';
  const percent = Math.round((metrics.updatesAvailable / metrics.total) * 100);
  return `${percent}% of dependencies`;
}

const SEVERITY_LABELS: Record<'critical' | 'high' | 'moderate' | 'low', string> = {
  critical: 'critical',
  high: 'high',
  moderate: 'moderate',
  low: 'low',
};

/** Highest-severity-first, at most two categories — long enough to be useful, short enough to stay a subtitle. */
export function vulnerabilitiesCardSubtitle(metrics: SummaryMetrics): string {
  if (metrics.vulnerable === 0) return 'No known vulnerabilities';
  const counts: [keyof typeof SEVERITY_LABELS, number][] = [
    ['critical', metrics.criticalVulnerabilities],
    ['high', metrics.highVulnerabilities],
    ['moderate', metrics.moderateVulnerabilities],
    ['low', metrics.lowVulnerabilities],
  ];
  return counts
    .filter(([, count]) => count > 0)
    .slice(0, 2)
    .map(([severity, count]) => `${count} ${SEVERITY_LABELS[severity]}`)
    .join(' · ');
}

/**
 * Deliberately different vocabulary from vulnerabilitiesCardSubtitle's own
 * "N critical · N high" — Needs Attention and Vulnerabilities overlap in
 * data (a critical/high row counts toward both), so reading as two
 * differently-worded summaries matters for the cards not to look like the
 * same count twice. "Urgent" names the *category* this card is about
 * (act on this), where the Vulnerabilities card names the specific
 * severities.
 */
export function attentionCardSubtitle(metrics: SummaryMetrics): string {
  if (metrics.needsAttention === 0) return 'Nothing needs attention';
  const parts: string[] = [];
  const urgent = metrics.criticalVulnerabilities + metrics.highVulnerabilities;
  if (urgent > 0) parts.push(`${urgent} urgent`);
  if (metrics.deprecatedCount > 0) parts.push(`${metrics.deprecatedCount} deprecated`);
  return parts.join(' · ');
}
