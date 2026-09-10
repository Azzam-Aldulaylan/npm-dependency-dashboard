/**
 * Pure upgrade-target selection from an npm packument.
 *
 * The normal dashboard scan intentionally uses `/<package>/latest` whenever
 * it can. A Manage-dependency target picker is different: it is explicitly
 * opened for one package and needs the package's published versions and
 * dist-tags. Keeping the policy here makes the on-demand host fetch cheap to
 * test and prevents the webview from inventing or reclassifying targets.
 */

import semver from 'semver';

import { FetchError } from '../registry/http.js';
import type { HttpClient } from '../registry/http.js';
import { fetchDistTags, fetchPackageVersionMetadata, fetchPackument } from '../registry/versions.js';
import type { PackumentDoc } from '../registry/versions.js';
import type { EtagStore } from '../registry/versions.js';

export const MAX_STABLE_UPGRADE_TARGETS = 24;
export const MAX_PRERELEASE_UPGRADE_TARGETS = 5;

export type UpgradeTargetLabel = 'recommended' | 'lts' | 'latest';

export interface UpgradeTargetOption {
  version: string;
  channel: 'stable' | 'prerelease';
  labels: UpgradeTargetLabel[];
}

export interface UpgradeTargetSelection {
  recommendedVersion: string | null;
  options: UpgradeTargetOption[];
  /** True when valid published upgrade versions were intentionally omitted. */
  truncated: boolean;
}

/**
 * Replace only the dashboard's default target with the registry-backed
 * recommendation. A target explicitly selected by the user is preserved.
 */
export function preferPublisherRecommendedTarget(
  requestedTarget: string,
  existingFallback: string | null,
  selection: UpgradeTargetSelection
): string {
  if (requestedTarget !== existingFallback || selection.recommendedVersion === null) return requestedTarget;
  return selection.recommendedVersion;
}

function validPublishedTag(
  packument: PackumentDoc,
  tag: string,
  published: ReadonlySet<string>,
  installed: string
): string | null {
  const version = packument.distTags[tag];
  if (version === undefined || semver.valid(version) === null) return null;
  if (!published.has(version) || semver.prerelease(version) !== null) return null;
  return semver.gt(version, installed) ? version : null;
}

function addIfPresent(target: Set<string>, version: string | null): void {
  if (version !== null) target.add(version);
}

/**
 * Produce a useful, bounded set of upgrade choices.
 *
 * Stable choices include the newest releases plus the newest release on
 * older major/minor lines, so a package with hundreds of patch releases does
 * not crowd every meaningful jump out of the menu. Tagged and recommended
 * releases are pinned into the result even when they fall outside that
 * recent-release window. Prereleases are a small, clearly separate tail.
 */
export function selectUpgradeTargets(
  packument: PackumentDoc,
  installed: string,
  existingFallback: string | null
): UpgradeTargetSelection {
  if (semver.valid(installed) === null) {
    return { recommendedVersion: null, options: [], truncated: false };
  }

  const published = new Set(packument.versions.filter((version) => semver.valid(version) !== null));
  const eligible = [...published].filter((version) => semver.gt(version, installed));
  const stable = eligible.filter((version) => semver.prerelease(version) === null).sort(semver.rcompare);
  const prerelease = eligible.filter((version) => semver.prerelease(version) !== null).sort(semver.rcompare);

  const lts = validPublishedTag(packument, 'lts', published, installed);
  const latest = validPublishedTag(packument, 'latest', published, installed);
  const fallback =
    existingFallback !== null &&
    semver.valid(existingFallback) !== null &&
    published.has(existingFallback) &&
    semver.prerelease(existingFallback) === null &&
    semver.gt(existingFallback, installed)
      ? existingFallback
      : null;
  const recommendedVersion = lts ?? latest ?? fallback ?? stable[0] ?? null;

  const chosenStable = new Set<string>();
  addIfPresent(chosenStable, recommendedVersion);
  addIfPresent(chosenStable, lts);
  addIfPresent(chosenStable, latest);
  addIfPresent(chosenStable, fallback);

  // Recent releases answer the common "pick the newest patch/minor" case.
  for (const version of stable.slice(0, 16)) chosenStable.add(version);

  // Preserve representative older lines without allowing an unbounded menu.
  const newestByMinor = new Map<string, string>();
  for (const version of stable) {
    const key = `${semver.major(version)}.${semver.minor(version)}`;
    if (!newestByMinor.has(key)) newestByMinor.set(key, version);
  }
  for (const version of newestByMinor.values()) {
    if (chosenStable.size >= MAX_STABLE_UPGRADE_TARGETS) break;
    chosenStable.add(version);
  }

  const stableVersions = [...chosenStable]
    .sort((left, right) => {
      if (left === recommendedVersion) return -1;
      if (right === recommendedVersion) return 1;
      return semver.rcompare(left, right);
    })
    .slice(0, MAX_STABLE_UPGRADE_TARGETS);
  const prereleaseVersions = prerelease.slice(0, MAX_PRERELEASE_UPGRADE_TARGETS);

  const toOption = (version: string, channel: UpgradeTargetOption['channel']): UpgradeTargetOption => {
    const labels: UpgradeTargetLabel[] = [];
    if (version === recommendedVersion) labels.push('recommended');
    if (version === lts) labels.push('lts');
    if (version === latest) labels.push('latest');
    return { version, channel, labels };
  };

  return {
    recommendedVersion,
    options: [
      ...stableVersions.map((version) => toOption(version, 'stable')),
      ...prereleaseVersions.map((version) => toOption(version, 'prerelease')),
    ],
    truncated: stable.length > stableVersions.length || prerelease.length > prereleaseVersions.length,
  };
}

/**
 * Build the best bounded menu possible from tags alone. Dist-tag values are
 * registry-published versions, and commonly retain useful maintained release
 * lines even when a package's complete history is enormous. The existing
 * dashboard fallback is included because it has already crossed the host's
 * normal scan boundary.
 */
export function selectUpgradeTargetsFromDistTags(
  distTags: Record<string, string>,
  installed: string,
  existingFallback: string | null
): UpgradeTargetSelection {
  const versions = new Set(Object.values(distTags));
  if (existingFallback !== null) versions.add(existingFallback);
  return selectUpgradeTargets({ versions: [...versions], distTags }, installed, existingFallback);
}

/**
 * Prefer the complete abbreviated packument, but degrade to npm's tiny
 * dist-tags endpoint when the decompressed history exceeds the HTTP safety
 * budget. Network, auth, parse, and registry errors remain real errors; only
 * the known size condition takes this narrower path.
 */
export async function loadUpgradeTargets(
  client: HttpClient,
  store: EtagStore,
  registry: string,
  name: string,
  installed: string,
  existingFallback: string | null,
  signal?: AbortSignal
): Promise<UpgradeTargetSelection> {
  try {
    const packument = await fetchPackument(client, store, registry, name, signal);
    return selectUpgradeTargets(packument, installed, existingFallback);
  } catch (cause) {
    if (!(cause instanceof FetchError) || cause.code !== 'TOO_LARGE') throw cause;
    const distTags = await fetchDistTags(client, store, registry, name, signal);
    return selectUpgradeTargetsFromDistTags(distTags, installed, existingFallback);
  }
}

/**
 * Return the versions this exact analysis request may use. A target outside
 * the bounded menu is proven with npm's small exact-version endpoint, so a
 * manually entered older release never requires the package's full history.
 */
export async function publishedUpgradeTargetsForRequest(
  client: HttpClient,
  store: EtagStore,
  registry: string,
  name: string,
  installed: string,
  existingFallback: string | null,
  requestedTarget: string,
  signal?: AbortSignal
): Promise<ReadonlySet<string>> {
  const published = new Set<string>();
  if (requestedTarget === existingFallback) {
    published.add(requestedTarget);
    return published;
  }
  if (semver.valid(requestedTarget) === null || !semver.gt(requestedTarget, installed)) return published;
  await fetchPackageVersionMetadata(client, store, registry, name, requestedTarget, signal);
  published.add(requestedTarget);
  return published;
}
