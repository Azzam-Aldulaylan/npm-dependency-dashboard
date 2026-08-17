/**
 * Compact counts derived from a set of findings — domain output for a
 * future Cleanup Mode / Health Score, not a new top-level UI card by
 * itself. See the redesign brief's own "Cleanup Summary" section.
 */

import type { DependencyFinding } from './types.js';

export interface DependencyHygieneSummary {
  deprecated: number;
  duplicateVersionGroups: number;
  likelyUnused: number;
}

export function summarizeHygieneFindings(findings: readonly DependencyFinding[]): DependencyHygieneSummary {
  let deprecated = 0;
  let duplicateVersionGroups = 0;
  let likelyUnused = 0;
  for (const finding of findings) {
    if (finding.kind === 'deprecated') deprecated += 1;
    else if (finding.kind === 'duplicate-version') duplicateVersionGroups += 1;
    else likelyUnused += 1;
  }
  return { deprecated, duplicateVersionGroups, likelyUnused };
}
