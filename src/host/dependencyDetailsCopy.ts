/**
 * Presentation-layer synthesis for the row-level "Dependency details" view —
 * built entirely from data already on hand (a `PackageRow` plus the scan's
 * own `hygieneFindings`), never a new host round trip. See the redesign
 * brief's row-level details surface. Table rows are always direct
 * dependencies, so repeating “declared in dependencies/devDependencies” for
 * every package provides little information. The About card instead uses the
 * registry description already returned by /latest. Duplicate introduction
 * paths continue to reuse the graph's shared path implementation.
 */

import type { DependencyFinding } from '../core/hygiene/types.js';
import type { PackageRow } from '../core/types.js';

export function dependencyDescriptionCopy(row: PackageRow): string {
  return row.description ?? 'No package description is published for this dependency.';
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
