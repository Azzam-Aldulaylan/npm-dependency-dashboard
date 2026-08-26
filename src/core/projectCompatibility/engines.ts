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
  let incomplete = false;
  const runtime = input.evidence.runtimeNodeVersion;
  if (runtime === null) {
    incomplete = true;
  } else if (semver.valid(runtime) === null) {
    incomplete = true;
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
    incomplete = true;
  } else if (semver.validRange(projectRange) === null) {
    incomplete = true;
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
  }

  return {
    analyzerId: 'runtime-compatibility',
    status: incomplete ? 'partial' : 'complete',
    findings,
    ...(incomplete ? { unavailableReason: 'project-runtime-information-incomplete' } : {}),
  };
}
