/**
 * Host-independent planning for a targeted transitive vulnerability fix.
 *
 * The resolver is responsible for materializing the candidate graph. This
 * module only compares trusted before/after facts and decides whether that
 * candidate is safe enough to offer. Its result contains JSON-compatible
 * values only: no Maps, graph nodes, absolute project paths, or generated
 * lockfile contents cross the host/webview boundary.
 */

import semver from 'semver';

import { buildInstallPathIndex, pathsToNodes } from '../graph/paths.js';
import type {
  Advisory,
  AttributedAdvisory,
  DependencyGraph,
  DependencyNode,
  Severity,
} from '../types.js';
import type { AdvisoriesByName } from './attribution.js';
import { vulnerabilityIdentifiers } from './identifiers.js';

export interface RemediationGraphSnapshot {
  graph: DependencyGraph;
  advisoriesByName: AdvisoriesByName;
  advisories: 'complete' | 'unavailable';
}

export interface PackageInstanceChange {
  kind: 'added' | 'removed' | 'updated';
  packageName: string;
  /** Package-manager lockfile node id; always relative, never an absolute filesystem path. */
  lockfilePath: string;
  beforeVersion: string | null;
  afterVersion: string | null;
  direct: boolean;
}

export interface DirectDependencyDrift {
  packageName: string;
  beforeVersions: Array<string | null>;
  afterVersions: Array<string | null>;
}

export interface VulnerablePackageInstance {
  lockfilePath: string;
  version: string;
  /** Dependency-name paths, not filesystem paths. */
  dependencyPaths: string[][];
  pathsTruncated: boolean;
}

export interface RemediationAdvisoryEvidence {
  identity: string;
  aliases: string[];
  flaggedPackage: string;
  severity: Severity;
  title: string;
  beforeInstances: VulnerablePackageInstance[];
  afterInstances: VulnerablePackageInstance[];
}

export interface WorsenedAdvisoryEvidence extends RemediationAdvisoryEvidence {
  reasons: Array<'severity-increased' | 'more-vulnerable-instances'>;
}

export type TransitiveRemediationClassification = 'full' | 'partial' | 'no-fix' | 'unsafe';

export type TransitiveRemediationReason =
  | 'MANIFEST_CHANGED'
  | 'PACKAGE_MANAGER_CHANGED'
  | 'ROOT_NOT_DIRECT_DEPENDENCY'
  | 'DIRECT_DEPENDENCY_CHANGED'
  | 'SECURITY_EVIDENCE_UNAVAILABLE'
  | 'INVALID_ADVISORY_RANGE'
  | 'TARGET_ADVISORY_NOT_FOUND'
  | 'NEW_ADVISORY_INTRODUCED'
  | 'ADVISORY_WORSENED'
  | 'NO_TARGET_ADVISORY_RESOLVED'
  | 'TARGET_ADVISORIES_REMAIN';

export interface TransitiveRemediationPlan {
  classification: TransitiveRemediationClassification;
  /** True only for a fully or partially effective candidate that passes every safety invariant. */
  automaticApplyAllowed: boolean;
  rootPackageName: string;
  rootVersion: string | null;
  reasons: TransitiveRemediationReason[];
  manifestUnchanged: boolean;
  packageManagerUnchanged: boolean;
  directDependencyChanges: DirectDependencyDrift[];
  packageChanges: PackageInstanceChange[];
  security: {
    resolved: RemediationAdvisoryEvidence[];
    remaining: RemediationAdvisoryEvidence[];
    introduced: RemediationAdvisoryEvidence[];
    worsened: WorsenedAdvisoryEvidence[];
  };
  target: {
    requestedCount: number;
    resolved: RemediationAdvisoryEvidence[];
    remaining: RemediationAdvisoryEvidence[];
  };
}

export interface CreateTransitiveRemediationPlanOptions {
  rootPackageName: string;
  /** Host-authoritative advisories selected for remediation, never webview-supplied claims. */
  targetAdvisories: readonly AttributedAdvisory[];
  before: RemediationGraphSnapshot;
  after: RemediationGraphSnapshot;
  /** Byte-level manifest comparison performed by the host. */
  manifestUnchanged: boolean;
}

interface RawOccurrence {
  state: 'before' | 'after';
  advisory: Advisory;
  aliases: string[];
  flaggedPackage: string;
  instance: VulnerablePackageInstance;
}

interface CollectedOccurrences {
  occurrences: RawOccurrence[];
  invalidAdvisoryRange: boolean;
}

interface GroupState {
  advisories: Advisory[];
  aliases: Set<string>;
  instances: Map<string, VulnerablePackageInstance>;
}

interface IdentityGroup {
  identity: string;
  aliases: Set<string>;
  flaggedPackage: string;
  before?: GroupState;
  after?: GroupState;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  info: 0,
};

const MAX_PATHS_PER_INSTANCE = 20;
const MAX_EXPLORED_PATHS = 500;

function normalizeIdentifier(value: string): string {
  return value.trim().toUpperCase();
}

function aliasesFor(advisory: Advisory): string[] {
  return [...new Set([
    ...vulnerabilityIdentifiers(advisory).map(normalizeIdentifier),
    `NPM:${String(advisory.id).toUpperCase()}`,
  ])].sort();
}

function preferredIdentity(aliases: readonly string[]): string {
  return (
    aliases.find((alias) => alias.startsWith('CVE-')) ??
    aliases.find((alias) => alias.startsWith('GHSA-')) ??
    aliases.find((alias) => alias.startsWith('NPM:')) ??
    aliases[0] ??
    'UNKNOWN'
  );
}

/** Stable public-first identity used by plan consumers and host protocol summaries. */
export function transitiveRemediationAdvisoryIdentity(advisory: Advisory): string {
  return preferredIdentity(aliasesFor(advisory));
}

class AliasSets {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) {
      this.parent.set(value, value);
      return value;
    }
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    this.add(left);
    this.add(right);
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot.localeCompare(rightRoot) <= 0) this.parent.set(rightRoot, leftRoot);
    else this.parent.set(leftRoot, rightRoot);
  }
}

function collectOccurrences(snapshot: RemediationGraphSnapshot, state: RawOccurrence['state']): CollectedOccurrences {
  const index = buildInstallPathIndex(snapshot.graph);
  const occurrences: RawOccurrence[] = [];
  let invalidAdvisoryRange = false;

  for (const node of snapshot.graph.nodes.values()) {
    if (node.version === null || !index.distance.has(node.path)) continue;
    for (const advisory of snapshot.advisoriesByName.get(node.name) ?? []) {
      if (semver.validRange(advisory.vulnerableVersions) === null) {
        invalidAdvisoryRange = true;
        continue;
      }
      if (!semver.satisfies(node.version, advisory.vulnerableVersions, { includePrerelease: true })) continue;
      const paths = pathsToNodes(snapshot.graph, index, new Set([node.path]), {
        maxPaths: MAX_PATHS_PER_INSTANCE,
        maxExplored: MAX_EXPLORED_PATHS,
      });
      occurrences.push({
        state,
        advisory,
        aliases: aliasesFor(advisory),
        flaggedPackage: node.name,
        instance: {
          lockfilePath: node.path,
          version: node.version,
          dependencyPaths: paths.paths,
          pathsTruncated: paths.truncated,
        },
      });
    }
  }
  return { occurrences, invalidAdvisoryRange };
}

function emptyGroupState(): GroupState {
  return { advisories: [], aliases: new Set(), instances: new Map() };
}

function addOccurrence(state: GroupState, occurrence: RawOccurrence): void {
  state.advisories.push(occurrence.advisory);
  for (const alias of occurrence.aliases) state.aliases.add(alias);
  state.instances.set(occurrence.instance.lockfilePath, occurrence.instance);
}

function groupOccurrences(occurrences: readonly RawOccurrence[]): IdentityGroup[] {
  const aliasesByPackage = new Map<string, AliasSets>();
  for (const occurrence of occurrences) {
    const sets = aliasesByPackage.get(occurrence.flaggedPackage) ?? new AliasSets();
    aliasesByPackage.set(occurrence.flaggedPackage, sets);
    const [first, ...rest] = occurrence.aliases;
    if (first === undefined) continue;
    sets.add(first);
    for (const alias of rest) sets.union(first, alias);
  }

  const componentAliases = new Map<string, Set<string>>();
  for (const occurrence of occurrences) {
    const sets = aliasesByPackage.get(occurrence.flaggedPackage);
    const first = occurrence.aliases[0];
    if (sets === undefined || first === undefined) continue;
    const component = `${occurrence.flaggedPackage}\u0000${sets.find(first)}`;
    const aliases = componentAliases.get(component) ?? new Set<string>();
    for (const alias of occurrence.aliases) aliases.add(alias);
    componentAliases.set(component, aliases);
  }

  const groups = new Map<string, IdentityGroup>();
  for (const occurrence of occurrences) {
    const sets = aliasesByPackage.get(occurrence.flaggedPackage);
    const first = occurrence.aliases[0];
    if (sets === undefined || first === undefined) continue;
    const component = `${occurrence.flaggedPackage}\u0000${sets.find(first)}`;
    const aliases = componentAliases.get(component) ?? new Set(occurrence.aliases);
    const identity = preferredIdentity([...aliases].sort());
    const key = `${occurrence.flaggedPackage}\u0000${identity}`;
    const group = groups.get(key) ?? { identity, aliases, flaggedPackage: occurrence.flaggedPackage };
    const groupState = group[occurrence.state] ?? emptyGroupState();
    addOccurrence(groupState, occurrence);
    group[occurrence.state] = groupState;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function highestSeverity(state: GroupState | undefined): Severity {
  const advisories = state?.advisories ?? [];
  return advisories.reduce<Severity>(
    (highest, advisory) => SEVERITY_RANK[advisory.severity] > SEVERITY_RANK[highest] ? advisory.severity : highest,
    'info'
  );
}

function evidenceFor(group: IdentityGroup): RemediationAdvisoryEvidence {
  const representative = [...(group.after?.advisories ?? []), ...(group.before?.advisories ?? [])]
    .sort((left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      left.title.localeCompare(right.title)
    )[0];
  if (representative === undefined) throw new Error('Advisory identity group has no evidence.');
  const sortedInstances = (state: GroupState | undefined): VulnerablePackageInstance[] =>
    [...(state?.instances.values() ?? [])].sort((left, right) => left.lockfilePath.localeCompare(right.lockfilePath));
  return {
    identity: group.identity,
    aliases: [...group.aliases].sort(),
    flaggedPackage: group.flaggedPackage,
    severity: representative.severity,
    title: representative.title,
    beforeInstances: sortedInstances(group.before),
    afterInstances: sortedInstances(group.after),
  };
}

function advisorySort(left: RemediationAdvisoryEvidence, right: RemediationAdvisoryEvidence): number {
  return (
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
    left.flaggedPackage.localeCompare(right.flaggedPackage) ||
    left.identity.localeCompare(right.identity)
  );
}

function directVersionMap(graph: DependencyGraph): Map<string, Array<string | null>> {
  const result = new Map<string, Array<string | null>>();
  for (const node of graph.nodes.values()) {
    if (!node.direct) continue;
    const versions = result.get(node.name) ?? [];
    versions.push(node.version);
    result.set(node.name, versions);
  }
  for (const versions of result.values()) versions.sort((a, b) => String(a).localeCompare(String(b)));
  return result;
}

function compareDirectDependencies(before: DependencyGraph, after: DependencyGraph): DirectDependencyDrift[] {
  const beforeMap = directVersionMap(before);
  const afterMap = directVersionMap(after);
  const names = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return names.flatMap((packageName) => {
    const beforeVersions = beforeMap.get(packageName) ?? [];
    const afterVersions = afterMap.get(packageName) ?? [];
    return JSON.stringify(beforeVersions) === JSON.stringify(afterVersions)
      ? []
      : [{ packageName, beforeVersions, afterVersions }];
  });
}

function packageInstance(node: DependencyNode): Pick<PackageInstanceChange, 'packageName' | 'lockfilePath' | 'direct'> {
  return { packageName: node.name, lockfilePath: node.path, direct: node.direct };
}

function comparePackageInstances(before: DependencyGraph, after: DependencyGraph): PackageInstanceChange[] {
  const changes: PackageInstanceChange[] = [];
  const paths = [...new Set([...before.nodes.keys(), ...after.nodes.keys()])].sort();
  for (const path of paths) {
    const beforeNode = before.nodes.get(path);
    const afterNode = after.nodes.get(path);
    if (beforeNode !== undefined && afterNode !== undefined && beforeNode.name === afterNode.name) {
      if (beforeNode.version !== afterNode.version) {
        changes.push({
          kind: 'updated',
          ...packageInstance(afterNode),
          beforeVersion: beforeNode.version,
          afterVersion: afterNode.version,
        });
      }
      continue;
    }
    if (beforeNode !== undefined) {
      changes.push({
        kind: 'removed',
        ...packageInstance(beforeNode),
        beforeVersion: beforeNode.version,
        afterVersion: null,
      });
    }
    if (afterNode !== undefined) {
      changes.push({
        kind: 'added',
        ...packageInstance(afterNode),
        beforeVersion: null,
        afterVersion: afterNode.version,
      });
    }
  }
  return changes;
}

function targetMatches(group: IdentityGroup, targets: readonly AttributedAdvisory[]): boolean {
  if (group.before === undefined) return false;
  return targets.some((target) => {
    if (target.flaggedPackage !== group.flaggedPackage) return false;
    const targetAliases = aliasesFor(target.advisory);
    return targetAliases.some((alias) => group.aliases.has(alias));
  });
}

function distinctTargets(targets: readonly AttributedAdvisory[]): AttributedAdvisory[] {
  const aliasesByPackage = new Map<string, AliasSets>();
  for (const target of targets) {
    const sets = aliasesByPackage.get(target.flaggedPackage) ?? new AliasSets();
    aliasesByPackage.set(target.flaggedPackage, sets);
    const [first, ...rest] = aliasesFor(target.advisory);
    if (first === undefined) continue;
    sets.add(first);
    for (const alias of rest) sets.union(first, alias);
  }
  const distinct = new Map<string, AttributedAdvisory>();
  for (const target of targets) {
    const aliases = aliasesFor(target.advisory);
    const first = aliases[0];
    const sets = aliasesByPackage.get(target.flaggedPackage);
    if (first === undefined || sets === undefined) continue;
    const key = `${target.flaggedPackage}\u0000${sets.find(first)}`;
    if (!distinct.has(key)) distinct.set(key, target);
  }
  return [...distinct.values()];
}

function uniqueReasons(reasons: readonly TransitiveRemediationReason[]): TransitiveRemediationReason[] {
  return [...new Set(reasons)];
}

/**
 * Classify an isolated resolver candidate. `partial` is still apply-eligible:
 * it fixes at least one requested advisory, introduces/worsens none, and
 * changes neither the manifest nor any direct dependency's resolved version.
 */
export function createTransitiveRemediationPlan(
  options: CreateTransitiveRemediationPlanOptions
): TransitiveRemediationPlan {
  const requestedTargets = distinctTargets(options.targetAdvisories);
  const packageManagerUnchanged = options.before.graph.packageManager === options.after.graph.packageManager;
  const directDependencyChanges = compareDirectDependencies(options.before.graph, options.after.graph);
  const packageChanges = comparePackageInstances(options.before.graph, options.after.graph);
  const beforeRoot = [...options.before.graph.nodes.values()].find(
    (node) => node.direct && node.name === options.rootPackageName
  );
  const afterRoot = [...options.after.graph.nodes.values()].find(
    (node) => node.direct && node.name === options.rootPackageName
  );

  const reasons: TransitiveRemediationReason[] = [];
  if (!options.manifestUnchanged) reasons.push('MANIFEST_CHANGED');
  if (!packageManagerUnchanged) reasons.push('PACKAGE_MANAGER_CHANGED');
  if (beforeRoot === undefined || afterRoot === undefined) reasons.push('ROOT_NOT_DIRECT_DEPENDENCY');
  if (directDependencyChanges.length > 0) reasons.push('DIRECT_DEPENDENCY_CHANGED');

  const security = {
    resolved: [] as RemediationAdvisoryEvidence[],
    remaining: [] as RemediationAdvisoryEvidence[],
    introduced: [] as RemediationAdvisoryEvidence[],
    worsened: [] as WorsenedAdvisoryEvidence[],
  };
  const target = {
    requestedCount: requestedTargets.length,
    resolved: [] as RemediationAdvisoryEvidence[],
    remaining: [] as RemediationAdvisoryEvidence[],
  };

  if (options.before.advisories !== 'complete' || options.after.advisories !== 'complete') {
    reasons.push('SECURITY_EVIDENCE_UNAVAILABLE');
  } else {
    const beforeOccurrences = collectOccurrences(options.before, 'before');
    const afterOccurrences = collectOccurrences(options.after, 'after');
    if (beforeOccurrences.invalidAdvisoryRange || afterOccurrences.invalidAdvisoryRange) {
      reasons.push('INVALID_ADVISORY_RANGE');
    } else {
      const groups = groupOccurrences([...beforeOccurrences.occurrences, ...afterOccurrences.occurrences]);
      const targetedGroups = groups.filter((group) => targetMatches(group, requestedTargets));
      if (targetedGroups.length !== requestedTargets.length) reasons.push('TARGET_ADVISORY_NOT_FOUND');

      for (const group of groups) {
        const evidence = evidenceFor(group);
        if (group.before !== undefined && group.after === undefined) security.resolved.push(evidence);
        else if (group.before === undefined && group.after !== undefined) security.introduced.push(evidence);
        else if (group.before !== undefined && group.after !== undefined) {
          security.remaining.push(evidence);
          const worsenedReasons: WorsenedAdvisoryEvidence['reasons'] = [];
          if (SEVERITY_RANK[highestSeverity(group.after)] > SEVERITY_RANK[highestSeverity(group.before)]) {
            worsenedReasons.push('severity-increased');
          }
          if (group.after.instances.size > group.before.instances.size) {
            worsenedReasons.push('more-vulnerable-instances');
          }
          if (worsenedReasons.length > 0) security.worsened.push({ ...evidence, reasons: worsenedReasons });
        }

        if (targetMatches(group, requestedTargets)) {
          if (group.after === undefined) target.resolved.push(evidence);
          else target.remaining.push(evidence);
        }
      }
    }
  }

  security.resolved.sort(advisorySort);
  security.remaining.sort(advisorySort);
  security.introduced.sort(advisorySort);
  security.worsened.sort(advisorySort);
  target.resolved.sort(advisorySort);
  target.remaining.sort(advisorySort);

  if (security.introduced.length > 0) reasons.push('NEW_ADVISORY_INTRODUCED');
  if (security.worsened.length > 0) reasons.push('ADVISORY_WORSENED');

  const unsafeReasons = new Set<TransitiveRemediationReason>([
    'MANIFEST_CHANGED',
    'PACKAGE_MANAGER_CHANGED',
    'ROOT_NOT_DIRECT_DEPENDENCY',
    'DIRECT_DEPENDENCY_CHANGED',
    'SECURITY_EVIDENCE_UNAVAILABLE',
    'INVALID_ADVISORY_RANGE',
    'TARGET_ADVISORY_NOT_FOUND',
    'NEW_ADVISORY_INTRODUCED',
    'ADVISORY_WORSENED',
  ]);
  let classification: TransitiveRemediationClassification;
  if (reasons.some((reason) => unsafeReasons.has(reason))) {
    classification = 'unsafe';
  } else if (target.resolved.length === 0) {
    classification = 'no-fix';
    reasons.push('NO_TARGET_ADVISORY_RESOLVED');
  } else if (target.remaining.length > 0) {
    classification = 'partial';
    reasons.push('TARGET_ADVISORIES_REMAIN');
  } else {
    classification = 'full';
  }

  return {
    classification,
    automaticApplyAllowed: classification === 'full' || classification === 'partial',
    rootPackageName: options.rootPackageName,
    rootVersion: afterRoot?.version ?? null,
    reasons: uniqueReasons(reasons),
    manifestUnchanged: options.manifestUnchanged,
    packageManagerUnchanged,
    directDependencyChanges,
    packageChanges,
    security,
    target,
  };
}
