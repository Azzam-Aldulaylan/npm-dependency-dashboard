import type { ProjectSourceFingerprint } from '../core/cache/sourceFingerprint.js';
import { sourceFingerprintsMatch } from '../core/cache/sourceFingerprint.js';
import type { ScanSnapshot } from '../core/cache/schema.js';
import { vulnerabilitySnapshotMetrics } from '../core/advisories/metrics.js';
import type { VulnerabilityFindingMetric, VulnerabilitySnapshotMetrics } from '../core/advisories/metrics.js';
import { buildCleanupReport } from '../core/cleanup/report.js';
import type { CleanupActionOutcome, CleanupReport } from '../core/cleanup/types.js';

export interface SmartCleanupOperationIdentity {
  requestId: string;
  analysisId: string;
  projectId: string;
  refreshId: string;
  sourceGeneration: number;
  sourceFingerprint: ProjectSourceFingerprint;
}

export interface SmartCleanupBeforeSnapshot {
  snapshot: ScanSnapshot;
  projectId: string;
  sourceGeneration: number;
  sourceFingerprint: ProjectSourceFingerprint;
  /** Exact installed-version metadata, when the correlated analysis captured it. */
  deprecatedDirectPackages?: readonly string[];
  /** Versions covered by that complete exact metadata run. */
  deprecationInstalledVersions?: Readonly<Record<string, string>>;
}

export interface SmartCleanupAfterSnapshot {
  snapshot: ScanSnapshot;
  requestId: string;
  analysisId: string;
  projectId: string;
  refreshId: string;
  /** Watcher generation enclosing the disk read which seeded this refresh. */
  generationAtReadStart: number;
  /** Watcher generation observed after the refreshed snapshot completed. */
  generationAfterRead: number;
  /** Fingerprint which seeded the refresh. */
  sourceFingerprint: ProjectSourceFingerprint;
  /** Fresh confirmation after the refresh; must still describe the same source. */
  confirmedSourceFingerprint: ProjectSourceFingerprint;
  /** Exact installed-version metadata, when refreshed with the same identity. */
  deprecatedDirectPackages?: readonly string[];
}

/** Host panel evidence captured after its final dashboard reload and reread. */
export type SmartCleanupFinalRefreshEvidence = Omit<
  SmartCleanupAfterSnapshot,
  'requestId' | 'analysisId' | 'refreshId'
>;

export type SmartCleanupCompletionCorrelationCode =
  | 'REQUEST_MISMATCH'
  | 'ANALYSIS_MISMATCH'
  | 'PROJECT_MISMATCH'
  | 'REFRESH_MISMATCH'
  | 'STALE_BEFORE_SOURCE'
  | 'STALE_AFTER_SOURCE';

export interface SmartCleanupSecurityComparison {
  before: VulnerabilitySnapshotMetrics;
  after: VulnerabilitySnapshotMetrics;
  removedAdvisories: readonly VulnerabilityFindingMetric[];
  introducedAdvisories: readonly VulnerabilityFindingMetric[];
  remainingAdvisories: readonly VulnerabilityFindingMetric[];
}

export interface SmartCleanupCompletionReportResult {
  status: 'verified' | 'partial' | 'stale';
  report: CleanupReport;
  security: SmartCleanupSecurityComparison | null;
  code?: SmartCleanupCompletionCorrelationCode;
  reason?: string;
}

export interface BuildSmartCleanupCompletionReportOptions {
  operation: SmartCleanupOperationIdentity;
  before: SmartCleanupBeforeSnapshot;
  after: SmartCleanupAfterSnapshot;
  actions: readonly CleanupActionOutcome[];
  generatedAt?: string;
}

function duplicateGroupCount(snapshot: ScanSnapshot): number | null {
  if (snapshot.hygieneFindings === undefined) return null;
  return snapshot.hygieneFindings.filter((finding) => finding.kind === 'duplicate-version').length;
}

function deprecatedCount(packages: readonly string[] | undefined): number | null {
  return packages === undefined ? null : new Set(packages).size;
}

function unavailableReport(
  generatedAt: string,
  actions: readonly CleanupActionOutcome[],
  reason: string
): CleanupReport {
  return buildCleanupReport({
    generatedAt,
    metrics: {
      directDependencies: { before: null, after: null, unavailableReason: reason },
      deprecatedDirectDependencies: { before: null, after: null, unavailableReason: reason },
      duplicateVersionGroups: { before: null, after: null, unavailableReason: reason },
      vulnerabilities: { before: null, after: null, unavailableReason: reason },
    },
    actions,
  });
}

function staleResult(
  generatedAt: string,
  actions: readonly CleanupActionOutcome[],
  code: SmartCleanupCompletionCorrelationCode,
  reason: string
): SmartCleanupCompletionReportResult {
  return { status: 'stale', report: unavailableReport(generatedAt, actions, reason), security: null, code, reason };
}

function compareSecurity(
  before: VulnerabilitySnapshotMetrics,
  after: VulnerabilitySnapshotMetrics
): SmartCleanupSecurityComparison {
  const beforeByKey = new Map(before.findings.map((finding) => [finding.key, finding]));
  const afterByKey = new Map(after.findings.map((finding) => [finding.key, finding]));
  return {
    before,
    after,
    removedAdvisories: before.findings.filter((finding) => !afterByKey.has(finding.key)),
    introducedAdvisories: after.findings.filter((finding) => !beforeByKey.has(finding.key)),
    remainingAdvisories: after.findings.filter((finding) => beforeByKey.has(finding.key)),
  };
}

/**
 * Builds cleanup outcome claims only from the exact operation's stable,
 * refreshed source. A stale correlation fails closed; incomplete advisory
 * evidence preserves local graph metrics but never invents a security delta.
 */
export function buildSmartCleanupCompletionReport(
  options: BuildSmartCleanupCompletionReportOptions
): SmartCleanupCompletionReportResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const { operation, before, after } = options;

  if (after.requestId !== operation.requestId) {
    return staleResult(generatedAt, options.actions, 'REQUEST_MISMATCH', 'The refreshed result belongs to a different cleanup request.');
  }
  if (after.analysisId !== operation.analysisId) {
    return staleResult(generatedAt, options.actions, 'ANALYSIS_MISMATCH', 'The refreshed result belongs to a different cleanup analysis.');
  }
  if (before.projectId !== operation.projectId || after.projectId !== operation.projectId) {
    return staleResult(generatedAt, options.actions, 'PROJECT_MISMATCH', 'The project changed before cleanup results could be verified.');
  }
  if (after.refreshId !== operation.refreshId) {
    return staleResult(generatedAt, options.actions, 'REFRESH_MISMATCH', 'The dashboard refresh was not produced for this cleanup operation.');
  }
  if (
    before.sourceGeneration !== operation.sourceGeneration ||
    !sourceFingerprintsMatch(before.sourceFingerprint, operation.sourceFingerprint)
  ) {
    return staleResult(generatedAt, options.actions, 'STALE_BEFORE_SOURCE', 'The cleanup operation did not start from its recorded project source.');
  }
  if (
    after.generationAtReadStart !== after.generationAfterRead ||
    !sourceFingerprintsMatch(after.sourceFingerprint, after.confirmedSourceFingerprint)
  ) {
    return staleResult(generatedAt, options.actions, 'STALE_AFTER_SOURCE', 'Project files changed while cleanup results were being refreshed.');
  }

  const beforeDuplicates = duplicateGroupCount(before.snapshot);
  const afterDuplicates = duplicateGroupCount(after.snapshot);
  const beforeDeprecated = before.deprecationInstalledVersions === undefined
    ? null
    : deprecatedCount(before.deprecatedDirectPackages);
  const afterDeprecated = deprecatedCount(after.deprecatedDirectPackages);
  const advisoryEvidenceComplete =
    before.snapshot.availability.advisories === 'complete' &&
    after.snapshot.availability.advisories === 'complete';
  const beforeSecurity = advisoryEvidenceComplete ? vulnerabilitySnapshotMetrics(before.snapshot.rows) : null;
  const afterSecurity = advisoryEvidenceComplete ? vulnerabilitySnapshotMetrics(after.snapshot.rows) : null;
  const security = beforeSecurity === null || afterSecurity === null
    ? null
    : compareSecurity(beforeSecurity, afterSecurity);

  const report = buildCleanupReport({
    generatedAt,
    metrics: {
      directDependencies: { before: before.snapshot.rows.length, after: after.snapshot.rows.length },
      deprecatedDirectDependencies: {
        before: beforeDeprecated,
        after: afterDeprecated,
        unavailableReason: 'Exact installed-version deprecation results were not refreshed for this cleanup.',
      },
      duplicateVersionGroups: {
        before: beforeDuplicates,
        after: afterDuplicates,
        unavailableReason: 'Duplicate-version analysis was not present in both correlated snapshots.',
      },
      vulnerabilities: {
        before: beforeSecurity?.advisoryFindings ?? null,
        after: afterSecurity?.advisoryFindings ?? null,
        unavailableReason: 'Advisory data was unavailable in at least one correlated snapshot.',
      },
    },
    actions: options.actions,
  });

  const everyMetricVerified = Object.values(report.metrics).every((metric) => metric.status === 'verified');
  const scanAvailabilityComplete =
    before.snapshot.availability.updates === 'complete' &&
    after.snapshot.availability.updates === 'complete' &&
    advisoryEvidenceComplete;

  return everyMetricVerified && scanAvailabilityComplete
    ? { status: 'verified', report, security }
    : {
        status: 'partial',
        report,
        security,
        reason: advisoryEvidenceComplete
          ? 'Cleanup completed, but at least one refreshed result was unavailable or incomplete.'
          : 'Cleanup completed, but advisory data was unavailable in at least one correlated snapshot.',
      };
}
