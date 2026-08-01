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

import type { PackageRow } from '../core/types.js';
import {
  isAbsentOr,
  isPackageRow,
  isProtocolError,
  isRecord,
} from '../core/validation.js';
import type { ProtocolError } from '../core/validation.js';

// Re-exported for every existing import site (dashboardController.ts,
// dashboardPanel.ts, upgradeRunner.ts, etc.) that imports `ProtocolError`
// from here rather than its new home in src/core/validation.ts — the wire
// protocol's error shape and the persisted-cache error shape are the same
// type, defined once in core so both boundaries share it.
export type { ProtocolError };

/**
 * S6 — the currently selected project. Only ever a display `label` plus a
 * workspace-folder-relative `manifestPath` — never an absolute filesystem
 * path, and never anything beyond what the webview already needs to render.
 */
export interface SelectedProjectInfo {
  /** Workspace-folder name, plus the containing directory when not the folder root — see projectCandidateLabel. */
  label: string;
  /** Workspace-folder-relative POSIX path to package.json. */
  manifestPath: string;
}

/** Everything the table needs to render, JSON-safe end to end. */
export interface DashboardData {
  rows: PackageRow[];
  /** ISO timestamp of the run that produced these rows. */
  generatedAt: string;
  project: SelectedProjectInfo;
  /** More than one project candidate was discovered — gates whether "Change project" renders at all. */
  canChangeProject: boolean;
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
/**
 * `change-project` carries no payload at all — the webview can only ever ask
 * the host to open its picker, never name or choose a project itself. The
 * host owns project discovery and the candidate list end to end; nothing
 * here could be a raw filesystem path even by accident.
 */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'change-project' }
  | { type: 'upgrade'; package: string; target: string };

const DATA_STATUSES: ReadonlySet<string> = new Set(['empty', 'ready', 'stale', 'partial-error']);

function isSelectedProjectInfo(value: unknown): value is SelectedProjectInfo {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['label', 'manifestPath']) &&
    typeof value['label'] === 'string' &&
    typeof value['manifestPath'] === 'string'
  );
}

function isDashboardData(value: unknown): value is DashboardData {
  if (!isRecord(value)) return false;
  const rows = value['rows'];
  return (
    Array.isArray(rows) &&
    rows.every(isPackageRow) &&
    typeof value['generatedAt'] === 'string' &&
    isSelectedProjectInfo(value['project']) &&
    typeof value['canChangeProject'] === 'boolean' &&
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
  if (type === 'ready' || type === 'refresh' || type === 'change-project') {
    return hasOnlyKeys(value, ['type']);
  }
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
