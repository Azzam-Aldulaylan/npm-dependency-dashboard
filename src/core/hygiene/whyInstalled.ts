/**
 * "Why is this installed?" — direct-declaration facts plus, for every
 * distinct resolved version found anywhere in the graph, the package-name
 * chains that introduce it. Works for direct and transitive packages alike,
 * and for npm and pnpm graphs identically, since both build the same
 * normalized `DependencyGraph` (see lockfile/build.ts).
 *
 * Built on top of graph/paths.ts's shared BFS index — this file never walks
 * the graph itself. Duplicate-version detection (duplicates.ts) reuses this
 * exact function's output rather than a second path implementation.
 */

import type { DeclaredDependency } from '../manifest/parse.js';
import type { DependencyClassification } from '../upgrade/plan.js';
import type { DependencyGraph } from '../types.js';
import type { InstallPathIndex, PathSearchOptions } from '../graph/paths.js';
import { buildInstallPathIndex, pathsToNodes } from '../graph/paths.js';
import type { InstallPathVersionEntry } from './types.js';

export interface WhyInstalledResult {
  packageName: string;
  /** True when the package is declared directly, resolved somewhere in the graph, or both. */
  found: boolean;
  /** The project's own direct declaration, independent of whether it resolved to a version (e.g. a workspace-link or git-specifier dependency never does). Null when not a direct dependency. */
  declared: { classification: DependencyClassification; version: string | null } | null;
  /** Every distinct resolved version found anywhere in the graph, each with its own introducing paths — see InstallPathVersionEntry. */
  versions: InstallPathVersionEntry[];
}

function classificationOf(dep: DeclaredDependency): DependencyClassification {
  if (dep.optional) return 'optional';
  return dep.dev ? 'dev' : 'prod';
}

function compareVersions(a: string, b: string): number {
  // Best-effort numeric-ish compare; falls back to lexicographic for
  // anything that isn't a plain dotted-numeric version (pre-release tags,
  // build metadata). Good enough for stable, deterministic ordering — this
  // is a display order, not a semver resolution decision.
  const partsA = a.split('.');
  const partsB = b.split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const numA = Number(partsA[i]);
    const numB = Number(partsB[i]);
    if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) return numA - numB;
    const strA = partsA[i] ?? '';
    const strB = partsB[i] ?? '';
    if (strA !== strB) return strA.localeCompare(strB);
  }
  return 0;
}

/**
 * `index` may be supplied by a caller that already built one for the same
 * graph (duplicate-version detection, scanning every package name, builds
 * exactly one and reuses it here per name) — building a fresh one is only
 * the right default for a single, standalone lookup.
 */
export function whyInstalled(
  graph: DependencyGraph,
  declared: readonly DeclaredDependency[],
  packageName: string,
  options: PathSearchOptions = {},
  index: InstallPathIndex = buildInstallPathIndex(graph)
): WhyInstalledResult {
  const declaredEntry = declared.find((dep) => dep.name === packageName);
  const directNode = [...graph.nodes.values()].find((node) => node.direct && node.name === packageName);

  const declaredInfo =
    declaredEntry === undefined
      ? null
      : { classification: classificationOf(declaredEntry), version: directNode?.version ?? null };

  const byVersion = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    if (node.name !== packageName || node.version === null) continue;
    const existing = byVersion.get(node.version);
    if (existing === undefined) byVersion.set(node.version, [node.path]);
    else existing.push(node.path);
  }

  const versions: InstallPathVersionEntry[] = [...byVersion.entries()]
    .sort(([a], [b]) => compareVersions(a, b))
    .map(([version, nodeIds]) => {
      const isDirectVersion = directNode !== undefined && directNode.version === version;
      const transitiveIds = nodeIds.filter((id) => !(isDirectVersion && id === directNode?.path));
      const pathResult =
        transitiveIds.length === 0
          ? { paths: [], totalPaths: 0, truncated: false }
          : pathsToNodes(graph, index, new Set(transitiveIds), options);
      const entry: InstallPathVersionEntry = {
        version,
        direct: isDirectVersion && declaredInfo !== null ? { classification: declaredInfo.classification } : null,
        paths: pathResult.paths,
        totalPaths: pathResult.totalPaths,
        truncated: pathResult.truncated,
      };
      return entry;
    });

  return {
    packageName,
    found: declaredInfo !== null || versions.length > 0,
    declared: declaredInfo,
    versions,
  };
}
