import semver from 'semver';

import type { DependencyEdgeKind, DependencyGraph } from '../types.js';
import type { ConsolidationConstraint } from './consolidation.js';

export interface DuplicateConstraintEvidence {
  versions: readonly string[];
  constraints: readonly ConsolidationConstraint[];
  constraintsComplete: boolean;
  reason?: string;
}

function constraintKind(kind: DependencyEdgeKind): ConsolidationConstraint['kind'] {
  if (kind === 'peer') return 'peer';
  if (kind === 'optional') return 'optional';
  return 'dependency';
}

/**
 * Collects every lockfile relationship which resolves to one occurrence of a
 * duplicated package. Completeness is explicit: an unresolved edge, a legacy
 * npm v1 graph (which cannot prove peer contexts), or an occurrence with no
 * incoming/direct declaration causes the caller to fail closed.
 */
export function collectDuplicateConstraintEvidence(
  graph: DependencyGraph,
  packageName: string
): DuplicateConstraintEvidence {
  const occurrences = [...graph.nodes.entries()]
    .filter(([, node]) => node.name === packageName && node.version !== null);
  const versions = [...new Set(occurrences.flatMap(([, node]) => node.version === null ? [] : [node.version]))]
    .sort((left, right) => {
      if (semver.valid(left) !== null && semver.valid(right) !== null) return semver.compare(left, right);
      return left.localeCompare(right);
    });
  if (versions.length === 0) {
    return { versions, constraints: [], constraintsComplete: false, reason: 'No resolved version remains.' };
  }
  if (graph.packageManager === 'npm' && graph.lockfileVersion === 1) {
    return {
      versions,
      constraints: [],
      constraintsComplete: false,
      reason: 'npm lockfile version 1 does not preserve complete peer-dependency contexts.',
    };
  }

  const occurrenceIds = new Set(occurrences.map(([nodeId]) => nodeId));
  const covered = new Set<string>();
  const constraints: ConsolidationConstraint[] = [];
  let unresolved = false;

  for (const [targetNodeId, node] of occurrences) {
    if (!node.direct) continue;
    covered.add(targetNodeId);
    constraints.push({
      dependentPackage: '<project>',
      dependentVersion: null,
      dependentNodeId: '<project>',
      targetNodeId,
      kind: 'dependency',
      range: node.range,
      optional: false,
    });
  }

  for (const [dependentNodeId, dependent] of graph.nodes) {
    for (const edge of dependent.edges) {
      if (edge.name !== packageName) continue;
      if (edge.targetNodeId === null) {
        unresolved = true;
        continue;
      }
      if (!occurrenceIds.has(edge.targetNodeId)) continue;
      covered.add(edge.targetNodeId);
      constraints.push({
        dependentPackage: dependent.name,
        dependentVersion: dependent.version,
        dependentNodeId,
        targetNodeId: edge.targetNodeId,
        kind: constraintKind(edge.kind),
        range: edge.requestedRange,
        optional: edge.optional,
      });
    }
  }

  const constraintsComplete = !unresolved && covered.size === occurrenceIds.size;
  return {
    versions,
    constraints: constraints.sort((left, right) =>
      (left.dependentNodeId ?? '').localeCompare(right.dependentNodeId ?? '') ||
      (left.targetNodeId ?? '').localeCompare(right.targetNodeId ?? '') ||
      left.kind.localeCompare(right.kind) ||
      left.range.localeCompare(right.range)
    ),
    constraintsComplete,
    ...(constraintsComplete
      ? {}
      : { reason: unresolved ? 'At least one dependency edge was unresolved.' : 'At least one resolved occurrence had no complete introducing constraint.' }),
  };
}
