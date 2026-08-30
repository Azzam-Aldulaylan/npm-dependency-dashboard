/**
 * Pure duplicate-version consolidation assessment.
 *
 * This module never resolves packages and never grants mutation authority.
 * It classifies host-supplied evidence from an isolated package-manager
 * simulation. A converged version is accepted only when the supplied
 * post-simulation dependency and peer ranges are complete and all admit the
 * exact simulated version. Anything incomplete or contradictory fails closed
 * to `unknown`.
 */

import semver from 'semver';

export type ConsolidationConstraintKind = 'dependency' | 'optional' | 'peer';

export interface ConsolidationConstraint {
  /** Package whose dependency or peer declaration imposes this range. */
  dependentPackage: string;
  /** Exact dependent version when the graph supplied one. */
  dependentVersion: string | null;
  /** Exact graph contexts, supplied by the host collector when available. */
  dependentNodeId?: string;
  targetNodeId?: string;
  kind: ConsolidationConstraintKind;
  range: string;
  optional?: boolean;
}

export interface ConsolidationParentUpgrade {
  packageName: string;
  fromVersion: string;
  toVersion: string;
}

export type ConsolidationSimulation =
  | {
      status: 'complete';
      /** Distinct versions in the package-manager-simulated graph. */
      resolvedVersions: readonly string[];
      /** Constraints observed in that simulated graph, not stale pre-simulation ranges. */
      constraints: readonly ConsolidationConstraint[];
      constraintsComplete: boolean;
      /** Empty means the simulation changed no direct parent dependency. */
      parentUpgrades: readonly ConsolidationParentUpgrade[];
    }
  | { status: 'unavailable'; reason: string };

export interface AssessDuplicateConsolidationOptions {
  packageName: string;
  /** Distinct versions in the current trusted graph. At least two are expected. */
  resolvedVersions: readonly string[];
  /** Current graph constraints, retained as evidence for keep-both decisions. */
  constraints: readonly ConsolidationConstraint[];
  constraintsComplete: boolean;
  simulation: ConsolidationSimulation | null;
}

export type DuplicateConsolidationAssessment =
  | {
      outcome: 'safe-convergence';
      packageName: string;
      currentVersions: readonly string[];
      targetVersion: string;
      parentUpgrades: readonly [];
      reason: string;
    }
  | {
      outcome: 'requires-parent-upgrade';
      packageName: string;
      currentVersions: readonly string[];
      targetVersion: string;
      parentUpgrades: readonly ConsolidationParentUpgrade[];
      reason: string;
    }
  | {
      outcome: 'keep-both';
      packageName: string;
      currentVersions: readonly string[];
      retainedVersions: readonly string[];
      parentUpgrades: readonly [];
      reason: string;
    }
  | {
      outcome: 'unknown';
      packageName: string;
      currentVersions: readonly string[];
      reason: string;
    };

function stableVersions(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.every((version) => semver.valid(version) !== null)) {
    return unique.sort((left, right) => semver.compare(left, right));
  }
  return unique.sort((left, right) => left.localeCompare(right));
}

function stableConstraints(values: readonly ConsolidationConstraint[]): ConsolidationConstraint[] {
  return [...values].sort((left, right) =>
    (left.dependentNodeId ?? '').localeCompare(right.dependentNodeId ?? '') ||
    (left.targetNodeId ?? '').localeCompare(right.targetNodeId ?? '') ||
    left.dependentPackage.localeCompare(right.dependentPackage) ||
    (left.dependentVersion ?? '').localeCompare(right.dependentVersion ?? '') ||
    left.kind.localeCompare(right.kind) ||
    left.range.localeCompare(right.range)
  );
}

function stableParentUpgrades(values: readonly ConsolidationParentUpgrade[]): ConsolidationParentUpgrade[] {
  const unique = new Map<string, ConsolidationParentUpgrade>();
  for (const value of values) {
    unique.set(`${value.packageName}\0${value.fromVersion}\0${value.toVersion}`, value);
  }
  return [...unique.values()].sort((left, right) =>
    left.packageName.localeCompare(right.packageName) ||
    left.fromVersion.localeCompare(right.fromVersion) ||
    left.toVersion.localeCompare(right.toVersion)
  );
}

function invalidVersion(values: readonly string[]): string | undefined {
  return values.find((version) => semver.valid(version) === null);
}

function invalidConstraint(values: readonly ConsolidationConstraint[]): ConsolidationConstraint | undefined {
  return values.find((constraint) =>
    constraint.dependentPackage.trim() === '' ||
    constraint.range.trim() === '' ||
    semver.validRange(constraint.range) === null ||
    (constraint.dependentVersion !== null && semver.valid(constraint.dependentVersion) === null)
  );
}

function invalidParentUpgrade(values: readonly ConsolidationParentUpgrade[]): ConsolidationParentUpgrade | undefined {
  return values.find((upgrade) =>
    upgrade.packageName.trim() === '' ||
    semver.valid(upgrade.fromVersion) === null ||
    semver.valid(upgrade.toVersion) === null ||
    semver.eq(upgrade.fromVersion, upgrade.toVersion)
  );
}

function allConstraintsAdmit(
  version: string,
  constraints: readonly ConsolidationConstraint[]
): boolean {
  return constraints.every((constraint) =>
    semver.satisfies(version, constraint.range, { includePrerelease: true })
  );
}

function hasContradictoryParentUpgrades(values: readonly ConsolidationParentUpgrade[]): boolean {
  const changes = new Map<string, { fromVersion: string; toVersion: string }>();
  for (const upgrade of values) {
    const existing = changes.get(upgrade.packageName);
    if (
      existing !== undefined &&
      (existing.fromVersion !== upgrade.fromVersion || existing.toVersion !== upgrade.toVersion)
    ) return true;
    changes.set(upgrade.packageName, upgrade);
  }
  return false;
}

function unknown(
  packageName: string,
  currentVersions: readonly string[],
  reason: string
): DuplicateConsolidationAssessment {
  return { outcome: 'unknown', packageName, currentVersions, reason };
}

/**
 * Classifies one duplicate group from already-computed evidence. A complete
 * simulation is an input fact; this function does not invoke a resolver or
 * infer an outcome from version ordering.
 */
export function assessDuplicateConsolidation(
  options: AssessDuplicateConsolidationOptions
): DuplicateConsolidationAssessment {
  const currentVersions = stableVersions(options.resolvedVersions);
  if (options.packageName.trim() === '') {
    return unknown(options.packageName, currentVersions, 'The duplicate package name is missing.');
  }
  const badCurrentVersion = invalidVersion(currentVersions);
  if (badCurrentVersion !== undefined) {
    return unknown(options.packageName, currentVersions, `Current version ${badCurrentVersion} is not valid semver.`);
  }
  if (currentVersions.length < 2) {
    return unknown(options.packageName, currentVersions, 'At least two distinct current versions are required.');
  }
  if (!options.constraintsComplete) {
    return unknown(options.packageName, currentVersions, 'Current dependent ranges are incomplete.');
  }
  const currentConstraints = stableConstraints(options.constraints);
  const badCurrentConstraint = invalidConstraint(currentConstraints);
  if (badCurrentConstraint !== undefined) {
    return unknown(
      options.packageName,
      currentVersions,
      `The ${badCurrentConstraint.kind} range from ${badCurrentConstraint.dependentPackage || 'an unknown dependent'} is invalid.`
    );
  }
  if (currentConstraints.length === 0) {
    return unknown(options.packageName, currentVersions, 'No dependent ranges were supplied for this duplicate group.');
  }

  const simulation = options.simulation;
  if (simulation === null) {
    return unknown(options.packageName, currentVersions, 'A package-manager simulation has not been supplied.');
  }
  if (simulation.status === 'unavailable') {
    return unknown(
      options.packageName,
      currentVersions,
      simulation.reason.trim() || 'The package-manager simulation was unavailable.'
    );
  }
  if (!simulation.constraintsComplete) {
    return unknown(options.packageName, currentVersions, 'Simulated dependent ranges are incomplete.');
  }

  const simulatedVersions = stableVersions(simulation.resolvedVersions);
  const badSimulatedVersion = invalidVersion(simulatedVersions);
  if (badSimulatedVersion !== undefined || simulatedVersions.length === 0) {
    return unknown(
      options.packageName,
      currentVersions,
      badSimulatedVersion === undefined
        ? 'The simulation returned no resolved version.'
        : `Simulated version ${badSimulatedVersion} is not valid semver.`
    );
  }
  const simulatedConstraints = stableConstraints(simulation.constraints);
  const badSimulatedConstraint = invalidConstraint(simulatedConstraints);
  if (badSimulatedConstraint !== undefined || simulatedConstraints.length === 0) {
    return unknown(
      options.packageName,
      currentVersions,
      badSimulatedConstraint === undefined
        ? 'The simulation returned no dependent ranges.'
        : `The simulated ${badSimulatedConstraint.kind} range from ${badSimulatedConstraint.dependentPackage || 'an unknown dependent'} is invalid.`
    );
  }

  const parentUpgrades = stableParentUpgrades(simulation.parentUpgrades);
  const badParentUpgrade = invalidParentUpgrade(parentUpgrades);
  if (badParentUpgrade !== undefined || hasContradictoryParentUpgrades(parentUpgrades)) {
    return unknown(options.packageName, currentVersions, 'The simulated parent-upgrade set is invalid or contradictory.');
  }

  if (simulatedVersions.length === 1) {
    const targetVersion = simulatedVersions[0];
    if (targetVersion === undefined || !allConstraintsAdmit(targetVersion, simulatedConstraints)) {
      return unknown(
        options.packageName,
        currentVersions,
        'The simulated convergence version does not satisfy every supplied dependency and peer range.'
      );
    }
    if (parentUpgrades.length === 0) {
      return {
        outcome: 'safe-convergence',
        packageName: options.packageName,
        currentVersions,
        targetVersion,
        parentUpgrades: [],
        reason: `The complete simulation converged on ${targetVersion} without changing a direct parent dependency.`,
      };
    }
    return {
      outcome: 'requires-parent-upgrade',
      packageName: options.packageName,
      currentVersions,
      targetVersion,
      parentUpgrades,
      reason: `The complete simulation converged on ${targetVersion} only with ${parentUpgrades.length} direct parent ${parentUpgrades.length === 1 ? 'upgrade' : 'upgrades'}.`,
    };
  }

  if (parentUpgrades.length > 0) {
    return unknown(options.packageName, currentVersions, 'The simulated parent upgrades did not converge the duplicate group to one version.');
  }
  if (simulatedVersions.some((version) => allConstraintsAdmit(version, simulatedConstraints))) {
    return unknown(options.packageName, currentVersions, 'A supplied version satisfies every range, but the simulation retained multiple versions.');
  }
  return {
    outcome: 'keep-both',
    packageName: options.packageName,
    currentVersions,
    retainedVersions: simulatedVersions,
    parentUpgrades: [],
    reason: 'The complete simulation retained multiple versions because no retained version satisfies every supplied dependency and peer range.',
  };
}
