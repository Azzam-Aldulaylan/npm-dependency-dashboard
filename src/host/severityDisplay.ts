/**
 * Pure display decision for the Vulnerabilities column's severity badge.
 *
 * Lives here rather than under webview/src for the same reason as
 * upgradeAction.ts: webview/tsconfig.json has `noEmit: true`, so there is no
 * compiled `out/` counterpart to unit-test against if this lived there.
 * esbuild bundles the webview straight from TS source, so the import site is
 * unaffected by which directory this lives in.
 */

import type { AttributedAdvisory, Severity } from '../core/types.js';

export interface SeverityDisplay {
  label: string;
  /** CSS modifier class suffix, e.g. "critical" for `severity--critical`. */
  className: string;
}

const LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
  info: 'Info',
};

/**
 * `null` means the package has no known advisory — labelled "Safe" rather
 * than left blank, so the column is readable without inferring meaning from
 * an empty cell.
 */
export function severityDisplay(severity: Severity | null): SeverityDisplay {
  if (severity === null) return { label: 'Safe', className: 'none' };
  return { label: LABELS[severity], className: severity };
}

/** Higher is worse/more urgent — Critical > High > Moderate > Low > Info. */
const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

/**
 * Worst-first order for a row's advisory list — never the raw order they
 * arrived from the registry/audit response. Tie-broken, stably, by the
 * flagged package name and then the advisory title so equal-severity
 * entries never visibly reshuffle between renders.
 */
export function sortAdvisoriesBySeverity(advisories: readonly AttributedAdvisory[]): AttributedAdvisory[] {
  return [...advisories].sort(
    (a, b) =>
      SEVERITY_RANK[b.advisory.severity] - SEVERITY_RANK[a.advisory.severity] ||
      a.flaggedPackage.localeCompare(b.flaggedPackage) ||
      a.advisory.title.localeCompare(b.advisory.title)
  );
}
