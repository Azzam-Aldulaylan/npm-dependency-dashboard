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
import type { DependencyReference } from '../core/usage/types.js';

export function dependencyDescriptionCopy(row: PackageRow): string {
  return row.description ?? 'No package description is published for this dependency.';
}

export interface UsageSummaryCounts {
  /** Distinct files/locations touched by any reference — source files, `package.json` (for scripts), and config files alike. */
  referencedInFiles: number;
  /** Static `import`/`require` references — the two ways a module graph actually pulls this package in. */
  importStatements: number;
  dynamicImports: number;
  scripts: number;
  configReferences: number;
}

/** Pure tally over an already-completed usage scan's references — never a second scan, never a category the scanner doesn't already distinguish (see DependencyReferenceKind). */
export function usageSummaryCounts(references: readonly DependencyReference[]): UsageSummaryCounts {
  return {
    referencedInFiles: new Set(references.map((reference) => reference.filePath)).size,
    importStatements: references.filter((reference) => reference.kind === 'import' || reference.kind === 'require').length,
    dynamicImports: references.filter((reference) => reference.kind === 'dynamic-import').length,
    scripts: references.filter((reference) => reference.kind === 'script').length,
    configReferences: references.filter((reference) => reference.kind === 'config').length,
  };
}

/**
 * "Why it matters" — one sentence, entirely derived from the usage scan's
 * own counts. `null` counts means the scan hasn't finished (or hasn't run)
 * yet, never treated as "no usage found". Three honest outcomes: real
 * source-code usage, script/config-only usage (no source import), or none
 * found at all — never a confidence claim the scan itself can't back.
 */
export function usageSignificanceCopy(row: PackageRow, counts: UsageSummaryCounts | null): string {
  if (counts === null) return `Usage analysis for ${row.name} hasn't finished yet.`;
  if (counts.importStatements + counts.dynamicImports > 0) {
    return `${row.name} is referenced directly by application code and is actively used by this project.`;
  }
  if (counts.scripts > 0 || counts.configReferences > 0) {
    return `${row.name} isn't imported by application code, but is referenced from package.json scripts or configuration.`;
  }
  return `No direct source references to ${row.name} were found. Review its scripts, configuration, and dependency paths before removing it.`;
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
