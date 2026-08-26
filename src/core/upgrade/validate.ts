/**
 * Pure eligibility check for an upgrade request. This is the actual security
 * boundary between a webview message and a running task: it only ever trusts
 * `rows`, `declaredDependencies`, and (for a Manage selector) an optional set
 * of versions from a host-fetched packument. The incoming `package`/`target`
 * are lookup keys only: the returned target is emitted only after an exact
 * match against one of those host-owned sources. A caller that gets `ok:
 * true` back is expected to build the actual task from the returned
 * `packageName`/`target`/`classification`, not from the original request.
 *
 * Nothing here may import 'vscode' — see types.ts.
 */

import semver from 'semver';

import type { DeclaredDependency } from '../manifest/parse.js';
import type { PackageRow } from '../types.js';
import type { DependencyClassification } from './plan.js';
import { isSafeNpmPackageName, isSafeSemverVersion } from './plan.js';

export type UpgradeRejectionReason =
  | 'no-scan-result'
  | 'revalidating'
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

export const MAX_BULK_UPGRADE_CHANGES = 150;

export type BulkUpgradeEligibility =
  | { ok: true; upgrades: EligibleUpgrade[] }
  | {
      ok: false;
      reason: 'empty-batch' | 'too-many-changes' | 'duplicate-package' | 'change-rejected';
      packageName?: string;
      changeReason?: UpgradeRejectionReason;
    };

/** Reasons a remove request is rejected — a strict subset of an upgrade's: removal never depends on an available update or a matching target version. */
export type RemoveRejectionReason = 'no-scan-result' | 'revalidating' | 'unknown-package' | 'not-declared' | 'unsafe-identifier';

export interface EligibleRemoval {
  ok: true;
  packageName: string;
  classification: DependencyClassification;
}

export interface RejectedRemoval {
  ok: false;
  reason: RemoveRejectionReason;
}

export type RemoveEligibility = EligibleRemoval | RejectedRemoval;

export interface RemoveRequestInput {
  package: string;
}

/** Shared with upgrades — a coordinated install/uninstall of this size is already the practical ceiling for one package-manager transaction. */
export const MAX_BULK_REMOVE_CHANGES = MAX_BULK_UPGRADE_CHANGES;

export type BulkRemoveEligibility =
  | { ok: true; removals: EligibleRemoval[] }
  | {
      ok: false;
      reason: 'empty-batch' | 'too-many-changes' | 'duplicate-package' | 'change-rejected';
      packageName?: string;
      changeReason?: RemoveRejectionReason;
    };

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
  request: UpgradeRequestInput,
  /** Additional targets proven by the host to be published for this package. */
  publishedTargets: ReadonlySet<string> = new Set()
): UpgradeEligibility {
  if (rows === undefined) return { ok: false, reason: 'no-scan-result' };

  const row = rows.find((r) => r.name === request.package);
  if (row === undefined) return { ok: false, reason: 'unknown-package' };
  const targetIsDefault = row.upgradeTo === request.target;
  const targetIsPublishedSelection = publishedTargets.has(request.target);
  if (!targetIsDefault && !targetIsPublishedSelection) {
    return { ok: false, reason: row.upgradeTo === null ? 'no-eligible-upgrade' : 'stale-target' };
  }
  if (row.current === null) return { ok: false, reason: 'no-eligible-upgrade' };

  const declared = declaredDependencies.find((d) => d.name === row.name);
  if (declared === undefined) return { ok: false, reason: 'not-declared' };

  if (!isSafeNpmPackageName(row.name) || !isSafeSemverVersion(request.target)) {
    return { ok: false, reason: 'unsafe-identifier' };
  }
  if (!semver.gt(request.target, row.current)) return { ok: false, reason: 'no-eligible-upgrade' };

  return {
    ok: true,
    packageName: row.name,
    currentVersion: row.current,
    target: request.target,
    classification: classify(declared),
  };
}

/** Validate an entire coordinated request atomically against host-owned scan data. */
export function validateBulkUpgradeRequest(
  rows: readonly PackageRow[] | undefined,
  declaredDependencies: readonly DeclaredDependency[],
  requests: readonly UpgradeRequestInput[],
  publishedTargetsByPackage: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): BulkUpgradeEligibility {
  if (requests.length === 0) return { ok: false, reason: 'empty-batch' };
  if (requests.length > MAX_BULK_UPGRADE_CHANGES) return { ok: false, reason: 'too-many-changes' };

  const seen = new Set<string>();
  const upgrades: EligibleUpgrade[] = [];
  for (const request of requests) {
    if (seen.has(request.package)) {
      return { ok: false, reason: 'duplicate-package', packageName: request.package };
    }
    seen.add(request.package);
    const result = validateUpgradeRequest(
      rows,
      declaredDependencies,
      request,
      publishedTargetsByPackage.get(request.package) ?? new Set()
    );
    if (!result.ok) {
      return {
        ok: false,
        reason: 'change-rejected',
        packageName: request.package,
        changeReason: result.reason,
      };
    }
    upgrades.push(result);
  }
  return { ok: true, upgrades };
}

/**
 * Same host-owned-truth discipline as validateUpgradeRequest, but for
 * removal: eligibility only requires that the package is part of the
 * current scan and still declared directly — no upgradeTo/target to match,
 * since removal doesn't depend on an available update.
 */
export function validateRemoveRequest(
  rows: readonly PackageRow[] | undefined,
  declaredDependencies: readonly DeclaredDependency[],
  request: RemoveRequestInput
): RemoveEligibility {
  if (rows === undefined) return { ok: false, reason: 'no-scan-result' };

  const row = rows.find((r) => r.name === request.package);
  if (row === undefined) return { ok: false, reason: 'unknown-package' };

  const declared = declaredDependencies.find((d) => d.name === row.name);
  if (declared === undefined) return { ok: false, reason: 'not-declared' };

  if (!isSafeNpmPackageName(row.name)) return { ok: false, reason: 'unsafe-identifier' };

  return { ok: true, packageName: row.name, classification: classify(declared) };
}

/** Validate an entire coordinated removal atomically against host-owned scan data. */
export function validateBulkRemoveRequest(
  rows: readonly PackageRow[] | undefined,
  declaredDependencies: readonly DeclaredDependency[],
  requests: readonly RemoveRequestInput[]
): BulkRemoveEligibility {
  if (requests.length === 0) return { ok: false, reason: 'empty-batch' };
  if (requests.length > MAX_BULK_REMOVE_CHANGES) return { ok: false, reason: 'too-many-changes' };

  const seen = new Set<string>();
  const removals: EligibleRemoval[] = [];
  for (const request of requests) {
    if (seen.has(request.package)) {
      return { ok: false, reason: 'duplicate-package', packageName: request.package };
    }
    seen.add(request.package);
    const result = validateRemoveRequest(rows, declaredDependencies, request);
    if (!result.ok) {
      return {
        ok: false,
        reason: 'change-rejected',
        packageName: request.package,
        changeReason: result.reason,
      };
    }
    removals.push(result);
  }
  return { ok: true, removals };
}

export function describeBulkRemoveRejection(rejection: Exclude<BulkRemoveEligibility, { ok: true }>): RejectionDescription {
  if (rejection.reason === 'empty-batch') {
    return { code: 'EMPTY_BATCH', message: 'Select at least one dependency to remove.' };
  }
  if (rejection.reason === 'too-many-changes') {
    return { code: 'TOO_MANY_CHANGES', message: `Removing dependencies supports at most ${MAX_BULK_REMOVE_CHANGES} at a time.` };
  }
  if (rejection.reason === 'duplicate-package') {
    return { code: 'DUPLICATE_PACKAGE', message: `${rejection.packageName ?? 'A dependency'} was selected more than once.` };
  }
  return describeRemoveRejection(rejection.changeReason ?? 'unsafe-identifier');
}

/** User-facing code/message for each remove rejection reason — exhaustive by construction. */
export function describeRemoveRejection(reason: RemoveRejectionReason): RejectionDescription {
  switch (reason) {
    case 'no-scan-result':
      return { code: 'NO_SCAN_RESULT', message: 'Run a scan before requesting a removal.' };
    case 'revalidating':
      return {
        code: 'REVALIDATING',
        message: 'Dependency data is being refreshed. Wait for it to finish and try again.',
      };
    case 'unknown-package':
      return { code: 'UNKNOWN_PACKAGE', message: 'This package is not part of the current scan.' };
    case 'not-declared':
      return {
        code: 'NOT_DECLARED',
        message: 'This package could not be matched to a declared dependency.',
      };
    case 'unsafe-identifier':
      return {
        code: 'UNSAFE_IDENTIFIER',
        message: 'This package could not be validated safely.',
      };
  }
}

export function describeBulkRejection(rejection: Exclude<BulkUpgradeEligibility, { ok: true }>): RejectionDescription {
  if (rejection.reason === 'empty-batch') {
    return { code: 'EMPTY_BATCH', message: 'Select at least one dependency to upgrade.' };
  }
  if (rejection.reason === 'too-many-changes') {
    return { code: 'TOO_MANY_CHANGES', message: `A coordinated upgrade supports at most ${MAX_BULK_UPGRADE_CHANGES} dependencies.` };
  }
  if (rejection.reason === 'duplicate-package') {
    return { code: 'DUPLICATE_PACKAGE', message: `${rejection.packageName ?? 'A dependency'} was selected more than once.` };
  }
  return describeRejection(rejection.changeReason ?? 'unsafe-identifier');
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
    case 'revalidating':
      return {
        code: 'REVALIDATING',
        message: 'Dependency data is being refreshed. Wait for it to finish and try again.',
      };
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
