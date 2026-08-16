/**
 * Pure display decision for the Action column's Upgrade control.
 *
 * Lives here rather than under webview/src so it can be unit-tested against
 * compiled output the same way as webviewProtocol.ts — webview/tsconfig.json
 * has `noEmit: true` (esbuild bundles that tree straight from TS source, with
 * no compiled `out/` counterpart to import from a test). esbuild resolves
 * this import by source path regardless of which directory it lives in, so
 * bundling is unaffected.
 *
 * This only decides the label/tooltip text; the click handler, the "running"
 * state, and the actual postMessage live in PackageTable.tsx (S5). What
 * happens after the click — host-side validation, confirmation, task
 * execution — is in src/core/upgrade/* and src/host/upgradeRunner.ts.
 */

export interface UpgradeActionDisplay {
  label: string;
  tooltip: string;
}

export const UPGRADE_TOOLTIP =
  'Runs compatibility preflight, then a transactional npm/pnpm upgrade as a visible VS Code task after confirmation.';

/**
 * `null` means: render an em dash, no button at all — there is nothing to
 * upgrade to. A non-null `upgradeTo` always renders a button naming the
 * target version.
 */
export function upgradeActionDisplay(upgradeTo: string | null): UpgradeActionDisplay | null {
  if (upgradeTo === null) return null;
  return {
    label: `Upgrade to ${upgradeTo}`,
    tooltip: UPGRADE_TOOLTIP,
  };
}
