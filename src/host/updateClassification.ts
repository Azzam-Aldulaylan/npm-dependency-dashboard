/**
 * Major/minor/patch classification for an available update — purely a
 * display/sort decision, never a substitute for the upgrade-eligibility
 * rules in src/core/upgrade/plan.ts (isMajorUpgrade), which validates
 * host-trusted input for the actual upgrade action. This is UI-only: it
 * feeds the "Major" badge and the Updates card's intelligent default sort,
 * and tolerates invalid/missing versions by returning `null` instead of
 * throwing, since a dashboard count must never crash on unexpected data.
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src.
 */

import semver from 'semver';

import type { PackageRow } from '../core/types.js';

export type UpdateKind = 'major' | 'minor' | 'patch';

/** Highest tier first — used to rank rows for the Updates card's default sort. */
export const UPDATE_KIND_RANK: Record<UpdateKind, number> = {
  major: 3,
  minor: 2,
  patch: 1,
};

/**
 * The target this row's update is measured against: `latest` when it
 * differs from `current` (it's always the highest of the two), falling
 * back to `wanted` for the rarer case where only the in-range version has
 * moved. `null` when there is nothing to classify.
 */
export function updateTarget(row: PackageRow): string | null {
  if (row.current === null) return null;
  if (row.latest !== null && row.latest !== row.current) return row.latest;
  if (row.wanted !== null && row.wanted !== row.current) return row.wanted;
  return null;
}

/**
 * `null` covers three cases alike: no update, or either version string
 * fails semver validation — a dashboard badge has nothing useful to say in
 * any of them, so all three collapse to "don't classify" rather than three
 * different error paths.
 */
export function classifyUpdate(current: string, target: string): UpdateKind | null {
  if (semver.valid(current) === null || semver.valid(target) === null) return null;
  if (semver.major(current) !== semver.major(target)) return 'major';
  if (semver.minor(current) !== semver.minor(target)) return 'minor';
  if (semver.patch(current) !== semver.patch(target)) return 'patch';
  return null;
}

export function classifyRowUpdate(row: PackageRow): UpdateKind | null {
  const target = updateTarget(row);
  if (row.current === null || target === null) return null;
  return classifyUpdate(row.current, target);
}
