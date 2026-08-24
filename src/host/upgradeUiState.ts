/**
 * Pure decision for how the webview's optimistic "which package is
 * upgrading" state reacts to an `upgrade-error` message. Lives here rather
 * than under webview/src so it can be unit-tested — see upgradeAction.ts for
 * why (webview/tsconfig.json's `noEmit: true` means nothing there has a
 * compiled `out/` counterpart to import from a test).
 */

/**
 * An analysis request may only start while no upgrade flow is active. Once an
 * analysis has been issued, the host owns a project-wide lock until that
 * analysis is confirmed, cancelled, or expires. Replacing the webview's
 * tracked analysis with a duplicate request would strand the original lock.
 */
export function upgradeAnalysisRequestIsAllowed(activePackage: string | null): boolean {
  return activePackage === null;
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
