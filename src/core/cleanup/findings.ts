import type {
  CleanupEvidence,
  DeprecatedCleanupFinding,
  DuplicateVersionCleanupFinding,
} from './types.js';

export interface BuildDeprecatedCleanupFindingOptions {
  findingId: string;
  packageName: string;
  message: string;
  directUsage: 'used' | 'not-found' | 'unknown';
  /** Present only when a separate unused-package finding justified removal. */
  relatedRemovalAction?: {
    id: string;
    confidence: 'low-risk' | 'review-required';
  };
  suggestedReplacement?: string;
}

export function buildDeprecatedCleanupFinding(
  options: BuildDeprecatedCleanupFindingOptions
): DeprecatedCleanupFinding {
  const evidence: CleanupEvidence[] = [{
    kind: 'deprecation',
    message: options.message,
    ...(options.suggestedReplacement === undefined
      ? {}
      : { suggestedReplacement: options.suggestedReplacement }),
  }];

  if (options.directUsage === 'unknown') {
    return {
      id: options.findingId,
      kind: 'deprecated',
      packageName: options.packageName,
      confidence: 'unknown',
      recommendation: 'unknown',
      summary: `${options.packageName} is deprecated, but its project usage is unknown`,
      evidence,
      relatedActionIds: [],
    };
  }

  if (options.directUsage === 'used') {
    return {
      id: options.findingId,
      kind: 'deprecated',
      packageName: options.packageName,
      confidence: 'review-required',
      recommendation: 'remediation-required',
      summary: `${options.packageName} is deprecated and still used by the project`,
      evidence,
      relatedActionIds: [],
    };
  }

  if (options.relatedRemovalAction !== undefined) {
    return {
      id: options.findingId,
      kind: 'deprecated',
      packageName: options.packageName,
      confidence: options.relatedRemovalAction.confidence,
      recommendation: 'remove-if-unused',
      summary: `${options.packageName} is deprecated and has a separately justified removal action`,
      evidence,
      relatedActionIds: [options.relatedRemovalAction.id],
    };
  }

  return {
    id: options.findingId,
    kind: 'deprecated',
    packageName: options.packageName,
    confidence: 'review-required',
    recommendation: 'informational',
    summary: `${options.packageName} is deprecated, but no automatic cleanup action is justified`,
    evidence,
    relatedActionIds: [],
  };
}

export interface BuildDuplicateCleanupFindingOptions {
  findingId: string;
  packageName: string;
  versions: readonly string[];
  /** A proven incompatibility can explain why both versions must stay. */
  keepBoth?: boolean;
}

export function buildDuplicateCleanupFinding(
  options: BuildDuplicateCleanupFindingOptions
): DuplicateVersionCleanupFinding {
  const versions = [...new Set(options.versions)].sort((left, right) => left.localeCompare(right));
  if (versions.length < 2) {
    throw new Error('A duplicate-version cleanup finding requires at least two distinct versions.');
  }
  const excessVersionCount = versions.length - 1;
  const keepBoth = options.keepBoth === true;
  return {
    id: options.findingId,
    kind: 'duplicate-version',
    packageName: options.packageName,
    confidence: keepBoth ? 'blocked' : 'review-required',
    recommendation: keepBoth ? 'keep-both' : 'analysis-only',
    executable: false,
    summary: keepBoth
      ? `${options.packageName} must remain at multiple versions under current constraints`
      : `${options.packageName} has ${versions.length} resolved versions; consolidation is analysis-only`,
    evidence: [{ kind: 'duplicate-versions', versions, excessVersionCount }],
    relatedActionIds: [],
  };
}
