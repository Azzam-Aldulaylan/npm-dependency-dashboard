/**
 * Shared runtime validation for untrusted data — originally lived only in
 * src/host/webviewProtocol.ts (the postMessage boundary), extracted here
 * (S7) because disk persistence (workspaceState/globalState) is a second,
 * independent untrusted-input boundary that deserves the identical rigor: a
 * corrupted `PackageRow` read back from a cache file is exactly as
 * dangerous as a forged one arriving over postMessage. Both boundaries
 * import from here rather than duplicating (and risking drifting) the same
 * shape checks.
 *
 * No `vscode` import, ever — see webviewProtocol.ts's own rule for why.
 */

import type {
  AttributedAdvisory,
  Advisory,
  PackageRow,
  PatchedVersionResult,
  Severity,
  UnresolvableReason,
} from './types.js';
import type { DependencyFinding, FindingConfidence, FindingSeverity, InstallPathVersionEntry } from './hygiene/types.js';
import type { DependencyClassification } from './upgrade/plan.js';

/** A failure flattened for transport or persistence. Never a live Error instance. */
export interface ProtocolError {
  code: string;
  message: string;
}

export const SEVERITIES: ReadonlySet<string> = new Set<Severity>([
  'critical',
  'high',
  'moderate',
  'low',
  'info',
]);

export const UNRESOLVABLE_REASONS: ReadonlySet<string> = new Set<UnresolvableReason>([
  'workspace-link',
  'file',
  'git',
  'alias',
  'tarball',
  'no-lockfile',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * An absent optional field is valid; a present one must have the right type.
 * `null` is rejected rather than treated as absent — neither the webview nor
 * a correctly-written cache entry ever writes it, so its presence means the
 * payload did not come from us.
 */
export function isAbsentOr(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

export function isProtocolError(value: unknown): value is ProtocolError {
  return isRecord(value) && typeof value['code'] === 'string' && typeof value['message'] === 'string';
}

export function isAdvisory(value: unknown): value is Advisory {
  if (!isRecord(value)) return false;
  const id = value['id'];
  return (
    (typeof id === 'number' || typeof id === 'string') &&
    typeof value['severity'] === 'string' &&
    SEVERITIES.has(value['severity']) &&
    typeof value['title'] === 'string' &&
    typeof value['url'] === 'string' &&
    typeof value['vulnerableVersions'] === 'string'
  );
}

export function isPatchedVersionResult(value: unknown): value is PatchedVersionResult {
  if (!isRecord(value)) return false;
  const status = value['status'];
  if (status === 'none' || status === 'unknown') return Object.keys(value).length === 1;
  if (status === 'known') {
    return Object.keys(value).length === 2 && typeof value['version'] === 'string';
  }
  return false;
}

export function isAttributedAdvisory(value: unknown): value is AttributedAdvisory {
  if (!isRecord(value)) return false;
  const path = value['path'];
  const flaggedVersion = value['flaggedVersion'];
  return (
    isAdvisory(value['advisory']) &&
    typeof value['flaggedPackage'] === 'string' &&
    Array.isArray(path) &&
    path.every((segment) => typeof segment === 'string') &&
    (flaggedVersion === null || typeof flaggedVersion === 'string') &&
    isPatchedVersionResult(value['patchedVersion'])
  );
}

const UPGRADE_REASONS: ReadonlySet<string> = new Set(['security-fix', 'update']);

export function isPackageRow(value: unknown): value is PackageRow {
  if (!isRecord(value)) return false;
  const advisories = value['advisories'];
  const worstSeverity = value['worstSeverity'];
  const upgradeTo = value['upgradeTo'];
  const upgradeReason = value['upgradeReason'];
  return (
    typeof value['name'] === 'string' &&
    isStringOrNull(value['current']) &&
    isStringOrNull(value['wanted']) &&
    isStringOrNull(value['latest']) &&
    typeof value['dev'] === 'boolean' &&
    typeof value['optional'] === 'boolean' &&
    typeof value['range'] === 'string' &&
    isStringOrNull(upgradeTo) &&
    // `upgradeReason` is null exactly when `upgradeTo` is — see PackageRow's own doc.
    (upgradeTo === null ? upgradeReason === null : typeof upgradeReason === 'string' && UPGRADE_REASONS.has(upgradeReason)) &&
    (worstSeverity === null ||
      (typeof worstSeverity === 'string' && SEVERITIES.has(worstSeverity))) &&
    Array.isArray(advisories) &&
    advisories.every(isAttributedAdvisory) &&
    isAbsentOr(value['description'], (v) => typeof v === 'string') &&
    isAbsentOr(value['license'], (v) => typeof v === 'string') &&
    isAbsentOr(value['deprecated'], (v) => typeof v === 'string') &&
    isAbsentOr(
      value['unresolvable'],
      (v) => typeof v === 'string' && UNRESOLVABLE_REASONS.has(v)
    )
  );
}

// ------------------------------------------------------- hygiene findings

const FINDING_KINDS: ReadonlySet<string> = new Set(['deprecated', 'duplicate-version', 'likely-unused']);
const FINDING_CONFIDENCES: ReadonlySet<string> = new Set<FindingConfidence>(['high', 'medium', 'low']);
const FINDING_SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>(['info', 'warning', 'attention']);
const DEPENDENCY_CLASSIFICATIONS: ReadonlySet<string> = new Set<DependencyClassification>(['prod', 'dev', 'optional']);

function isDependencyClassification(value: unknown): value is DependencyClassification {
  return typeof value === 'string' && DEPENDENCY_CLASSIFICATIONS.has(value);
}

function isDirectMarker(value: unknown): value is { classification: DependencyClassification } | null {
  if (value === null) return true;
  return isRecord(value) && Object.keys(value).length === 1 && isDependencyClassification(value['classification']);
}

export function isInstallPathVersionEntry(value: unknown): value is InstallPathVersionEntry {
  if (!isRecord(value)) return false;
  const paths = value['paths'];
  return (
    typeof value['version'] === 'string' &&
    isDirectMarker(value['direct']) &&
    Array.isArray(paths) &&
    paths.every((path) => Array.isArray(path) && path.every((segment) => typeof segment === 'string')) &&
    typeof value['totalPaths'] === 'number' &&
    typeof value['truncated'] === 'boolean'
  );
}

function isDeprecatedEvidence(value: Record<string, unknown>): boolean {
  return (
    value['kind'] === 'deprecated' &&
    typeof value['message'] === 'string' &&
    isAbsentOr(value['suggestedReplacement'], (v) => typeof v === 'string')
  );
}

function isDuplicateVersionEvidence(value: Record<string, unknown>): boolean {
  const versions = value['versions'];
  return value['kind'] === 'duplicate-version' && Array.isArray(versions) && versions.every(isInstallPathVersionEntry);
}

function isLikelyUnusedEvidence(value: Record<string, unknown>): boolean {
  return (
    value['kind'] === 'likely-unused' &&
    typeof value['reason'] === 'string' &&
    typeof value['scannedFileCount'] === 'number' &&
    typeof value['truncated'] === 'boolean'
  );
}

export function isDependencyFinding(value: unknown): value is DependencyFinding {
  if (!isRecord(value)) return false;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !FINDING_KINDS.has(kind)) return false;
  if (typeof value['packageName'] !== 'string') return false;
  if (typeof value['summary'] !== 'string') return false;
  if (!isAbsentOr(value['confidence'], (v) => typeof v === 'string' && FINDING_CONFIDENCES.has(v))) return false;
  if (typeof value['severity'] !== 'string' || !FINDING_SEVERITIES.has(value['severity'])) return false;

  const evidence = value['evidence'];
  if (!isRecord(evidence)) return false;
  if (kind === 'deprecated') return isDeprecatedEvidence(evidence);
  if (kind === 'duplicate-version') return isDuplicateVersionEvidence(evidence);
  return isLikelyUnusedEvidence(evidence);
}
