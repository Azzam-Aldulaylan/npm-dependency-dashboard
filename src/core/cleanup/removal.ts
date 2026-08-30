import type { RemovalAssessment } from '../types.js';
import type { DependencyClassification } from '../upgrade/plan.js';
import type {
  CleanupAction,
  CleanupEvidence,
  CleanupConfidence,
  UnusedCleanupFinding,
} from './types.js';

export interface BuildRemovalCleanupFindingOptions {
  findingId: string;
  actionId: string;
  packageName: string;
  classification: DependencyClassification;
  /** Whether the project itself was observed using its direct declaration. */
  directUsage: 'used' | 'not-found' | 'unknown';
  /** Informational only. It must never add confidence for removing the direct declaration. */
  transitivelyPresent: boolean;
  assessment: RemovalAssessment;
}

export interface RemovalCleanupResult {
  finding: UnusedCleanupFinding;
  action: CleanupAction | null;
}

function usageEvidence(state: BuildRemovalCleanupFindingOptions['directUsage']): CleanupEvidence {
  if (state === 'used') {
    return {
      kind: 'direct-usage',
      state,
      summary: 'The project directly uses this package, so its direct declaration should be kept.',
    };
  }
  if (state === 'unknown') {
    return {
      kind: 'direct-usage',
      state,
      summary: 'Direct project usage could not be determined from the available evidence.',
    };
  }
  return {
    kind: 'direct-usage',
    state,
    summary: 'No direct project usage was found in the completed scan.',
  };
}

function confidenceFromAssessment(status: RemovalAssessment['status']): CleanupConfidence {
  if (status === 'low-risk') return 'low-risk';
  if (status === 'review') return 'review-required';
  return status;
}

function assessmentEvidence(assessment: RemovalAssessment): CleanupEvidence[] {
  return assessment.evidence.map((entry) => ({
    kind: 'removal-assessment',
    summary: entry.summary,
  }));
}

/**
 * Converts host-gathered removal evidence into a Smart Cleanup finding and,
 * only when justified, an executable direct-removal action.
 *
 * Two invariants are enforced here rather than left to UI convention:
 *  - observed direct project use always means keep the direct declaration;
 *  - transitive installation is informational and contributes zero removal
 *    confidence. It may mean the package remains installed after removing a
 *    declaration, but never proves that the declaration is redundant.
 */
export function buildRemovalCleanupFinding(
  options: BuildRemovalCleanupFindingOptions
): RemovalCleanupResult {
  const evidence: CleanupEvidence[] = [usageEvidence(options.directUsage)];
  if (options.transitivelyPresent) {
    evidence.push({
      kind: 'transitive-presence',
      summary: 'This package is also installed transitively; that does not make its direct declaration redundant.',
    });
  }
  evidence.push(...assessmentEvidence(options.assessment));

  if (options.directUsage === 'used') {
    return {
      finding: {
        id: options.findingId,
        kind: 'unused',
        packageName: options.packageName,
        confidence: 'blocked',
        recommendation: 'keep-direct',
        summary: `${options.packageName} is directly used by the project and should remain declared`,
        evidence,
        relatedActionIds: [],
      },
      action: null,
    };
  }

  if (options.directUsage === 'unknown') {
    return {
      finding: {
        id: options.findingId,
        kind: 'unused',
        packageName: options.packageName,
        confidence: 'unknown',
        recommendation: 'unknown',
        summary: `Could not determine whether ${options.packageName} is unused`,
        evidence,
        relatedActionIds: [],
      },
      action: null,
    };
  }

  const confidence = confidenceFromAssessment(options.assessment.status);
  if (confidence === 'blocked' || confidence === 'unknown') {
    return {
      finding: {
        id: options.findingId,
        kind: 'unused',
        packageName: options.packageName,
        confidence,
        recommendation: confidence,
        summary:
          confidence === 'blocked'
            ? `${options.packageName} cannot be removed because a known requirement blocks it`
            : `Could not establish enough evidence to remove ${options.packageName}`,
        evidence,
        relatedActionIds: [],
      },
      action: null,
    };
  }

  const action: CleanupAction = {
    id: options.actionId,
    kind: 'remove-direct-dependency',
    packageName: options.packageName,
    classification: options.classification,
    confidence,
    reason:
      confidence === 'low-risk'
        ? 'No direct project usage or blocking dependency requirement was found.'
        : 'No direct source usage was found, but other evidence requires deliberate review.',
    sourceFindingIds: [options.findingId],
  };
  return {
    finding: {
      id: options.findingId,
      kind: 'unused',
      packageName: options.packageName,
      confidence,
      recommendation: confidence === 'low-risk' ? 'remove' : 'review-removal',
      summary:
        confidence === 'low-risk'
          ? `${options.packageName} is a low-risk removal candidate`
          : `${options.packageName} may be removable after review`,
      evidence,
      relatedActionIds: [options.actionId],
    },
    action,
  };
}
