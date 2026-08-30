export { buildDeprecatedCleanupFinding, buildDuplicateCleanupFinding } from './findings.js';
export type {
  BuildDeprecatedCleanupFindingOptions,
  BuildDuplicateCleanupFindingOptions,
} from './findings.js';
export { assessDuplicateConsolidation } from './consolidation.js';
export { collectDuplicateConstraintEvidence } from './consolidationEvidence.js';
export { cleanupGraphSignature } from './graphSignature.js';
export { resolveDeprecatedRemediation } from './deprecatedRemediation.js';
export type {
  AssessDuplicateConsolidationOptions,
  ConsolidationConstraint,
  ConsolidationConstraintKind,
  ConsolidationParentUpgrade,
  ConsolidationSimulation,
  DuplicateConsolidationAssessment,
} from './consolidation.js';
export type { DuplicateConstraintEvidence } from './consolidationEvidence.js';
export type {
  DeprecatedRemediation,
  ResolveDeprecatedRemediationOptions,
} from './deprecatedRemediation.js';
export { buildRemovalCleanupFinding } from './removal.js';
export type { BuildRemovalCleanupFindingOptions, RemovalCleanupResult } from './removal.js';
export { buildCleanupReport } from './report.js';
export type { BuildCleanupReportOptions, CleanupMetricInput } from './report.js';
export {
  MAX_SMART_CLEANUP_ACTIONS,
  canonicalCleanupActionBatch,
  defaultCleanupActionIds,
  rankCleanupActions,
  resolveCleanupSelection,
} from './selection.js';
export type { CleanupActionBatch, CleanupSelectionResult } from './selection.js';
export { cleanupSummaryHeadline, rankCleanupFindings, summarizeCleanup } from './summary.js';
export type { CleanupSummary } from './summary.js';
export type {
  CleanupAction,
  CleanupActionOutcome,
  CleanupActionOutcomeStatus,
  CleanupAnalyzerOutcome,
  CleanupAnalyzerStatus,
  CleanupConfidence,
  CleanupEvidence,
  CleanupFinding,
  CleanupFindingKind,
  CleanupMetric,
  CleanupPlan,
  CleanupReport,
  CleanupReportMetrics,
  CleanupSecurityImpact,
  DeprecatedCleanupFinding,
  DuplicateVersionCleanupFinding,
  RemoveDirectDependencyAction,
  UnusedCleanupFinding,
} from './types.js';
