/**
 * Pure display decision for the Vulnerabilities column's severity badge.
 *
 * Lives here rather than under webview/src for the same reason as
 * upgradeAction.ts: webview/tsconfig.json has `noEmit: true`, so there is no
 * compiled `out/` counterpart to unit-test against if this lived there.
 * esbuild bundles the webview straight from TS source, so the import site is
 * unaffected by which directory this lives in.
 */

import type { Severity } from '../core/types.js';

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
