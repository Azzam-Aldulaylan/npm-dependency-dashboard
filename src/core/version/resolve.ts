/**
 * Version resolution.
 *
 * The rule this file exists to get right:
 *
 * "highest published version greater than installed, by semver" is WRONG.
 * Semver precedence compares major.minor.patch first and only consults the
 * prerelease tag when those are equal, so 19.3.0-canary-abc outranks the actual
 * latest stable 19.2.8 purely because 19.3.0 > 19.2.8. That rule would show a
 * canary build as the available update to every user of that package.
 *
 * The correct model, matching `npm outdated`:
 *   Wanted = highest version satisfying the declared package.json range
 *   Latest = highest STABLE version (dist-tags.latest as the base)
 *
 * Prereleases are only admitted when the installed version is itself a
 * prerelease on the same line — so a project deliberately tracking a beta isn't
 * told it's "behind" an older stable release.
 */

import semver from 'semver';
import type { VersionInfo } from '../types.js';

export interface PackumentLike {
  name: string;
  /** All published version strings. */
  versions: string[];
  distTags: Record<string, string>;
  /** Deprecation message on the latest version, if any. */
  deprecated?: string;
}

/** True when the version carries a prerelease tag (e.g. 1.0.0-beta.1). */
export function isPrerelease(version: string): boolean {
  const parsed = semver.parse(version);
  return parsed !== null && parsed.prerelease.length > 0;
}

/**
 * Highest version satisfying `range`.
 *
 * Prereleases are excluded unless the installed version is itself a prerelease,
 * matching npm's own includePrerelease behavior.
 */
export function resolveWanted(
  versions: string[],
  range: string,
  installed: string | null
): string | null {
  const includePrerelease = installed !== null && isPrerelease(installed);
  const candidates = versions.filter((v) => semver.valid(v) !== null);
  return semver.maxSatisfying(candidates, range, { includePrerelease });
}

/**
 * Highest stable version.
 *
 * dist-tags.latest is the base — it is the maintainer's own statement of what
 * "latest" means, and it is never a canary. We only look past it when the
 * installed version is a prerelease, and even then only at prereleases on the
 * same major.minor.patch line, so a 5.4.0-beta install doesn't get offered an
 * unrelated 7.0.0 nightly.
 */
export function resolveLatest(
  versions: string[],
  distTags: Record<string, string>,
  installed: string | null
): string | null {
  const tagged = distTags['latest'];
  const stableBase = tagged !== undefined && semver.valid(tagged) !== null ? tagged : null;

  if (installed === null || !isPrerelease(installed)) {
    return stableBase;
  }

  // Installed is a prerelease: consider prereleases on the same version line.
  const line = `${semver.major(installed)}.${semver.minor(installed)}.${semver.patch(installed)}`;
  const sameLine = versions.filter(
    (v) =>
      semver.valid(v) !== null &&
      isPrerelease(v) &&
      `${semver.major(v)}.${semver.minor(v)}.${semver.patch(v)}` === line &&
      semver.gt(v, installed)
  );

  const highestOnLine = sameLine.length > 0 ? semver.rsort(sameLine)[0] ?? null : null;

  if (highestOnLine === null) return stableBase;
  if (stableBase === null) return highestOnLine;
  // Whichever is actually ahead of what's installed.
  return semver.gt(stableBase, highestOnLine) ? stableBase : highestOnLine;
}

export function buildVersionInfo(
  packument: PackumentLike,
  range: string,
  installed: string | null
): VersionInfo {
  const info: VersionInfo = {
    name: packument.name,
    wanted: resolveWanted(packument.versions, range, installed),
    latest: resolveLatest(packument.versions, packument.distTags, installed),
  };
  if (packument.deprecated !== undefined) {
    info.deprecated = packument.deprecated;
  }
  return info;
}

/**
 * Guard against the downgrade trap: an advisory fix can name a version LOWER
 * than what's installed, which would silently downgrade the user. Never offer
 * an upgrade that isn't strictly ahead.
 */
export function isSafeUpgradeTarget(
  target: string | null,
  installed: string | null
): boolean {
  if (target === null || semver.valid(target) === null) return false;
  if (installed === null) return true;
  if (semver.valid(installed) === null) return false;
  return semver.gt(target, installed);
}
