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
import type { DependencyGraph, DependencyNode } from '../types.js';
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

/**
 * Reusable lookup state for callers that query many package names against
 * one immutable graph. It combines the one-time install-path BFS with a
 * name index so a batch does not rescan every graph node for every package.
 */
export interface WhyInstalledIndex {
  installPaths: InstallPathIndex;
  nodesByName: ReadonlyMap<string, readonly (readonly [nodeId: string, node: DependencyNode])[]>;
  directNodeByName: ReadonlyMap<string, DependencyNode>;
}

export function buildWhyInstalledIndex(
  graph: DependencyGraph,
  installPaths: InstallPathIndex = buildInstallPathIndex(graph)
): WhyInstalledIndex {
  const nodesByName = new Map<string, Array<Readonly<[string, DependencyNode]>>>();
  const directNodeByName = new Map<string, DependencyNode>();
  for (const node of graph.nodes.values()) {
    const entries = nodesByName.get(node.name);
    // DependencyNode.path is the canonical id used by the path index and by
    // the pre-index implementation, so preserve it even for a hand-built
    // graph whose Map key does not happen to match.
    const entry = [node.path, node] as const;
    if (entries === undefined) nodesByName.set(node.name, [entry]);
    else entries.push(entry);
    if (node.direct && !directNodeByName.has(node.name)) directNodeByName.set(node.name, node);
  }
  return { installPaths, nodesByName, directNodeByName };
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
 * graph. A `WhyInstalledIndex` reuses both paths and name lookups; the older
 * path-only index remains accepted for compatibility, although it still
 * needs one node scan for that individual query.
 */
export function whyInstalled(
  graph: DependencyGraph,
  declared: readonly DeclaredDependency[],
  packageName: string,
  options: PathSearchOptions = {},
  index: InstallPathIndex | WhyInstalledIndex = buildWhyInstalledIndex(graph)
): WhyInstalledResult {
  const declaredEntry = declared.find((dep) => dep.name === packageName);
  const indexedNodes = 'installPaths' in index ? index.nodesByName.get(packageName) ?? [] : undefined;
  const directNode = 'installPaths' in index
    ? index.directNodeByName.get(packageName)
    : [...graph.nodes.values()].find((node) => node.direct && node.name === packageName);
  const installPaths = 'installPaths' in index ? index.installPaths : index;

  const declaredInfo =
    declaredEntry === undefined
      ? null
      : { classification: classificationOf(declaredEntry), version: directNode?.version ?? null };

  const byVersion = new Map<string, string[]>();
  const matchingNodes: Iterable<readonly [string, DependencyNode]> = indexedNodes ?? [...graph.nodes.entries()]
    .filter(([, node]) => node.name === packageName);
  for (const [nodeId, node] of matchingNodes) {
    if (node.name !== packageName || node.version === null) continue;
    const existing = byVersion.get(node.version);
    if (existing === undefined) byVersion.set(node.version, [nodeId]);
    else existing.push(nodeId);
  }

  const versions: InstallPathVersionEntry[] = [...byVersion.entries()]
    .sort(([a], [b]) => compareVersions(a, b))
    .map(([version, nodeIds]) => {
      const isDirectVersion = directNode !== undefined && directNode.version === version;
      const transitiveIds = nodeIds.filter((id) => !(isDirectVersion && id === directNode?.path));
      const pathResult =
        transitiveIds.length === 0
          ? { paths: [], totalPaths: 0, truncated: false }
          : pathsToNodes(graph, installPaths, new Set(transitiveIds), options);
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
