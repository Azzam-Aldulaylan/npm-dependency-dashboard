/**
 * Pure decision for how the webview's optimistic "which package is
 * upgrading" state reacts to an `upgrade-error` message. Lives here rather
 * than under webview/src so it can be unit-tested — see upgradeAction.ts for
 * why (webview/tsconfig.json's `noEmit: true` means nothing there has a
 * compiled `out/` counterpart to import from a test).
 */

import type { DashboardData, UpgradeResultPresentation } from './webviewProtocol.js';

/** Overlay only freshly-confirmed local facts; all registry/security fields remain untouched until the UI's refreshing guard is replaced by a new scan. */
export function applyUpgradeResultLocalFacts(
  data: DashboardData,
  result: UpgradeResultPresentation
): DashboardData {
  const changes = new Map(result.changes.map((change) => [change.packageName, change]));
  return {
    ...data,
    rows: data.rows.map((row) => {
      const change = changes.get(row.name);
      if (change === undefined) return row;
      return {
        ...row,
        current: change.currentVersion ?? row.current,
        range: change.declaredRange ?? row.range,
        dev: change.classification === null ? row.dev : change.classification === 'dev',
        optional: change.classification === null ? row.optional : change.classification === 'optional',
      };
    }),
  };
}

/**
 * An analysis request may only start while no upgrade flow is active. Once an
 * analysis has been issued, the host owns a project-wide lock until that
 * analysis is confirmed, cancelled, or expires. Replacing the webview's
 * tracked analysis with a duplicate request would strand the original lock.
 */
export function upgradeAnalysisRequestIsAllowed(activePackage: string | null): boolean {
  return activePackage === null;
}

/** Late progressive messages are accepted only for the still-active attempt. */
export function upgradeAnalysisMessageMatchesRequest(
  activeRequestId: string | null,
  incomingRequestId: string
): boolean {
  return activeRequestId !== null && activeRequestId === incomingRequestId;
}

/**
 * Changing a selected target invalidates an analysis for that same Manage
 * dependency, but never touches a dashboard/bulk flow or another package.
 */
export function targetChangeInvalidatesManageAnalysis(
  packageName: string,
  previousTarget: string | null,
  nextTarget: string,
  activeUpgrade: string | null,
  upgradeOrigin: 'dashboard' | 'manage-dependency' | null
): boolean {
  return (
    previousTarget !== nextTarget &&
    upgradeOrigin === 'manage-dependency' &&
    activeUpgrade === packageName
  );
}

/**
 * Whether a removal decision targets the same active upgrade review opened
 * inside Manage. Once that review has produced an analysis id, the caller
 * posts its exact-id cancel before removal-impact analysis so the host
 * releases its retained preview lock first. Dashboard/bulk upgrades and
 * reviews for another package are never cancelled implicitly.
 */
export function manageRemovalReplacesUpgradeReview(
  packageName: string,
  activeUpgrade: string | null,
  upgradeOrigin: 'dashboard' | 'manage-dependency' | null
): boolean {
  return upgradeOrigin === 'manage-dependency' && activeUpgrade === packageName;
}

/**
 * Symmetric handoff for the other direction: a completed removal review
 * opened inside Manage may yield its retained project lock when the user
 * deliberately starts an upgrade review for that same package. Dashboard
 * removals and reviews for another package are never cancelled implicitly.
 */
export function manageUpgradeReplacesRemovalReview(
  packageName: string,
  activeRemove: string | null,
  removeOrigin: 'dashboard' | 'manage-dependency' | null
): boolean {
  return removeOrigin === 'manage-dependency' && activeRemove === packageName;
}

/**
 * UPGRADE_IN_PROGRESS means a *different* request than the one this webview
 * is currently tracking was rejected — a race between a rapid duplicate
 * click and React's own re-render (the disabled attribute lands one tick
 * after the click handler that set the active package; see PackageTable.tsx).
 * The active-upgrade state must NOT be cleared by that rejection — only the
 * actually-tracked request's own terminal outcome (any other code, or a
 * fresh dashboard message following a successful upgrade) may clear it.
 * Every other code — including CANCELLED — is a real terminal outcome of the
 * tracked request itself and must clear it, so the disabled buttons release.
 */
export function upgradeErrorClearsActiveState(code: string): boolean {
  return code !== 'UPGRADE_IN_PROGRESS';
}

/**
 * Whether an upgrade-error's code should surface a visible banner. Both
 * CANCELLED (the user's own choice) and UPGRADE_IN_PROGRESS (an internal
 * race the user didn't consciously trigger, about a request that isn't even
 * the one they're watching) are quiet by design — every other code is a real
 * failure worth surfacing.
 */
export function upgradeErrorIsUserVisible(code: string): boolean {
  return code !== 'CANCELLED' && code !== 'UPGRADE_IN_PROGRESS';
}
