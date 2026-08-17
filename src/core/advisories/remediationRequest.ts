/**
 * Host-authoritative eligibility check for "Analyze remediation" requests.
 *
 * The webview never names a version, a path, or a plan — only the package it
 * wants analyzed. This re-derives everything else from the host's own
 * last-trusted scan (`DashboardController.lastResultRows()`), the same "look
 * the trusted row up yourself, never trust the request's shape" rule
 * src/core/advisories/resolve.ts already follows for open-advisory.
 *
 * A row is eligible only for exactly the case this feature exists for: a
 * known vulnerability, no host-computed direct upgrade target
 * (`upgradeTo === null` — a row with one already has a normal Upgrade/Fix
 * vulnerability button and has no business here), and at least one
 * attributed advisory whose path is transitive (`path.length > 1`). A
 * direct-package vulnerability with no newer published version is never
 * fixable by re-resolving the dependency tree, so it is deliberately not
 * offered here — see upgradeAction.ts's static `no-direct-fix`
 * classification for that case instead.
 */

import type { AttributedAdvisory, PackageRow } from '../types.js';

export type RemediationRequestRejection = 'UNKNOWN_PACKAGE' | 'NOT_TRANSITIVE_VULNERABILITY';

export type RemediationRequestResult =
  | { ok: true; row: PackageRow; transitiveAdvisories: AttributedAdvisory[] }
  | { ok: false; reason: RemediationRequestRejection };

export function resolveRemediationRequest(
  rows: readonly PackageRow[],
  packageName: string
): RemediationRequestResult {
  const row = rows.find((entry) => entry.name === packageName);
  if (row === undefined) return { ok: false, reason: 'UNKNOWN_PACKAGE' };
  if (row.upgradeTo !== null || row.current === null) {
    return { ok: false, reason: 'NOT_TRANSITIVE_VULNERABILITY' };
  }
  const transitiveAdvisories = row.advisories.filter((entry) => entry.path.length > 1);
  if (transitiveAdvisories.length === 0) return { ok: false, reason: 'NOT_TRANSITIVE_VULNERABILITY' };
  return { ok: true, row, transitiveAdvisories };
}
