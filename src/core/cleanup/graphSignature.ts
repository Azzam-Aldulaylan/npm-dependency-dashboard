import type { DependencyEdge, DependencyGraph } from '../types.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function edgeKey(edge: DependencyEdge): string {
  return JSON.stringify([
    edge.name,
    edge.requestedRange,
    edge.kind,
    edge.targetNodeId,
    edge.optional,
  ]);
}

/**
 * Canonical structural identity for a resolved dependency graph.
 *
 * The workspace root is deliberately excluded because isolated previews use
 * a temporary root. Node locations and resolved edges remain included so an
 * equal package/version inventory cannot hide different hoisting or peer
 * relationships.
 */
export function cleanupGraphSignature(graph: DependencyGraph): string {
  return JSON.stringify({
    packageManager: graph.packageManager,
    lockfileVersion: graph.lockfileVersion,
    nodes: [...graph.nodes.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([nodeId, node]) => ({
        nodeId,
        name: node.name,
        version: node.version,
        range: node.range,
        dev: node.dev,
        direct: node.direct,
        path: node.path,
        deps: [...node.deps].sort(compareText),
        edges: [...node.edges]
          .sort((left, right) => compareText(edgeKey(left), edgeKey(right)))
          .map((edge) => ({
            name: edge.name,
            requestedRange: edge.requestedRange,
            kind: edge.kind,
            targetNodeId: edge.targetNodeId,
            optional: edge.optional,
          })),
        unresolvable: node.unresolvable ?? null,
      })),
  });
}
