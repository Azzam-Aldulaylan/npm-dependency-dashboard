/**
 * ScanSnapshot -> the wire shape the webview renders.
 *
 * Pure, no vscode. Takes `ScanSnapshot` (src/core/cache/schema.ts) rather
 * than `BuildPackageRowsResult` (src/core/pipeline.ts) directly — the two
 * are structurally compatible (a `BuildPackageRowsResult`'s live
 * `FetchError` satisfies `ScanSnapshot`'s plain `{code,message}` shape, so
 * every existing caller passing a real pipeline result keeps working
 * unchanged), but `DashboardController` also needs to build the *same*
 * outgoing message from a `ScanSnapshot` hydrated straight out of the
 * persisted cache, where there never was a live `FetchError` to begin with.
 * Flattening `advisoriesError` to `{ code, message }` still happens exactly
 * once, here, so no caller can accidentally post a class instance.
 */

import type { ScanSnapshot } from '../core/cache/schema.js';
import type { DashboardData, HostToWebviewMessage, SelectedProjectInfo } from './webviewProtocol.js';

/**
 * `generatedAt` is a parameter rather than always `Date.now()` because a
 * cached result gets re-sent later as `stale`, and that message must carry the
 * timestamp of the run that produced the rows — not the moment it was replayed.
 *
 * `project`/`canChangeProject` (S6) are required, not optional: every message
 * that carries `data` is for some selected project, and the caller (S6:
 * DashboardController, via its own options) always has both on hand.
 */
export function toDashboardData(
  result: ScanSnapshot,
  project: SelectedProjectInfo,
  canChangeProject: boolean,
  generatedAt: string = new Date().toISOString()
): DashboardData {
  const data: DashboardData = { rows: result.rows, generatedAt, project, canChangeProject };
  if (result.advisoriesError !== undefined) {
    data.advisoriesError = {
      code: result.advisoriesError.code,
      message: result.advisoriesError.message,
    };
  }
  if (result.auditUnavailable === true) data.auditUnavailable = true;
  return data;
}

/**
 * Pick the status variant for a completed run.
 *
 * Ordering is deliberate: an empty table has nothing to degrade, and a stale
 * banner outranks a partial-error one because "this is old" changes how the
 * user should read every column, not just the vulnerability one.
 *
 * `loading` and `fatal-error` are not produced here — neither comes from a
 * completed run, so there is no result to map.
 */
export function toHostToWebviewMessage(
  result: ScanSnapshot,
  options: { isEmpty: boolean; isStale: boolean },
  project: SelectedProjectInfo,
  canChangeProject: boolean,
  generatedAt?: string
): HostToWebviewMessage {
  const data = toDashboardData(result, project, canChangeProject, generatedAt);
  if (options.isEmpty) return { status: 'empty', data };
  if (options.isStale) return { status: 'stale', data };
  if (result.advisoriesError !== undefined || result.auditUnavailable === true) {
    return { status: 'partial-error', data };
  }
  return { status: 'ready', data };
}
