/**
 * Pure Smart Cleanup domain contracts.
 *
 * A finding explains project state. An action is a separately-authorized
 * mutation the host may offer for that finding. Keeping those concepts
 * separate prevents an informational deprecation or duplicate-version fact
 * from accidentally becoming executable merely because it appears in a
 * cleanup plan.
 */

import type { DependencyClassification } from '../upgrade/plan.js';

export type CleanupAnalyzerOutcome = 'complete' | 'partial' | 'unavailable' | 'cancelled';

export type CleanupConfidence = 'low-risk' | 'review-required' | 'blocked' | 'unknown';

export type CleanupFindingKind = 'unused' | 'deprecated' | 'duplicate-version';

export interface CleanupAnalyzerStatus {
  analyzer: 'usage' | 'deprecation' | 'duplicates' | 'security';
  outcome: CleanupAnalyzerOutcome;
  /** Short explanation for a non-complete outcome. */
  message?: string;
}

export type CleanupEvidence =
  | {
      kind: 'direct-usage';
      state: 'used' | 'not-found' | 'unknown';
      summary: string;
    }
  | {
      kind: 'removal-assessment';
      summary: string;
    }
  | {
      kind: 'transitive-presence';
      summary: string;
    }
  | {
      kind: 'deprecation';
      message: string;
      suggestedReplacement?: string;
    }
  | {
      kind: 'duplicate-versions';
      versions: string[];
      excessVersionCount: number;
    };

interface CleanupFindingBase {
  /** Host-issued opaque identity; never derived from a package name in the webview. */
  id: string;
  kind: CleanupFindingKind;
  packageName: string;
  confidence: CleanupConfidence;
  summary: string;
  evidence: CleanupEvidence[];
  /** Host-issued actions related to this finding. Empty means informational only. */
  relatedActionIds: string[];
}

export interface UnusedCleanupFinding extends CleanupFindingBase {
  kind: 'unused';
  recommendation: 'remove' | 'review-removal' | 'keep-direct' | 'blocked' | 'unknown';
}

export interface DeprecatedCleanupFinding extends CleanupFindingBase {
  kind: 'deprecated';
  recommendation: 'remove-if-unused' | 'remediation-required' | 'informational' | 'unknown';
}

/**
 * Duplicate consolidation is deliberately analysis-only in the
 * removal-first release. The literal false and empty tuple make it
 * impossible for a duplicate finding to masquerade as an executable action.
 */
export interface DuplicateVersionCleanupFinding extends CleanupFindingBase {
  kind: 'duplicate-version';
  confidence: 'review-required' | 'blocked' | 'unknown';
  recommendation: 'analysis-only' | 'keep-both' | 'unknown';
  executable: false;
  relatedActionIds: [];
}

export type CleanupFinding =
  | UnusedCleanupFinding
  | DeprecatedCleanupFinding
  | DuplicateVersionCleanupFinding;

export interface RemoveDirectDependencyAction {
  id: string;
  kind: 'remove-direct-dependency';
  packageName: string;
  classification: DependencyClassification;
  /** Only these two outcomes may ever produce an executable removal. */
  confidence: 'low-risk' | 'review-required';
  reason: string;
  sourceFindingIds: string[];
}

/** v1 intentionally has one executable action kind. */
export type CleanupAction = RemoveDirectDependencyAction;

export interface CleanupSecurityImpact {
  outcome: CleanupAnalyzerOutcome;
  before: number | null;
  expectedAfter: number | null;
  expectedResolved: number | null;
  expectedIntroduced: number | null;
  message?: string;
}

export interface CleanupPlan {
  planId: string;
  generatedAt: string;
  findings: CleanupFinding[];
  actions: CleanupAction[];
  analyzers: CleanupAnalyzerStatus[];
  security: CleanupSecurityImpact;
}

export type CleanupActionOutcomeStatus = 'completed' | 'skipped' | 'failed';

export interface CleanupActionOutcome {
  actionId: string;
  packageName: string;
  status: CleanupActionOutcomeStatus;
  message?: string;
}

export type CleanupMetric =
  | {
      status: 'verified';
      before: number;
      after: number;
      improvedBy: number;
      regressedBy: number;
    }
  | {
      status: 'unavailable';
      reason: string;
    };

export interface CleanupReportMetrics {
  directDependencies: CleanupMetric;
  deprecatedDirectDependencies: CleanupMetric;
  duplicateVersionGroups: CleanupMetric;
  vulnerabilities: CleanupMetric;
}

export interface CleanupReport {
  generatedAt: string;
  metrics: CleanupReportMetrics;
  actions: CleanupActionOutcome[];
  headlineParts: string[];
  headline: string;
}
