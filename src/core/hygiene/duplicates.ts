/**
 * Duplicate-version detection.
 *
 * Groups every graph node by package name -> distinct resolved versions
 * (reusing whyInstalled.ts's own grouping, so this and "Why installed" can
 * never drift into two different answers for the same package). A finding
 * exists only when a name resolves to more than one distinct version
 * somewhere in the graph — the same version installed at multiple paths is
 * not a duplicate, and is never reported as one, because whyInstalled's own
 * `byVersion` grouping already collapses those into a single version entry.
 *
 * Builds exactly one `InstallPathIndex` (graph/paths.ts) and reuses it for
 * every package name, rather than re-walking the graph per name — see that
 * module's own doc for why this matters on large graphs.
 */

import type { DeclaredDependency } from '../manifest/parse.js';
import type { DependencyGraph } from '../types.js';
import type { PathSearchOptions } from '../graph/paths.js';
import type { DependencyFinding } from './types.js';
import { buildWhyInstalledIndex, whyInstalled } from './whyInstalled.js';

function describeVersions(count: number): string {
  return `${count} versions`;
}

export function detectDuplicateVersionFindings(
  graph: DependencyGraph,
  declared: readonly DeclaredDependency[],
  options: PathSearchOptions = {}
): DependencyFinding[] {
  const index = buildWhyInstalledIndex(graph);

  const names = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.version !== null) names.add(node.name);
  }

  const findings: DependencyFinding[] = [];
  for (const name of [...names].sort()) {
    const result = whyInstalled(graph, declared, name, options, index);
    if (result.versions.length <= 1) continue;

    findings.push({
      packageName: name,
      kind: 'duplicate-version',
      severity: 'attention',
      summary: `${describeVersions(result.versions.length)} of ${name} are installed`,
      evidence: { kind: 'duplicate-version', versions: result.versions },
    });
  }
  return findings;
}
