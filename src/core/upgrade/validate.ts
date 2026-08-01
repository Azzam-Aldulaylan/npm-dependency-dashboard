/**
 * Pure eligibility check for an upgrade request. This is the actual security
 * boundary between a webview message and a running task: it only ever trusts
 * `rows` and `declaredDependencies` (both host-owned, derived from the last
 * completed scan), and uses the incoming request's `package`/`target` purely
 * as lookup keys to compare against that host truth — never as values that
 * themselves flow into the eventual npm command. A caller that gets `ok:
 * true` back is expected to build the actual task from the returned
 * `packageName`/`target`/`classification`, not from the original request.
 *
 * Nothing here may import 'vscode' — see types.ts.
 */

import type { DeclaredDependency } from '../manifest/parse.js';
import type { PackageRow } from '../types.js';
import type { DependencyClassification } from './plan.js';
import { isSafeNpmPackageName, isSafeSemverVersion } from './plan.js';

export type UpgradeRejectionReason =
  | 'no-scan-result'
  | 'unknown-package'
  | 'no-eligible-upgrade'
  | 'stale-target'
  | 'not-declared'
  | 'unsafe-identifier';

export interface EligibleUpgrade {
  ok: true;
  packageName: string;
  currentVersion: string;
  target: string;
  classification: DependencyClassification;
}

export interface RejectedUpgrade {
  ok: false;
  reason: UpgradeRejectionReason;
}

export type UpgradeEligibility = EligibleUpgrade | RejectedUpgrade;

export interface UpgradeRequestInput {
  package: string;
  target: string;
}

function classify(declared: DeclaredDependency): DependencyClassification {
  if (declared.optional) return 'optional';
  if (declared.dev) return 'dev';
  return 'prod';
}

/**
 * `rows` is `lastResult?.rows` — undefined until the first scan completes.
 * `declaredDependencies` is derived once from the controller's own
 * `manifestText`, independently of anything the webview has ever sent.
 */
export function validateUpgradeRequest(
  rows: readonly PackageRow[] | undefined,
  declaredDependencies: readonly DeclaredDependency[],
  request: UpgradeRequestInput
): UpgradeEligibility {
  if (rows === undefined) return { ok: false, reason: 'no-scan-result' };

  const row = rows.find((r) => r.name === request.package);
  if (row === undefined) return { ok: false, reason: 'unknown-package' };
  if (row.upgradeTo === null) return { ok: false, reason: 'no-eligible-upgrade' };
  // The requested target must exactly equal the host's own cached upgradeTo —
  // a mismatch means the webview's copy of the row is stale (e.g. a refresh
  // landed between render and click) and must be refused, not "corrected".
  if (row.upgradeTo !== request.target) return { ok: false, reason: 'stale-target' };
  // resolveUpgradeTarget's isSafeUpgradeTarget guard (src/core/version/resolve.ts)
  // never returns non-null when `installed` isn't a valid semver string, so
  // row.current is guaranteed non-null here — this check exists to satisfy the
  // type system honestly rather than assert/cast past it.
  if (row.current === null) return { ok: false, reason: 'no-eligible-upgrade' };

  const declared = declaredDependencies.find((d) => d.name === row.name);
  if (declared === undefined) return { ok: false, reason: 'not-declared' };

  if (!isSafeNpmPackageName(row.name) || !isSafeSemverVersion(row.upgradeTo)) {
    return { ok: false, reason: 'unsafe-identifier' };
  }

  return {
    ok: true,
    packageName: row.name,
    currentVersion: row.current,
    target: row.upgradeTo,
    classification: classify(declared),
  };
}

export interface RejectionDescription {
  code: string;
  message: string;
}

/** User-facing code/message for each rejection reason — exhaustive by construction. */
export function describeRejection(reason: UpgradeRejectionReason): RejectionDescription {
  switch (reason) {
    case 'no-scan-result':
      return { code: 'NO_SCAN_RESULT', message: 'Run a scan before requesting an upgrade.' };
    case 'unknown-package':
      return { code: 'UNKNOWN_PACKAGE', message: 'This package is not part of the current scan.' };
    case 'no-eligible-upgrade':
      return {
        code: 'NO_ELIGIBLE_UPGRADE',
        message: 'No upgrade is currently available for this package.',
      };
    case 'stale-target':
      return {
        code: 'STALE_TARGET',
        message: 'The available upgrade changed. Refresh and try again.',
      };
    case 'not-declared':
      return {
        code: 'NOT_DECLARED',
        message: 'This package could not be matched to a declared dependency.',
      };
    case 'unsafe-identifier':
      return {
        code: 'UNSAFE_IDENTIFIER',
        message: 'This package or version could not be validated safely.',
      };
  }
}
