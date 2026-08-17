/**
 * Deprecated-package detection.
 *
 * Reuses `PackageRow.deprecated`, which already carries the registry's own
 * `deprecated` field from `/<pkg>/latest` (see registry/versions.ts) — no
 * separate registry call. Only direct dependencies are ever considered here,
 * because `PackageRow[]` only ever contains direct dependencies (see
 * pipeline.ts's own `roots = directNodes(graph)`).
 */

import { isSafeNpmPackageName } from '../upgrade/plan.js';
import type { PackageRow } from '../types.js';
import type { DependencyFinding } from './types.js';

/**
 * Known, explicit deprecation phrasings that name a replacement package.
 * Deliberately narrow: a deprecation message is free-form maintainer prose,
 * and guessing a replacement from anything looser than these patterns would
 * risk presenting a wrong package as "the" suggested action. See the file's
 * own spec: "do not parse arbitrary text into a guaranteed replacement
 * package unless confidence is high."
 */
const REPLACEMENT_PATTERNS: RegExp[] = [
  /\buse\s+([^\s,;]+)\s+instead\b/i,
  /\bplease\s+use\s+([^\s,;]+)\b/i,
  /\brenamed\s+to\s+([^\s,;]+)\b/i,
  /\breplaced\s+by\s+([^\s,;]+)\b/i,
  /\bmigrate\s+to\s+([^\s,;]+)\b/i,
];

/** Strip common trailing punctuation/quoting a regex word-boundary match can pick up. */
function cleanCandidate(raw: string): string {
  return raw.replace(/^["'`]+/, '').replace(/["'`.,;:!?)]+$/, '');
}

/**
 * Extract a replacement package name from a deprecation message, only when
 * an explicit, unambiguous phrasing names one and it parses as a real npm
 * package name. Returns undefined otherwise — never a lower-confidence guess.
 */
export function extractSuggestedReplacement(message: string): string | undefined {
  for (const pattern of REPLACEMENT_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.[1] === undefined) continue;
    const candidate = cleanCandidate(match[1]);
    if (isSafeNpmPackageName(candidate)) return candidate;
  }
  return undefined;
}

/** Findings for every direct dependency the registry reports as deprecated. */
export function detectDeprecatedFindings(rows: readonly PackageRow[]): DependencyFinding[] {
  const findings: DependencyFinding[] = [];
  for (const row of rows) {
    if (row.deprecated === undefined) continue;
    const suggestedReplacement = extractSuggestedReplacement(row.deprecated);
    findings.push({
      packageName: row.name,
      kind: 'deprecated',
      confidence: 'high',
      severity: 'attention',
      summary: `${row.name} is deprecated by its maintainer`,
      evidence: {
        kind: 'deprecated',
        message: row.deprecated,
        ...(suggestedReplacement === undefined ? {} : { suggestedReplacement }),
      },
    });
  }
  return findings;
}
