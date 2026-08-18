/**
 * Dependency-hygiene finding model — shared, structured output for
 * deprecated-package, duplicate-version, and likely-unused detection.
 *
 * Deliberately not preformatted UI prose: `summary` is a short, neutral
 * sentence a caller may show as-is, but every fact a richer presentation
 * needs (paths, versions, confidence, scan provenance) lives in `evidence`
 * as structured data. This is what lets the same finding be rendered as a
 * table badge, a details drawer, and (later) a Cleanup Mode list without
 * three separate copies of the underlying logic.
 *
 * Nothing here may import 'vscode' — see ../types.ts.
 */

import type { DependencyClassification } from '../upgrade/plan.js';

export type DependencyFindingKind = 'deprecated' | 'duplicate-version' | 'likely-unused';

export type FindingConfidence = 'high' | 'medium' | 'low';

export type FindingSeverity = 'info' | 'warning' | 'attention';

export interface DeprecatedEvidence {
  kind: 'deprecated';
  /** The registry's own deprecation message, verbatim. */
  message: string;
  /**
   * A replacement package name, extracted only when the deprecation message
   * matched a known, explicit phrasing ("use X instead", "renamed to X", ...)
   * AND `X` parses as a syntactically valid npm package name. Never a guess
   * from arbitrary text — see detectDeprecatedFindings's own doc.
   */
  suggestedReplacement?: string;
}

/** One resolved version of a package, and the direct-dependency chains that introduce it — see whyInstalled.ts. */
export interface InstallPathVersionEntry {
  version: string;
  /** Set when this exact version is also the project's own direct declaration. */
  direct: { classification: DependencyClassification } | null;
  /** Package-name chains from a direct dependency down to this version, shortest first. Empty when this version is only ever the direct declaration itself. */
  paths: string[][];
  /** Distinct chains found, up to the exploration cap — see paths.ts. */
  totalPaths: number;
  /** True when more chains exist than `totalPaths` reports — the search was capped, not exhaustive. */
  truncated: boolean;
}

export interface DuplicateVersionEvidence {
  kind: 'duplicate-version';
  /** Every distinct resolved version found for this package name, each with its own introducing paths. Always length > 1 — that is the finding's own trigger condition. */
  versions: InstallPathVersionEntry[];
}

export interface LikelyUnusedEvidence {
  kind: 'likely-unused';
  /** Human-readable explanation of what was/wasn't found — see unused.ts. */
  reason: string;
  scannedFileCount: number;
  /** True when the workspace scan behind this finding was capped before covering every source file. */
  truncated: boolean;
}

export type DependencyFindingEvidence = DeprecatedEvidence | DuplicateVersionEvidence | LikelyUnusedEvidence;

export interface DependencyFinding {
  packageName: string;
  kind: DependencyFindingKind;
  /** Omitted for findings derived directly from registry/graph facts (deprecated, duplicate-version) — only a heuristic, static-analysis-driven finding (likely-unused) carries a confidence grade. */
  confidence?: FindingConfidence;
  severity: FindingSeverity;
  /** A short, neutral sentence — never prose built for one specific UI layout. */
  summary: string;
  evidence: DependencyFindingEvidence;
}
