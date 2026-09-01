import type {
  RemediationAdvisoryEvidence,
  TransitiveRemediationPlan,
  TransitiveRemediationReason,
} from '../core/advisories/transitiveRemediationPlan.js';
import type {
  TransitiveRemediationAdvisorySummary,
  TransitiveRemediationChange,
  TransitiveRemediationPlanSummary,
  UpgradeAnalysisVerification,
} from './webviewProtocol.js';

const REASON_TEXT: Record<TransitiveRemediationReason, string> = {
  MANIFEST_CHANGED: 'The package manager changed package.json while preparing the candidate.',
  PACKAGE_MANAGER_CHANGED: 'The candidate does not use the current project package manager.',
  ROOT_NOT_DIRECT_DEPENDENCY: 'The selected package is no longer a direct dependency in the candidate graph.',
  DIRECT_DEPENDENCY_CHANGED: 'One or more direct dependency versions would change.',
  SECURITY_EVIDENCE_UNAVAILABLE: 'Complete advisory evidence was unavailable for the proposed graph.',
  INVALID_ADVISORY_RANGE: 'An advisory contains a version range that could not be verified safely.',
  TARGET_ADVISORY_NOT_FOUND: 'The selected advisory could not be correlated with the proposed graph.',
  NEW_ADVISORY_INTRODUCED: 'The proposed graph introduces a new advisory finding.',
  ADVISORY_WORSENED: 'The proposed graph worsens an existing advisory finding.',
  NO_TARGET_ADVISORY_RESOLVED: 'The targeted update does not remove any selected advisory.',
  TARGET_ADVISORIES_REMAIN: 'The candidate resolves some selected advisories, but others remain.',
};

const MAX_PRESENTED_CHANGES = 200;
const MAX_PRESENTED_ADVISORIES = 400;
const MAX_PRESENTED_PATHS = 32;
const MAX_PRESENTED_VERSIONS = 32;
const MAX_PRESENTED_IDENTIFIERS = 32;

function advisorySummary(evidence: RemediationAdvisoryEvidence): TransitiveRemediationAdvisorySummary {
  const paths = [...evidence.beforeInstances, ...evidence.afterInstances]
    .flatMap((instance) => instance.dependencyPaths);
  const seen = new Set<string>();
  const affectedPaths = paths.filter((path) => {
    const key = path.join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    advisoryId: evidence.identity,
    identifiers: evidence.aliases
      .filter((identifier) => {
        const normalized = identifier.toUpperCase();
        return normalized.startsWith('CVE-') || normalized.startsWith('GHSA-');
      })
      .slice(0, MAX_PRESENTED_IDENTIFIERS),
    title: evidence.title,
    severity: evidence.severity,
    flaggedPackage: evidence.flaggedPackage,
    affectedPaths: affectedPaths.slice(0, MAX_PRESENTED_PATHS),
  };
}

function changesFor(
  plan: TransitiveRemediationPlan,
  targetedPackages: ReadonlySet<string>
): TransitiveRemediationChange[] {
  const byPackage = new Map<string, {
    fromVersions: Set<string>;
    toVersions: Set<string>;
    lockfilePaths: Set<string>;
  }>();
  for (const change of plan.packageChanges) {
    const group = byPackage.get(change.packageName) ?? {
      fromVersions: new Set<string>(),
      toVersions: new Set<string>(),
      lockfilePaths: new Set<string>(),
    };
    if (change.beforeVersion !== null) group.fromVersions.add(change.beforeVersion);
    if (change.afterVersion !== null) group.toVersions.add(change.afterVersion);
    group.lockfilePaths.add(change.lockfilePath);
    byPackage.set(change.packageName, group);
  }

  const evidenceByPackage = new Map<string, string[][]>();
  for (const evidence of [...plan.security.resolved, ...plan.security.remaining]) {
    const current = evidenceByPackage.get(evidence.flaggedPackage) ?? [];
    current.push(...evidence.beforeInstances.flatMap((instance) => instance.dependencyPaths));
    current.push(...evidence.afterInstances.flatMap((instance) => instance.dependencyPaths));
    evidenceByPackage.set(evidence.flaggedPackage, current);
  }

  return [...byPackage.entries()]
    .map(([packageName, group]) => {
      const sourcePaths = evidenceByPackage.get(packageName) ?? [];
      const seen = new Set<string>();
      const affectedPaths = sourcePaths.filter((path) => {
        const key = path.join('\u0000');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        packageName,
        fromVersions: [...group.fromVersions].sort().slice(0, MAX_PRESENTED_VERSIONS),
        toVersions: [...group.toVersions].sort().slice(0, MAX_PRESENTED_VERSIONS),
        affectedPaths: affectedPaths.slice(0, MAX_PRESENTED_PATHS),
        targeted: targetedPackages.has(packageName),
      };
    })
    .sort((left, right) => Number(right.targeted) - Number(left.targeted) || left.packageName.localeCompare(right.packageName))
    .slice(0, MAX_PRESENTED_CHANGES);
}

function explanationFor(plan: TransitiveRemediationPlan): string {
  if (plan.classification === 'full') {
    return 'The lockfile can resolve the vulnerable transitive dependencies to non-vulnerable versions without changing any direct dependency.';
  }
  if (plan.classification === 'partial') {
    return 'The proposed lockfile resolves some selected advisories without changing any direct dependency, but other advisories remain.';
  }
  if (plan.classification === 'no-fix') {
    return 'The current dependency ranges do not produce a targeted transitive change that resolves the selected advisory.';
  }
  return 'The resolver produced a candidate, but it is not safe enough to apply automatically.';
}

export interface BuildTransitiveRemediationPresentationOptions {
  analysisId: string;
  generatedAt: string;
  expiresAt: string;
  rootPackage: string;
  currentVersion: string;
  packageManager: 'npm' | 'pnpm';
  packageManagerVersion: string | null;
  lifecycleScriptsEnabled: boolean;
  manifestPath: string;
  lockfilePath: string;
  plan: TransitiveRemediationPlan;
  targetedPackages: ReadonlySet<string>;
  verification: UpgradeAnalysisVerification;
}

export function buildTransitiveRemediationPresentation(
  options: BuildTransitiveRemediationPresentationOptions
): TransitiveRemediationPlanSummary {
  return {
    analysisId: options.analysisId,
    rootPackage: options.rootPackage,
    currentVersion: options.currentVersion,
    outcome: options.plan.classification,
    explanation: explanationFor(options.plan),
    generatedAt: options.generatedAt,
    expiresAt: options.expiresAt,
    packageManager: options.packageManager,
    packageManagerVersion: options.packageManagerVersion,
    lifecycleScriptsEnabled: options.lifecycleScriptsEnabled,
    directRootUnchanged: options.plan.directDependencyChanges.length === 0,
    files: {
      manifestPath: options.manifestPath,
      lockfilePath: options.lockfilePath,
      manifestChanged: !options.plan.manifestUnchanged,
      lockfileChanged: options.plan.packageChanges.length > 0,
    },
    changes: changesFor(options.plan, options.targetedPackages),
    resolvedAdvisories: options.plan.target.resolved.slice(0, MAX_PRESENTED_ADVISORIES).map(advisorySummary),
    remainingAdvisories: options.plan.target.remaining.slice(0, MAX_PRESENTED_ADVISORIES).map(advisorySummary),
    introducedAdvisories: options.plan.security.introduced.slice(0, MAX_PRESENTED_ADVISORIES).map(advisorySummary),
    blockingReasons: options.plan.reasons.map((reason) => REASON_TEXT[reason]),
    verification: options.verification,
  };
}
