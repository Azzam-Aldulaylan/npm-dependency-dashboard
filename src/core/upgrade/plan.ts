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
import type { PackageManagerKind } from '../types.js';

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

export interface CoordinatedUpgradeArgsOptions {
  changes: readonly Omit<UpgradeArgsOptions, 'ignoreScripts'>[];
  ignoreScripts: boolean;
}

export interface ManifestReconciliationArgsOptions {
  ignoreScripts: boolean;
}

export function requiresManifestReconciliation(
  changes: readonly Pick<UpgradeArgsOptions, 'classification'>[]
): boolean {
  const first = changes[0]?.classification;
  return first !== undefined && changes.some((change) => change.classification !== first);
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

/** pnpm's equivalent structured argv. The caller still owns host-side validation. */
export function buildPnpmAddArgs(options: UpgradeArgsOptions): string[] {
  const { packageName, target, classification, ignoreScripts } = options;
  const args = ['add', `${packageName}@${target}`, SAVE_FLAG[classification]];
  if (ignoreScripts) args.push('--ignore-scripts');
  return args;
}

/** Manager-neutral dispatch for host orchestration; always returns literal argv. */
export function buildInstallArgs(
  packageManager: PackageManagerKind,
  options: UpgradeArgsOptions
): string[] {
  return packageManager === 'pnpm' ? buildPnpmAddArgs(options) : buildNpmInstallArgs(options);
}

/** Build one atomic package-manager invocation for a same-classification plan. */
export function buildCoordinatedInstallArgs(
  packageManager: PackageManagerKind,
  options: CoordinatedUpgradeArgsOptions
): string[] {
  if (options.changes.length === 0) throw new Error('A coordinated upgrade needs at least one change.');
  const classification = options.changes[0]?.classification;
  if (classification === undefined || requiresManifestReconciliation(options.changes)) {
    throw new Error('Coordinated upgrades across dependency classifications cannot be installed atomically.');
  }
  const command = packageManager === 'pnpm' ? 'add' : 'install';
  const args = [
    command,
    ...options.changes.map((change) => `${change.packageName}@${change.target}`),
    SAVE_FLAG[classification],
  ];
  if (options.ignoreScripts) args.push('--ignore-scripts');
  return args;
}

/**
 * Reconcile a manifest that the trusted host has already staged.
 *
 * Package names, versions, and save classifications deliberately do not
 * appear in this argv: they are represented by exact host-generated edits to
 * package.json before this command is run. A bare install lets npm/pnpm update
 * the active lockfile and installed tree from that single source of truth,
 * preserving mixed dependencies/devDependencies/optionalDependencies in one
 * package-manager transaction.
 */
export function buildManifestReconciliationArgs(
  packageManager: PackageManagerKind,
  options: ManifestReconciliationArgsOptions
): string[] {
  const args = ['install'];
  // pnpm defaults frozen-lockfile on CI. This command intentionally follows a
  // host-staged manifest change, so the lockfile must be allowed to reconcile
  // even when the extension host itself is running in a CI-like environment.
  if (packageManager === 'pnpm') args.push('--no-frozen-lockfile');
  if (options.ignoreScripts) args.push('--ignore-scripts');
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
