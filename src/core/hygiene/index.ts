/**
 * Aggregate entry point for the deterministic, graph-only hygiene findings
 * (deprecated + duplicate-version) — the ones cheap enough to compute on
 * every scan alongside the existing pipeline (see pipeline.ts). Likely-unused
 * findings are deliberately NOT included here: they require an on-demand
 * workspace scan (see ../usage/) and must never run as part of a normal
 * dashboard load — see the redesign brief's performance boundary.
 */

import type { DeclaredDependency } from '../manifest/parse.js';
import type { DependencyGraph, PackageRow } from '../types.js';
import { detectDeprecatedFindings } from './deprecated.js';
import { detectDuplicateVersionFindings } from './duplicates.js';
import type { DependencyFinding } from './types.js';

export function computeGraphHygieneFindings(
  rows: readonly PackageRow[],
  graph: DependencyGraph,
  declared: readonly DeclaredDependency[]
): DependencyFinding[] {
  return [...detectDeprecatedFindings(rows), ...detectDuplicateVersionFindings(graph, declared)];
}

export type { DependencyFinding, DependencyFindingKind, FindingConfidence, FindingSeverity } from './types.js';
export { summarizeHygieneFindings } from './summary.js';
export type { DependencyHygieneSummary } from './summary.js';
export { buildWhyInstalledIndex, whyInstalled } from './whyInstalled.js';
export type { WhyInstalledIndex, WhyInstalledResult } from './whyInstalled.js';
