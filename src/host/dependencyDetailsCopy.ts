/**
 * Presentation-layer synthesis for the row-level "Dependency details" view —
 * built entirely from data already on hand (a `PackageRow` plus the scan's
 * own `hygieneFindings`), never a new host round trip. See the redesign
 * brief's own Section 6 ("Why Is This Installed?"): for a direct
 * dependency — the only kind that ever has a table row — the answer is
 * always derivable from `row.dev`/`row.range` directly; the "transitive
 * parent chain" half of the same question is answered by whichever
 * duplicate-version finding (if any) already carries this exact package's
 * introducing paths, reusing the one shared path implementation rather than
 * a second one (see src/core/graph/paths.ts).
 */

import type { DependencyFinding } from '../core/hygiene/types.js';
import type { PackageRow } from '../core/types.js';

export function directDeclarationCopy(row: PackageRow): string {
  const kind = row.dev ? 'development' : 'production';
  const block = row.dev ? 'devDependencies' : 'dependencies';
  return `Direct ${kind} dependency — declared in package.json's ${block}`;
}

export function deprecatedFindingFor(
  findings: readonly DependencyFinding[],
  packageName: string
): DependencyFinding | undefined {
  return findings.find((finding) => finding.kind === 'deprecated' && finding.packageName === packageName);
}

/** The duplicate-version finding *about this exact package*, if its own resolved version isn't unique across the graph. */
export function ownDuplicateFinding(
  findings: readonly DependencyFinding[],
  packageName: string
): DependencyFinding | undefined {
  return findings.find((finding) => finding.kind === 'duplicate-version' && finding.packageName === packageName);
}

/**
 * Duplicate-version findings this package *introduces* — i.e. findings
 * about some other (usually transitive) package where at least one
 * version's path chain starts with this package's own name. Excludes the
 * package's own duplicate finding (see ownDuplicateFinding above) even if a
 * version entry's path happens to start with the same name for some other
 * reason.
 */
export function introducedDuplicateFindings(
  findings: readonly DependencyFinding[],
  packageName: string
): DependencyFinding[] {
  return findings.filter((finding) => {
    if (finding.packageName === packageName || finding.evidence.kind !== 'duplicate-version') return false;
    return finding.evidence.versions.some((entry) => entry.paths.some((path) => path[0] === packageName));
  });
}
