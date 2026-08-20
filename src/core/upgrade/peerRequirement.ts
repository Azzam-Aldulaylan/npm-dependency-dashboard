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
  const result: PeerRequirementEvidence[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.name === packageName || alsoRemoving.has(node.name) || seen.has(node.name)) continue;
    for (const edge of node.edges) {
      if (edge.kind !== 'peer' || edge.name !== packageName) continue;
      seen.add(node.name);
      result.push({ requiredBy: node.name, range: edge.requestedRange, optional: edge.optional });
      break;
    }
  }
  return result.sort((a, b) => a.requiredBy.localeCompare(b.requiredBy));
}
