import semver from 'semver';

import { createProjectCompatibilityFinding } from './findings.js';
import type {
  ProjectCompatibilityAnalyzerResult,
  ProjectCompatibilityFinding,
  ProjectCompatibilityIdentity,
} from './types.js';

/** Host-supplied current project package and its registry peer metadata. */
export interface ToolingPackageEvidence {
  name: string;
  resolvedVersion: string | null;
  declaredRange: string | null;
  peerDependencies: Readonly<Record<string, string>>;
  optionalPeers?: readonly string[];
}
function observedPackage(
  packages: readonly ToolingPackageEvidence[],
  name: string
): ToolingPackageEvidence | undefined {
  return packages.find((candidate) => candidate.name === name);
}

export function analyzeToolingPeerAlignment(input: {
  identity: ProjectCompatibilityIdentity;
  packages: readonly ToolingPackageEvidence[];
}): ProjectCompatibilityAnalyzerResult {
  const findings: ProjectCompatibilityFinding[] = [];
  let incomplete = false;
  const owners = [...input.packages].sort((left, right) => left.name.localeCompare(right.name));

  for (const owner of owners) {
    for (const [peerName, requiredRange] of Object.entries(owner.peerDependencies).sort(([a], [b]) => a.localeCompare(b))) {
      if (semver.validRange(requiredRange) === null) {
        incomplete = true;
        continue;
      }
      const observed = observedPackage(input.packages, peerName);
      if (observed === undefined) {
        if (!(owner.optionalPeers ?? []).includes(peerName)) incomplete = true;
        continue;
      }

      const observedVersion = observed.resolvedVersion;
      if (observedVersion !== null && semver.valid(observedVersion) !== null) {
        if (semver.satisfies(observedVersion, requiredRange, { includePrerelease: true })) continue;
        findings.push(
          createProjectCompatibilityFinding(input.identity, {
            ruleId: 'tooling-peer-version-incompatible',
            category: 'tooling',
            confidence: 'confirmed',
            title: 'Tooling peer incompatibility',
            explanation: `${owner.name}@${owner.resolvedVersion ?? 'unknown'} requires ${peerName}@${requiredRange}, but the project resolves ${observedVersion}.`,
            migrationHint: `Choose compatible versions of ${owner.name} and ${peerName}.`,
            evidence: [
              { kind: 'target-metadata', context: `${owner.name} peer ${peerName}@${requiredRange}` },
              { kind: 'manifest-dependency', filePath: 'package.json', context: `${peerName}@${observed.declaredRange ?? observedVersion}` },
            ],
            discriminator: [owner.name, peerName, requiredRange, observedVersion],
          })
        );
        continue;
      }

      const declaredRange = observed.declaredRange;
      if (declaredRange === null || semver.validRange(declaredRange) === null) {
        incomplete = true;
        continue;
      }
      if (!semver.intersects(declaredRange, requiredRange, { includePrerelease: true })) {
        findings.push(
          createProjectCompatibilityFinding(input.identity, {
            ruleId: 'tooling-peer-range-incompatible',
            category: 'tooling',
            confidence: 'confirmed',
            title: 'Tooling peer incompatibility',
            explanation: `${owner.name}@${owner.resolvedVersion ?? 'unknown'} requires ${peerName}@${requiredRange}, but the project declares ${declaredRange}.`,
            migrationHint: `Use a ${peerName} declaration that intersects ${requiredRange}.`,
            evidence: [
              { kind: 'target-metadata', context: `${owner.name} peer ${peerName}@${requiredRange}` },
              { kind: 'manifest-dependency', filePath: 'package.json', context: `${peerName}@${declaredRange}` },
            ],
            discriminator: [owner.name, peerName, requiredRange, declaredRange],
          })
        );
      }
    }
  }

  return {
    analyzerId: 'tooling-peer-alignment',
    status: incomplete ? 'partial' : 'complete',
    findings,
    ...(incomplete ? { unavailableReason: 'tooling-metadata-incomplete' } : {}),
  };
}
