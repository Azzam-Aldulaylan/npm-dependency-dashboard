/**
 * Turn a completed usage scan into a "likely unused" finding — never an
 * absolute "unused dependency" claim from static analysis alone. See the
 * redesign brief's own confidence-model requirement.
 *
 * Only direct dependencies are ever considered here (the caller is expected
 * to have scanned only direct dependency names) — transitive dependencies
 * are never labeled unused.
 */

import { isFrameworkConventionPackage } from './frameworkConventions.js';
import type { DependencyFinding } from '../hygiene/types.js';
import type { DependencyUsageResult } from './types.js';

/**
 * Returns null when the package has at least one reference — it is not
 * unused, so there is nothing to report. Otherwise a `likely-unused`
 * finding, graded:
 *
 *   - `low` confidence whenever the scan itself was incomplete (`truncated`)
 *     — an absence of evidence from a partial scan proves nothing.
 *   - `low` confidence when the package name matches a known
 *     framework/tooling convention (see frameworkConventions.ts) — commonly
 *     loaded without a reference this scanner can see.
 *   - `high` confidence otherwise: a full scan found no static imports,
 *     requires, dynamic imports, package.json scripts, or recognized
 *     configuration references at all.
 */
export function buildUnusedFinding(packageName: string, usage: DependencyUsageResult): DependencyFinding | null {
  if (usage.references.length > 0) return null;

  const conventionPackage = isFrameworkConventionPackage(packageName);
  const lowConfidence = usage.truncated || conventionPackage;

  const reason = usage.truncated
    ? 'The workspace scan was capped before covering every source file, so this may be a false positive.'
    : conventionPackage
      ? 'No code references found, but this package type is commonly loaded through framework/config conventions.'
      : 'No static imports, requires, dynamic imports, package.json scripts, or recognized configuration references were found.';

  return {
    packageName,
    kind: 'likely-unused',
    confidence: lowConfidence ? 'low' : 'high',
    severity: lowConfidence ? 'info' : 'warning',
    summary: lowConfidence ? `${packageName} may be unused` : `${packageName} appears unused`,
    evidence: {
      kind: 'likely-unused',
      reason,
      scannedFileCount: usage.scannedFileCount,
      truncated: usage.truncated,
    },
  };
}
