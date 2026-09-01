import semver from 'semver';

import { createProjectCompatibilityFinding } from './findings.js';
import type {
  ProjectCompatibilityAnalyzerResult,
  ProjectCompatibilityFinding,
  ProjectCompatibilityIdentity,
} from './types.js';

export interface RuntimeCompatibilityEvidence {
  packageName: string;
  targetVersion: string;
  /** Null means the target package does not declare a Node requirement. */
  targetNodeRange: string | null;
  /** Null means the project does not declare package.json#engines.node. */
  projectNodeRange: string | null;
  /**
   * Exact project runtime version, or null when it is not safely known. The
   * VS Code extension-host process version is not project runtime evidence.
   */
  runtimeNodeVersion: string | null;
}

/**
 * `subset` alone cannot prove coverage across multiple target OR branches
 * (for example >=20.9 against >=20.9 <22 || >=22). Before warning, require an
 * actual version allowed by the project but not the target. With prereleases
 * included, comparator boundaries and their successors cover every interval
 * where range membership can change. These are range witnesses, not evidence
 * of the user's installed runtime.
 */
function projectRangeAllowsUnsupportedVersions(project: string, target: string): boolean {
  const options = { includePrerelease: true };
  if (semver.subset(project, target, options)) return false;
  const projectRange = new semver.Range(project, options);
  const targetRange = new semver.Range(target, options);
  const candidates = new Set(['0.0.0-0', '0.0.0']);
  for (const range of [projectRange, targetRange]) {
    for (const comparators of range.set) {
      for (const comparator of comparators) {
        if (comparator.value === '') continue;
        const version = comparator.semver;
        candidates.add(version.version);
        if (version.prerelease.length > 0) {
          candidates.add(`${version.version}.0`);
          candidates.add(`${version.major}.${version.minor}.${version.patch}`);
        } else if (version.patch < Number.MAX_SAFE_INTEGER) {
          candidates.add(`${version.major}.${version.minor}.${version.patch + 1}-0`);
        } else if (version.minor < Number.MAX_SAFE_INTEGER) {
          candidates.add(`${version.major}.${version.minor + 1}.0-0`);
        } else if (version.major < Number.MAX_SAFE_INTEGER) {
          candidates.add(`${version.major + 1}.0.0-0`);
        }
      }
    }
  }
  return [...candidates].some((version) =>
    semver.valid(version) !== null && projectRange.test(version) && !targetRange.test(version)
  );
}

export function analyzeRuntimeCompatibility(input: {
  identity: ProjectCompatibilityIdentity;
  evidence: RuntimeCompatibilityEvidence;
}): ProjectCompatibilityAnalyzerResult {
  if (
    input.evidence.packageName !== input.identity.packageName ||
    input.evidence.targetVersion !== input.identity.targetVersion
  ) {
    return {
      analyzerId: 'runtime-compatibility',
      status: 'unavailable',
      findings: [],
      unavailableReason: 'target-metadata-identity-mismatch',
    };
  }

  const targetRange = input.evidence.targetNodeRange;
  if (targetRange === null) {
    return { analyzerId: 'runtime-compatibility', status: 'complete', findings: [] };
  }
  if (semver.validRange(targetRange) === null) {
    return {
      analyzerId: 'runtime-compatibility',
      status: 'unavailable',
      findings: [],
      unavailableReason: 'invalid-target-node-engine',
    };
  }

  const findings: ProjectCompatibilityFinding[] = [];
  const limitations: string[] = [];
  const runtime = input.evidence.runtimeNodeVersion;
  if (runtime === null) {
    limitations.push('runtime-node-version-unknown');
  } else if (semver.valid(runtime) === null) {
    limitations.push('runtime-node-version-invalid');
  } else if (!semver.satisfies(runtime, targetRange, { includePrerelease: true })) {
    findings.push(
      createProjectCompatibilityFinding(input.identity, {
        ruleId: 'runtime-node-version-incompatible',
        category: 'runtime',
        confidence: 'confirmed',
        title: 'Runtime incompatibility',
        explanation: `${input.identity.packageName} ${input.identity.targetVersion} requires Node ${targetRange}, but the current runtime is ${runtime}.`,
        migrationHint: `Use a Node version that satisfies ${targetRange} before upgrading.`,
        evidence: [
          { kind: 'target-metadata', context: `engines.node: ${targetRange}` },
          { kind: 'runtime-version', context: runtime },
        ],
        discriminator: ['runtime', runtime, targetRange],
      })
    );
  }

  const projectRange = input.evidence.projectNodeRange;
  if (projectRange === null) {
    limitations.push('project-node-range-missing');
  } else if (semver.validRange(projectRange) === null) {
    limitations.push('project-node-range-invalid');
  } else if (!semver.intersects(projectRange, targetRange, { includePrerelease: true })) {
    findings.push(
      createProjectCompatibilityFinding(input.identity, {
        ruleId: 'project-node-engine-incompatible',
        category: 'runtime',
        confidence: 'confirmed',
        title: 'Project runtime requirement is incompatible',
        explanation: `${input.identity.packageName} ${input.identity.targetVersion} requires Node ${targetRange}, but the project declares ${projectRange}.`,
        migrationHint: `Update package.json engines.node to a range compatible with ${targetRange}.`,
        evidence: [
          { kind: 'target-metadata', context: `engines.node: ${targetRange}` },
          { kind: 'project-engine', filePath: 'package.json', context: `engines.node: ${projectRange}` },
        ],
        discriminator: ['project-engine', projectRange, targetRange],
      })
    );
  } else if (projectRangeAllowsUnsupportedVersions(projectRange, targetRange)) {
    findings.push(
      createProjectCompatibilityFinding(input.identity, {
        ruleId: 'project-node-engine-partially-compatible',
        category: 'runtime',
        confidence: 'review',
        title: 'Some declared Node versions need review',
        explanation: `${input.identity.packageName} ${input.identity.targetVersion} requires Node ${targetRange}. The project's declared range ${projectRange} overlaps that requirement but also allows versions outside it.`,
        migrationHint: `Check the Node versions used in development, CI, and deployment, then narrow package.json engines.node to supported versions within ${targetRange}.`,
        evidence: [
          { kind: 'target-metadata', context: `engines.node: ${targetRange}` },
          { kind: 'project-engine', filePath: 'package.json', context: `engines.node: ${projectRange}` },
        ],
        discriminator: ['project-engine-partial', projectRange, targetRange],
      })
    );
  }

  return {
    analyzerId: 'runtime-compatibility',
    status: limitations.length > 0 ? 'partial' : 'complete',
    findings,
    ...(limitations.length > 0 ? { unavailableReason: limitations.join('|') } : {}),
  };
}
