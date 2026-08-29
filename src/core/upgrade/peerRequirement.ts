/**
 * For a package about to be removed, which OTHER currently-installed
 * packages (not also being removed in the same coordinated batch) declare it
 * as their own peer dependency — i.e. expect the project root to provide it.
 * Reuses the already-built dependency graph's own `edges` (no new resolver,
 * no new peer-metadata fetch) — the same normalized peer-edge data
 * src/core/compatibility/preflight.ts already walks for upgrade proposals,
 * just read here for a removal instead of a version-change proposal.
 *
 * This is deliberately distinct from `stillRequiredBy` (removeImpact.ts):
 * an ordinary transitive `deps` edge means "something else's subtree still
 * resolves through this package" — informational, never a reason to refuse a
 * removal the user explicitly asked for. A peer edge means the *project
 * itself* is expected to keep providing this package for another installed
 * package to work correctly — a materially different, stronger fact.
 */

import type { DependencyGraph } from '../types.js';

export interface PeerRequirementEvidence {
  /** The package that declares `packageName` as its own peer dependency. */
  requiredBy: string;
  /** The peer range that package declares, e.g. "^18.0.0". */
  range: string;
  optional: boolean;
}

interface IndexedPeerRequirement extends PeerRequirementEvidence {
  ownerDirect: boolean;
}

/**
 * Peer requirements grouped by the direct package they target. Building
 * this once makes a removal batch O(nodes + edges + reported evidence)
 * instead of walking the entire graph once per candidate package.
 */
export interface PeerRequirementIndex {
  byTargetPackage: ReadonlyMap<string, readonly IndexedPeerRequirement[]>;
}

export function buildPeerRequirementIndex(graph: DependencyGraph): PeerRequirementIndex {
  const directTargetNamesByNodeId = new Map<string, string>();
  for (const [nodeId, node] of graph.nodes) {
    if (node.direct) directTargetNamesByNodeId.set(nodeId, node.name);
  }

  const byTargetPackage = new Map<string, IndexedPeerRequirement[]>();
  for (const node of graph.nodes.values()) {
    for (const edge of node.edges) {
      if (
        edge.kind !== 'peer' ||
        edge.targetNodeId === null ||
        directTargetNamesByNodeId.get(edge.targetNodeId) !== edge.name ||
        node.name === edge.name
      ) {
        continue;
      }
      const candidate: IndexedPeerRequirement = {
        requiredBy: node.name,
        range: edge.requestedRange,
        optional: edge.optional,
        ownerDirect: node.direct,
      };
      const entries = byTargetPackage.get(edge.name);
      if (entries === undefined) byTargetPackage.set(edge.name, [candidate]);
      else entries.push(candidate);
    }
  }
  return { byTargetPackage };
}

export function peerRequirementsFor(
  graph: DependencyGraph,
  packageName: string,
  alsoRemoving: ReadonlySet<string>,
  index: PeerRequirementIndex = buildPeerRequirementIndex(graph)
): PeerRequirementEvidence[] {
  const byOwner = new Map<string, PeerRequirementEvidence>();
  for (const candidate of index.byTargetPackage.get(packageName) ?? []) {
    // Removing a direct owner makes its own peer requirement irrelevant, but
    // a transitive duplicate with the same name can remain installed and must
    // still be considered.
    if (candidate.ownerDirect && alsoRemoving.has(candidate.requiredBy)) continue;

    const existing = byOwner.get(candidate.requiredBy);
    // Duplicate installed copies of the same owner are presented once. A
    // required edge is stronger evidence than an optional edge, regardless
    // of which copy happens to appear first in the graph.
    if (
      existing === undefined ||
      (existing.optional && !candidate.optional) ||
      (existing.optional === candidate.optional && candidate.range.localeCompare(existing.range) < 0)
    ) {
      byOwner.set(candidate.requiredBy, {
        requiredBy: candidate.requiredBy,
        range: candidate.range,
        optional: candidate.optional,
      });
    }
  }
  return [...byOwner.values()].sort((a, b) => a.requiredBy.localeCompare(b.requiredBy));
}
