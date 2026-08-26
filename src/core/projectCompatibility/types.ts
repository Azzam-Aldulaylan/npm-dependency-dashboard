export type ProjectCompatibilityConfidence = 'confirmed' | 'likely' | 'review';

export type ProjectCompatibilityCategory =
  | 'import'
  | 'private-api'
  | 'runtime'
  | 'config'
  | 'script'
  | 'tooling'
  | 'compiler'
  | 'framework-migration';

/**
 * Correlation identity for every project-compatibility result. The host owns
 * these values; a webview must never be allowed to substitute them.
 */
export interface ProjectCompatibilityIdentity {
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  requestId: string;
  sourceFingerprint: string;
}

export type ProjectCompatibilityEvidenceKind =
  | 'source-reference'
  | 'package-script'
  | 'project-engine'
  | 'runtime-version'
  | 'target-metadata'
  | 'target-package-surface'
  | 'manifest-dependency'
  | 'project-config';

/**
 * Sanitized evidence for display. The usage-reference tuple is issued and
 * resolved by the host; consumers must not treat `filePath` as navigation
 * authority.
 */
export interface ProjectCompatibilityEvidence {
  kind: ProjectCompatibilityEvidenceKind;
  filePath?: string;
  line?: number;
  column?: number;
  snippet?: string;
  context?: string;
  specifier?: string;
  usageId?: string;
  referenceIndex?: number;
}

export interface ProjectCompatibilityFinding {
  /** Stable within one project/source/target identity. */
  id: string;
  category: ProjectCompatibilityCategory;
  confidence: ProjectCompatibilityConfidence;
  packageName: string;
  targetVersion: string;
  title: string;
  explanation: string;
  migrationHint?: string;
  evidence: ProjectCompatibilityEvidence[];
  source: 'generic' | 'framework-rule';
  ruleId?: string;
}

export type ProjectCompatibilityAnalyzerStatus =
  | 'complete'
  | 'partial'
  | 'unavailable'
  | 'cancelled';

/** One independently-failing analyzer outcome. */
export interface ProjectCompatibilityAnalyzerResult {
  analyzerId: string;
  status: ProjectCompatibilityAnalyzerStatus;
  findings: ProjectCompatibilityFinding[];
  /** Stable, non-sensitive reason code. Never a thrown message or raw output. */
  unavailableReason?: string;
  durationMs?: number;
}

export interface ProjectCompatibilityAnalysis {
  identity: ProjectCompatibilityIdentity;
  analyzers: ProjectCompatibilityAnalyzerResult[];
  findings: ProjectCompatibilityFinding[];
  startedAt: string;
  completedAt: string;
}

export interface ProjectCompatibilityAnalyzerContext {
  identity: ProjectCompatibilityIdentity;
}

export type ProjectCompatibilityAnalyzer = (
  context: ProjectCompatibilityAnalyzerContext,
  signal?: AbortSignal
) => Promise<ProjectCompatibilityAnalyzerResult> | ProjectCompatibilityAnalyzerResult;
