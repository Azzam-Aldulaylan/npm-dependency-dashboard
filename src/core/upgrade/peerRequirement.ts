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

export function peerRequirementsFor(
  graph: DependencyGraph,
  packageName: string,
  alsoRemoving: ReadonlySet<string>
): PeerRequirementEvidence[] {
  // A name alone is not enough to identify the package being removed: the
  // graph can contain another copy at (for example)
  // node_modules/plugin/node_modules/react. Peer edges already carry the
  // package-manager-resolved node id, so only edges to the direct node are
  // evidence that removing that direct dependency breaks the owner.
  const directTargetNodeIds = new Set(
    [...graph.nodes.entries()]
      .filter(([, node]) => node.direct && node.name === packageName)
      .map(([nodeId]) => nodeId)
  );
  if (directTargetNodeIds.size === 0) return [];

  const byOwner = new Map<string, PeerRequirementEvidence>();
  for (const node of graph.nodes.values()) {
    // Removing a direct owner makes its own peer requirement irrelevant, but
    // a transitive duplicate with the same name can remain installed and must
    // still be considered.
    if (node.name === packageName || (node.direct && alsoRemoving.has(node.name))) continue;
    for (const edge of node.edges) {
      if (
        edge.kind !== 'peer' ||
        edge.name !== packageName ||
        edge.targetNodeId === null ||
        !directTargetNodeIds.has(edge.targetNodeId)
      ) {
        continue;
      }

      const candidate = { requiredBy: node.name, range: edge.requestedRange, optional: edge.optional };
      const existing = byOwner.get(node.name);
      // Duplicate installed copies of the same owner are presented once. A
      // required edge is stronger evidence than an optional edge, regardless
      // of which copy happens to appear first in the graph.
      if (
        existing === undefined ||
        (existing.optional && !candidate.optional) ||
        (existing.optional === candidate.optional && candidate.range.localeCompare(existing.range) < 0)
      ) {
        byOwner.set(node.name, candidate);
      }
    }
  }
  return [...byOwner.values()].sort((a, b) => a.requiredBy.localeCompare(b.requiredBy));
}
