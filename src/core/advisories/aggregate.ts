/**
 * Severity aggregation and fixAvailable-gated upgrade targeting for a direct
 * dependency's row, per the spec's Vulnerability Scope.
 *
 * The "Upgrade" button only appears when a fix exists at the direct
 * dependency's own version:
 *
 *  - `npm audit`'s `fixAvailable`, when reachable, is authoritative — it is
 *    the only source that actually knows whether bumping the direct package
 *    re-resolves a *transitive* advisory (that requires re-running npm's own
 *    resolver, which we do not reimplement here).
 *  - Without it, we self-compute a narrower fallback: "does a version within
 *    the declared range exist where the direct dependency's OWN advisories
 *    don't apply." This cannot detect a fix for a purely transitive
 *    vulnerability — see the spec's honest caveat on the 31/32 attribution
 *    figure — so it only fires when the direct dependency is itself flagged.
 */

import semver from 'semver';

import type { AttributedAdvisory, FixAvailable, Severity } from '../types.js';
import { isSafeUpgradeTarget } from '../version/resolve.js';

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

/** Highest severity across a direct dependency's attributed advisories. */
export function worstSeverity(advisories: readonly AttributedAdvisory[]): Severity | null {
  let worst: Severity | null = null;
  for (const { advisory } of advisories) {
    if (worst === null || SEVERITY_RANK[advisory.severity] > SEVERITY_RANK[worst]) {
      worst = advisory.severity;
    }
  }
  return worst;
}

/** Advisories attributed directly against the dependency's own version (path length 1). */
function ownAdvisories(advisories: readonly AttributedAdvisory[]): AttributedAdvisory[] {
  return advisories.filter((a) => a.path.length === 1);
}

/**
 * Highest in-range version whose own advisories (if any) don't apply to it.
 * Cannot reason about transitive fixes — that needs a real dependency
 * resolver, which is what `fixAvailable` already comes from.
 */
function selfComputedFix(
  installed: string | null,
  range: string,
  availableVersions: readonly string[],
  advisories: readonly AttributedAdvisory[]
): string | null {
  const own = ownAdvisories(advisories);
  if (own.length === 0) return null;

  const clean = availableVersions.filter((v) => {
    if (semver.valid(v) === null || !semver.satisfies(v, range)) return false;
    return !own.some((a) =>
      semver.satisfies(v, a.advisory.vulnerableVersions, { includePrerelease: true })
    );
  });

  const best = semver.maxSatisfying(clean, range);
  return isSafeUpgradeTarget(best, installed) ? best : null;
}

export interface UpgradeTargetOptions {
  installed: string | null;
  range: string;
  /** Highest version satisfying the declared range — what `fixAvailable: true` resolves to. */
  wanted: string | null;
  /** All published version strings, for the self-computed fallback. */
  availableVersions: readonly string[];
  /** This direct dependency's own attributed advisories, any depth. */
  advisories: readonly AttributedAdvisory[];
  /** From `npm audit --json`, when reachable; omit when audit is unavailable. */
  fixAvailable?: FixAvailable;
}

/**
 * Target version for the Upgrade action, or null when it shouldn't be
 * offered. Never returns a version that isn't strictly ahead of what's
 * installed — see `isSafeUpgradeTarget`'s downgrade-trap guard.
 */
export function resolveUpgradeTarget(options: UpgradeTargetOptions): string | null {
  const { installed, range, wanted, availableVersions, advisories, fixAvailable } = options;
  if (advisories.length === 0) return null;

  if (fixAvailable !== undefined) {
    if (fixAvailable === false) return null;
    const target = fixAvailable === true ? wanted : fixAvailable.version;
    return isSafeUpgradeTarget(target, installed) ? target : null;
  }

  return selfComputedFix(installed, range, availableVersions, advisories);
}
