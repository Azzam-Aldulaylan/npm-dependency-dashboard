/**
 * For a package about to be removed, which OTHER direct dependencies — not
 * also being removed in the same coordinated batch — still resolve through
 * it somewhere in the dependency graph. Reuses whyInstalled.ts's own path
 * index rather than a second graph traversal (see duplicates.ts for the
 * same reuse). Purely informational for the removal review step: never a
 * reason to refuse a removal the user explicitly asked for.
 */

import type { DeclaredDependency } from '../manifest/parse.js';
import type { DependencyGraph } from '../types.js';
import { whyInstalled } from '../hygiene/whyInstalled.js';

export function stillRequiredBy(
  graph: DependencyGraph,
  declared: readonly DeclaredDependency[],
  packageName: string,
  alsoRemoving: ReadonlySet<string>
): string[] {
  const result = whyInstalled(graph, declared, packageName);
  const requiredBy = new Set<string>();
  for (const version of result.versions) {
    for (const path of version.paths) {
      // path[0] is the root direct dependency that introduces this
      // resolution; a length-1 path is the package's own direct
      // declaration, not evidence that something else depends on it.
      if (path.length <= 1) continue;
      const root = path[0];
      if (root === undefined || root === packageName || alsoRemoving.has(root)) continue;
      requiredBy.add(root);
    }
  }
  return [...requiredBy].sort();
}
