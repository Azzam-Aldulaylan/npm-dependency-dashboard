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
 * No click handler and no webview-protocol message here — S5 wires the
 * actual upgrade action. This only decides what the cell shows.
 */

export interface UpgradeActionDisplay {
  label: string;
  tooltip: string;
}

export const UPGRADE_UNAVAILABLE_TOOLTIP =
  'Running the upgrade is not available yet — it arrives in a future release.';

/**
 * `null` means: render an em dash, no button at all — there is nothing to
 * upgrade to. A non-null `upgradeTo` always renders a disabled button naming
 * the target version, never a live action.
 */
export function upgradeActionDisplay(upgradeTo: string | null): UpgradeActionDisplay | null {
  if (upgradeTo === null) return null;
  return {
    label: `Upgrade to ${upgradeTo}`,
    tooltip: UPGRADE_UNAVAILABLE_TOOLTIP,
  };
}
