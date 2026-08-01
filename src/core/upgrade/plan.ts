/**
 * Pure argument-construction for the Upgrade action's npm task.
 *
 * Nothing here may import 'vscode' — see types.ts. This is the one place the
 * actual `npm install` argv is assembled, so it is also the one place that
 * decides the save flag and the --ignore-scripts flag. It never sees the
 * webview's request directly: callers (src/host) are expected to pass only
 * host-owned values (a matched PackageRow's own name/upgradeTo, not the raw
 * request strings) — see src/core/upgrade/validate.ts.
 */

import semver from 'semver';

/** Where a dependency is declared in package.json — decides the npm save flag. */
export type DependencyClassification = 'prod' | 'dev' | 'optional';

const SAVE_FLAG: Record<DependencyClassification, string> = {
  prod: '--save-prod',
  dev: '--save-dev',
  optional: '--save-optional',
};

export interface UpgradeArgsOptions {
  packageName: string;
  target: string;
  classification: DependencyClassification;
  ignoreScripts: boolean;
}

/**
 * The full `npm install` argv, as an array — never a shell string. Each
 * element is passed to the process directly (see src/host/upgradeRunner.ts's
 * use of vscode.ProcessExecution), so nothing here needs escaping and nothing
 * a package name or version could contain — quotes, semicolons, `$(...)`, a
 * leading `-` — changes how many arguments npm receives.
 *
 * The save flag is always explicit, never left to npm's own `save` default:
 * a project's own `.npmrc` (attacker-controlled content in a cloned repo, per
 * src/core/registry/npmrc.ts's SECURITY note) could set `save=false`, which
 * would silently no-op the manifest update if we relied on the default.
 */
export function buildNpmInstallArgs(options: UpgradeArgsOptions): string[] {
  const { packageName, target, classification, ignoreScripts } = options;
  const args = ['install', `${packageName}@${target}`, SAVE_FLAG[classification]];
  if (ignoreScripts) args.push('--ignore-scripts');
  return args;
}

/** Whether the semver major version changes — surfaced in the confirmation dialog. */
export function isMajorUpgrade(current: string, target: string): boolean {
  return semver.major(current) !== semver.major(target);
}

/**
 * Defense in depth, not the primary control: the primary control is that the
 * argv is always an array (see buildNpmInstallArgs above), so no character a
 * name could contain is ever shell-interpreted. This additionally rejects a
 * package name that couldn't have come from a real, successfully-parsed npm
 * dependency in the first place — matching npm's own naming rules (lowercase,
 * optionally scoped, no leading dot/underscore) — as an extra guard against a
 * crafted package.json entry reaching argv construction at all.
 */
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isSafeNpmPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && SAFE_PACKAGE_NAME.test(name);
}

export function isSafeSemverVersion(version: string): boolean {
  return semver.valid(version) !== null;
}
