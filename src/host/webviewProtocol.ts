/**
 * The postMessage contract between the extension host and the webview.
 *
 * Two hard constraints on this file:
 *
 *  1. **No `vscode` import, ever.** The webview bundle imports the guards below
 *     as real runtime values, and it runs in a browser context where the
 *     `vscode` module does not exist. Adding an import here would pull the
 *     extension host API into the browser bundle and break it at load time.
 *  2. **Everything crossing the boundary is plain JSON.** postMessage
 *     structured-clones its payload, so class instances arrive as bare objects
 *     with their prototype stripped — a `FetchError` would lose `.retryable`
 *     and its `instanceof` identity. Errors are therefore flattened to
 *     `{ code, message }` before they get here (see dashboardData.ts), which
 *     also keeps error internals from leaking into the UI layer.
 *
 * Both sides validate with the guards below before acting on a message. The
 * webview is a separate security context; a message arriving on `window` is
 * not necessarily one we sent.
 */

import type { AttributedAdvisory, Advisory, PackageRow, Severity, UnresolvableReason } from '../core/types.js';

/** A failure flattened for transport. Never a live Error instance. */
export interface ProtocolError {
  code: string;
  message: string;
}

/** Everything the table needs to render, JSON-safe end to end. */
export interface DashboardData {
  rows: PackageRow[];
  /** ISO timestamp of the run that produced these rows. */
  generatedAt: string;
  /** The bulk advisory fetch failed; rows render without vulnerability data. */
  advisoriesError?: ProtocolError;
  /** `npm audit` enrichment was skipped or failed; upgrade targets are self-computed. */
  auditUnavailable?: boolean;
}

export type HostToWebviewMessage =
  | { status: 'loading' }
  | { status: 'empty'; data: DashboardData }
  | { status: 'ready'; data: DashboardData }
  | { status: 'stale'; data: DashboardData }
  | { status: 'partial-error'; data: DashboardData }
  | { status: 'fatal-error'; error: ProtocolError }
  /**
   * A specific package's upgrade could not run — rejected by host-side
   * validation, cancelled at the confirmation step, or the task itself
   * failed. Deliberately does not carry `data`: the existing table is never
   * touched by this message, only the requesting row's own "running" state.
   */
  | { status: 'upgrade-error'; package: string; error: ProtocolError };

/**
 * `package` and `target` are the smallest request that lets the host verify
 * the click against its own last-known state — see
 * src/core/upgrade/validate.ts. Neither value is trusted directly; both are
 * used only as lookup keys against the controller's most recent result.
 */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'upgrade'; package: string; target: string };

const SEVERITIES: ReadonlySet<string> = new Set<Severity>([
  'critical',
  'high',
  'moderate',
  'low',
  'info',
]);

const UNRESOLVABLE_REASONS: ReadonlySet<string> = new Set<UnresolvableReason>([
  'workspace-link',
  'file',
  'git',
  'alias',
  'tarball',
  'no-lockfile',
]);

const DATA_STATUSES: ReadonlySet<string> = new Set(['empty', 'ready', 'stale', 'partial-error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * An absent optional field is valid; a present one must have the right type.
 * `null` is rejected rather than treated as absent — the sender never writes
 * it, so its presence means the payload did not come from us.
 */
function isAbsentOr(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function isProtocolError(value: unknown): value is ProtocolError {
  return isRecord(value) && typeof value['code'] === 'string' && typeof value['message'] === 'string';
}

function isAdvisory(value: unknown): value is Advisory {
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

function isAttributedAdvisory(value: unknown): value is AttributedAdvisory {
  if (!isRecord(value)) return false;
  const path = value['path'];
  return (
    isAdvisory(value['advisory']) &&
    typeof value['flaggedPackage'] === 'string' &&
    Array.isArray(path) &&
    path.every((segment) => typeof segment === 'string')
  );
}

function isPackageRow(value: unknown): value is PackageRow {
  if (!isRecord(value)) return false;
  const advisories = value['advisories'];
  const worstSeverity = value['worstSeverity'];
  return (
    typeof value['name'] === 'string' &&
    isStringOrNull(value['current']) &&
    isStringOrNull(value['wanted']) &&
    isStringOrNull(value['latest']) &&
    typeof value['dev'] === 'boolean' &&
    isStringOrNull(value['upgradeTo']) &&
    (worstSeverity === null ||
      (typeof worstSeverity === 'string' && SEVERITIES.has(worstSeverity))) &&
    Array.isArray(advisories) &&
    advisories.every(isAttributedAdvisory) &&
    isAbsentOr(value['deprecated'], (v) => typeof v === 'string') &&
    isAbsentOr(
      value['unresolvable'],
      (v) => typeof v === 'string' && UNRESOLVABLE_REASONS.has(v)
    )
  );
}

function isDashboardData(value: unknown): value is DashboardData {
  if (!isRecord(value)) return false;
  const rows = value['rows'];
  return (
    Array.isArray(rows) &&
    rows.every(isPackageRow) &&
    typeof value['generatedAt'] === 'string' &&
    isAbsentOr(value['advisoriesError'], isProtocolError) &&
    isAbsentOr(value['auditUnavailable'], (v) => typeof v === 'boolean')
  );
}

/**
 * Envelopes are closed shapes: an unrecognized top-level key means the message
 * did not come from the other half of this protocol, so it is rejected outright
 * rather than having its known fields trusted. Nested payload objects are
 * checked field-by-field without an extra-key sweep, matching how bulk.ts
 * parses registry JSON.
 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (!isRecord(value)) return false;

  const type = value['type'];
  if (type === 'ready' || type === 'refresh') return hasOnlyKeys(value, ['type']);
  if (type === 'upgrade') {
    return (
      hasOnlyKeys(value, ['type', 'package', 'target']) &&
      isNonEmptyString(value['package']) &&
      isNonEmptyString(value['target'])
    );
  }
  return false;
}

export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
  if (!isRecord(value)) return false;

  const status = value['status'];
  if (typeof status !== 'string') return false;

  if (status === 'loading') return hasOnlyKeys(value, ['status']);
  if (status === 'fatal-error') {
    return hasOnlyKeys(value, ['status', 'error']) && isProtocolError(value['error']);
  }
  if (status === 'upgrade-error') {
    return (
      hasOnlyKeys(value, ['status', 'package', 'error']) &&
      isNonEmptyString(value['package']) &&
      isProtocolError(value['error'])
    );
  }
  if (DATA_STATUSES.has(status)) {
    return hasOnlyKeys(value, ['status', 'data']) && isDashboardData(value['data']);
  }
  return false;
}
