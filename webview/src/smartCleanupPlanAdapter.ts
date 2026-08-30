import type { DependencyFinding } from '../../src/core/hygiene/types.js';
import type { AttributedAdvisory, PackageRow, RemovalAssessment } from '../../src/core/types.js';
import { vulnerabilityIdentifiers } from '../../src/core/advisories/identifiers.js';
import { canonicalAdvisoryFindingKey } from '../../src/core/advisories/metrics.js';
import type { RemovalImpactState } from './removalImpactState.js';
import type {
  SmartCleanupDeprecatedFinding,
  SmartCleanupDuplicateFinding,
  SmartCleanupPlan,
  SmartCleanupRemovalRecommendation,
  SmartCleanupSecurityFinding,
} from './smartCleanupState.js';
import type {
  SmartCleanupDedupeActionPresentation,
  SmartCleanupDuplicateAssessmentPresentation,
  SmartCleanupExecutionCapability,
} from '../../src/host/webviewProtocol.js';
import { resolveDeprecatedRemediation } from '../../src/core/cleanup/deprecatedRemediation.js';

function dependencyType(row: PackageRow): SmartCleanupRemovalRecommendation['dependencyType'] {
  if (row.optional) return 'optional';
  return row.dev ? 'development' : 'production';
}

function advisoryDisplayId(advisory: AttributedAdvisory): string | null {
  return vulnerabilityIdentifiers(advisory.advisory)[0] ?? null;
}

export interface BuildSmartCleanupPlanOptions {
  projectName: string;
  requestId: string;
  rows: readonly PackageRow[];
  hygieneFindings: readonly DependencyFinding[];
  exactDeprecatedFindings: readonly DependencyFinding[];
  removalImpact: RemovalImpactState;
  capability: SmartCleanupExecutionCapability;
  duplicateAssessments: readonly SmartCleanupDuplicateAssessmentPresentation[];
  dedupeAction: SmartCleanupDedupeActionPresentation | null;
}

/**
 * Presentation adapter over host-gathered evidence. It does not grant
 * mutation authority: execution still sends package names through the
 * existing host validation, fresh disk reread, and single-use removal plan.
 */
export function buildSmartCleanupPlan(options: BuildSmartCleanupPlanOptions): SmartCleanupPlan {
  const rowsByName = new Map(options.rows.map((row) => [row.name, row]));
  const assessmentByName: ReadonlyMap<string, { assessment: RemovalAssessment; usageId: string }> = options.removalImpact.phase === 'done'
    ? options.removalImpact.assessments
    : new Map<string, { assessment: RemovalAssessment; usageId: string }>();
  const duplicateAssessmentByName = new Map(
    options.duplicateAssessments.map((assessment) => [assessment.packageName, assessment])
  );
  const unusedNames = new Set(
    options.hygieneFindings
      .filter((finding) => finding.kind === 'likely-unused')
      .map((finding) => finding.packageName)
  );
  const recommendations: SmartCleanupRemovalRecommendation[] = [...unusedNames]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((packageName) => {
      const row = rowsByName.get(packageName);
      if (row === undefined) return [];
      const assessment = assessmentByName.get(packageName)?.assessment;
      const evidenceCapabilityReason = options.capability.executionSupported ? null : options.capability.reason;
      const confidence = evidenceCapabilityReason !== null
        ? 'blocked'
        : assessment?.status === 'low-risk'
        ? 'safe'
        : assessment?.status === 'review'
          ? 'review'
          : assessment?.status === 'blocked'
            ? 'blocked'
            : 'unknown';
      const evidence = evidenceCapabilityReason === null
        ? assessment?.evidence.map((entry) => entry.summary) ?? [
        'Removal-safety evidence is incomplete, so this dependency cannot be selected.',
          ]
        : [evidenceCapabilityReason, ...(assessment?.evidence.map((entry) => entry.summary) ?? [])];
      return [{
        id: `remove-direct:${packageName}`,
        kind: 'remove-direct-dependency' as const,
        packageName,
        dependencyType: dependencyType(row),
        confidence,
        rationale: evidenceCapabilityReason !== null
          ? 'This project can be analyzed, but Smart Cleanup removal is disabled for its current workspace or lockfile layout.'
          : confidence === 'safe'
          ? 'No project usage or blocking dependency requirement was found.'
          : confidence === 'review'
            ? 'No direct usage was found, but convention-based or incomplete evidence makes automatic removal uncertain. Review the evidence, then decide whether to include it.'
            : confidence === 'blocked'
              ? 'A known dependency requirement blocks automatic removal.'
              : `Not verified: ${evidence[0] ?? 'The removal-safety analysis did not return a reason.'}`,
        evidence,
      }];
    });
  const recommendationByPackage = new Map(recommendations.map((recommendation) => [recommendation.packageName, recommendation]));
  const actionIdByPackage = new Map(
    recommendations
      .filter((recommendation) => recommendation.confidence === 'safe' || recommendation.confidence === 'review')
      .map((recommendation) => [recommendation.packageName, recommendation.id])
  );

  const deprecated: SmartCleanupDeprecatedFinding[] = options.exactDeprecatedFindings
    .filter((finding) => finding.kind === 'deprecated' && finding.evidence.kind === 'deprecated')
    .sort((left, right) => left.packageName.localeCompare(right.packageName))
    .flatMap((finding) => {
      const row = rowsByName.get(finding.packageName);
      if (row === undefined || finding.evidence.kind !== 'deprecated') return [];
      const removalRecommendation = recommendationByPackage.get(finding.packageName);
      const assessment = assessmentByName.get(finding.packageName)?.assessment;
      const requiredBy = assessment?.evidence.flatMap((entry) =>
        entry.kind === 'peer-requirement' && !entry.optional
          ? [entry.requiredBy]
          : []
      ) ?? [];
      const relatedUpgrades = requiredBy.flatMap((packageName) => {
        const owner = rowsByName.get(packageName);
        return owner?.upgradeTo === null || owner?.upgradeTo === undefined
          ? []
          : [{ packageName, targetVersion: owner.upgradeTo }];
      });
      const nextStep = resolveDeprecatedRemediation({
        ...(removalRecommendation === undefined
          ? {}
          : {
              removalAction: {
                id: removalRecommendation.id,
                confidence: removalRecommendation.confidence,
              },
            }),
        upgradeTarget: row.upgradeTo,
        requiredBy,
        relatedUpgrades,
        ...(finding.evidence.suggestedReplacement === undefined
          ? {}
          : { suggestedReplacement: finding.evidence.suggestedReplacement }),
      });
      return [{
        id: `deprecated:${finding.packageName}`,
        packageName: finding.packageName,
        installedVersion: row.current,
        message: finding.evidence.message,
        ...(finding.evidence.suggestedReplacement === undefined
          ? {}
          : { suggestedReplacement: finding.evidence.suggestedReplacement }),
        nextStep,
      }];
    });

  const duplicates: SmartCleanupDuplicateFinding[] = options.hygieneFindings
    .filter((finding) => finding.kind === 'duplicate-version' && finding.evidence.kind === 'duplicate-version')
    .sort((left, right) => left.packageName.localeCompare(right.packageName))
    .map((finding) => {
      const versions = finding.evidence.kind === 'duplicate-version'
        ? finding.evidence.versions.map((entry) => ({
            version: entry.version,
            direct: entry.direct !== null,
            paths: entry.paths,
            totalPaths: entry.totalPaths,
            truncated: entry.truncated,
          }))
        : [];
      const directRoots = new Set<string>();
      for (const version of versions) {
        for (const path of version.paths) {
          const root = path[0];
          if (root !== undefined && rowsByName.has(root)) directRoots.add(root);
        }
        if (version.direct && rowsByName.has(finding.packageName)) directRoots.add(finding.packageName);
      }
      const assessment = duplicateAssessmentByName.get(finding.packageName);
      return {
        id: `duplicate:${finding.packageName}`,
        packageName: finding.packageName,
        versions,
        excessVersionCount: Math.max(0, versions.length - 1),
        directRoots: [...directRoots]
          .sort((left, right) => left.localeCompare(right))
          .map((packageName) => ({
            packageName,
            upgradeAvailable: (rowsByName.get(packageName)?.upgradeTo ?? null) !== null,
          })),
        summary: assessment?.outcome === 'safe-convergence'
          ? `The package-manager preview converged on ${assessment.targetVersion ?? 'one version'}.`
          : assessment?.outcome === 'keep-both'
            ? 'The package-manager preview confirmed that the current versions must remain separate.'
            : 'Multiple resolved versions are installed, but safe consolidation could not be verified.',
        outcome: assessment?.outcome ?? 'unknown',
        ...(assessment?.targetVersion === undefined ? {} : { targetVersion: assessment.targetVersion }),
        reason: assessment?.reason ?? 'The project-wide dedupe preview was unavailable.',
      };
    })
    .sort((left, right) =>
      right.excessVersionCount - left.excessVersionCount || left.packageName.localeCompare(right.packageName)
    );

  const securityByIdentity = new Map<string, Omit<SmartCleanupSecurityFinding, 'directRootActionIds' | 'directRoots' | 'directRootCount'> & {
    directRoots: Set<string>;
  }>();
  for (const row of options.rows) {
    for (const attributed of row.advisories) {
      const identity = canonicalAdvisoryFindingKey(attributed);
      const existing = securityByIdentity.get(identity);
      if (existing !== undefined) {
        existing.directRoots.add(row.name);
      } else {
        securityByIdentity.set(identity, {
          id: `security:${identity}`,
          advisoryId: advisoryDisplayId(attributed),
          packageName: attributed.flaggedPackage,
          severity: attributed.advisory.severity,
          summary: attributed.advisory.title,
          directRoots: new Set([row.name]),
        });
      }
    }
  }

  const severityRank = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 } as const;
  const security = [...securityByIdentity.values()].map(({ directRoots, ...finding }) => ({
    ...finding,
    directRoots: [...directRoots].sort((left, right) => left.localeCompare(right)),
    directRootActionIds: [...directRoots]
      .map((packageName) => actionIdByPackage.get(packageName))
      .filter((actionId): actionId is string => actionId !== undefined)
      .sort((left, right) => left.localeCompare(right)),
    directRootCount: directRoots.size,
  })).sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity] ||
    left.packageName.localeCompare(right.packageName) ||
    (left.advisoryId ?? '').localeCompare(right.advisoryId ?? '')
  );

  return {
    planId: `cleanup:${options.requestId}`,
    requestId: options.requestId,
    projectName: options.projectName,
    generatedAt: new Date().toISOString(),
    recommendations,
    deprecated,
    duplicates,
    dedupeAction: options.dedupeAction === null
      ? null
      : {
          id: options.dedupeAction.actionId,
          kind: 'dedupe-project',
          affectedPackages: options.dedupeAction.affectedPackages,
          expectedRemovedVersions: options.dedupeAction.expectedRemovedVersions,
          confidence: 'safe',
        },
    security,
  };
}
