import semver from 'semver';

import {
  analyzeCompatibility,
  type AnalyzeCompatibilityOptions,
} from '../compatibility/preflight.js';
import type {
  CompatibilityAnalysis,
  CompatibilityFinding,
  PackageMetadataProvider,
  PeerResolutionPolicy,
  ResolverVerifier,
  UpgradeChange,
  UpgradeProposal,
} from '../compatibility/types.js';
import type { DependencyGraph } from '../types.js';
import {
  isSafeNpmPackageName,
  isSafeSemverVersion,
  type DependencyClassification,
} from './plan.js';

/** A host-owned direct dependency which the planner is allowed to move. */
export interface UpgradeableDirectDependency {
  packageName: string;
  currentVersion: string;
  classification: DependencyClassification;
}

/**
 * Exact stable versions available for one direct dependency.
 *
 * `complete` means the provider considers this the exhaustive set it can
 * offer. A partial set can find a plan, but exhausting it cannot prove that no
 * plan exists.
 */
export interface StableVersionCandidates {
  versions: readonly string[];
  complete: boolean;
}

/** Registry/package-manager access remains injectable and lazy. */
export interface StableVersionCandidateProvider {
  getStableVersionCandidates(
    packageName: string,
    signal?: AbortSignal
  ): Promise<StableVersionCandidates>;
}

export interface SmartPlanSearchBounds {
  /** Includes the caller-supplied initial preflight result. */
  maxStates: number;
  maxAdditionalChanges: number;
  maxCandidatesPerPackage: number;
  maxCandidateQueries: number;
}

export const DEFAULT_SMART_PLAN_BOUNDS: Readonly<SmartPlanSearchBounds> = {
  maxStates: 64,
  maxAdditionalChanges: 4,
  maxCandidatesPerPackage: 8,
  maxCandidateQueries: 12,
};

export interface SmartPlanSearchStatistics {
  bounds: SmartPlanSearchBounds;
  statesAnalyzed: number;
  compatibilityChecks: number;
  candidateQueries: number;
  candidateVersionsConsidered: number;
  duplicateStatesPruned: number;
}

export interface UpgradePlanChange {
  change: UpgradeChange;
  reason:
    | { kind: 'requested'; findingIds: readonly [] }
    | { kind: 'compatibility-findings'; findingIds: readonly string[] };
}

/**
 * One conceptual upgrade step. A cyclic group must be submitted atomically;
 * acyclic groups expose their deterministic ordering constraints.
 */
export interface UpgradePlanGroup {
  id: string;
  changes: UpgradePlanChange[];
  cyclic: boolean;
  mustPrecedeGroupIds: string[];
  reasonFindingIds: string[];
}

export interface UpgradePlan {
  proposal: UpgradeProposal;
  compatibility: CompatibilityAnalysis;
  changes: UpgradePlanChange[];
  groups: UpgradePlanGroup[];
}

interface PlanSearchFailure {
  statistics: SmartPlanSearchStatistics;
  blockerFindingIds: string[];
}

export type PlanSearchResult =
  | { outcome: 'found'; plan: UpgradePlan; statistics: SmartPlanSearchStatistics }
  /** No plan exists within the provider's complete candidate universe. */
  | ({ outcome: 'impossible' } & PlanSearchFailure)
  /** Registry, metadata, or resolver evidence was incomplete. */
  | ({ outcome: 'unknown' } & PlanSearchFailure)
  /** A configured bound stopped the otherwise finite search. */
  | ({ outcome: 'limit-reached' } & PlanSearchFailure);

export interface PlanSmartUpgradeOptions {
  graph: DependencyGraph;
  /** The preflight which caused planning to be requested. It is not repeated. */
  initialAnalysis: CompatibilityAnalysis;
  upgradeableDirectDependencies: readonly UpgradeableDirectDependency[];
  candidateProvider: StableVersionCandidateProvider;
  metadataProvider?: PackageMetadataProvider;
  policy: PeerResolutionPolicy;
  resolverVerifier?: ResolverVerifier;
  staticMetadataCompleteness?: AnalyzeCompatibilityOptions['staticMetadataCompleteness'];
  signal?: AbortSignal;
  bounds?: Partial<SmartPlanSearchBounds>;
}

export class InvalidSmartPlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSmartPlanInputError';
  }
}

export class SmartPlanCancelledError extends Error {
  constructor() {
    super('Smart upgrade planning was cancelled.');
    this.name = 'SmartPlanCancelledError';
  }
}

interface SearchState {
  analysis: CompatibilityAnalysis;
  changes: UpgradeChange[];
  reasons: Map<string, Set<string>>;
}

interface CandidateCacheEntry {
  versions: string[];
  complete: boolean;
  malformed: boolean;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new SmartPlanCancelledError();
}

function isCancellation(cause: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (cause instanceof Error && cause.name === 'AbortError');
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidSmartPlanInputError(`${field} must be a positive integer.`);
  }
  return value;
}

function normalizeBounds(input: Partial<SmartPlanSearchBounds> | undefined): SmartPlanSearchBounds {
  return {
    maxStates: positiveInteger(input?.maxStates ?? DEFAULT_SMART_PLAN_BOUNDS.maxStates, 'maxStates'),
    maxAdditionalChanges: positiveInteger(
      input?.maxAdditionalChanges ?? DEFAULT_SMART_PLAN_BOUNDS.maxAdditionalChanges,
      'maxAdditionalChanges'
    ),
    maxCandidatesPerPackage: positiveInteger(
      input?.maxCandidatesPerPackage ?? DEFAULT_SMART_PLAN_BOUNDS.maxCandidatesPerPackage,
      'maxCandidatesPerPackage'
    ),
    maxCandidateQueries: positiveInteger(
      input?.maxCandidateQueries ?? DEFAULT_SMART_PLAN_BOUNDS.maxCandidateQueries,
      'maxCandidateQueries'
    ),
  };
}

function directVersion(graph: DependencyGraph, packageName: string): string | null {
  for (const node of graph.nodes.values()) {
    if (node.direct && node.name === packageName && node.version !== null) return node.version;
  }
  return null;
}

function validateUpgradeableDependencies(
  graph: DependencyGraph,
  dependencies: readonly UpgradeableDirectDependency[]
): Map<string, UpgradeableDirectDependency> {
  const result = new Map<string, UpgradeableDirectDependency>();
  for (const dependency of dependencies) {
    if (!isSafeNpmPackageName(dependency.packageName)) {
      throw new InvalidSmartPlanInputError(`Invalid upgradeable package name: ${dependency.packageName}`);
    }
    if (!isSafeSemverVersion(dependency.currentVersion)) {
      throw new InvalidSmartPlanInputError(
        `Upgradeable dependency ${dependency.packageName} must have an exact current version.`
      );
    }
    if (
      dependency.classification !== 'prod' &&
      dependency.classification !== 'dev' &&
      dependency.classification !== 'optional'
    ) {
      throw new InvalidSmartPlanInputError(
        `Invalid dependency classification for ${dependency.packageName}.`
      );
    }
    if (result.has(dependency.packageName)) {
      throw new InvalidSmartPlanInputError(`Duplicate upgradeable dependency: ${dependency.packageName}`);
    }
    if (directVersion(graph, dependency.packageName) !== dependency.currentVersion) {
      throw new InvalidSmartPlanInputError(
        `Upgradeable dependency ${dependency.packageName} does not match the direct dependency graph.`
      );
    }
    result.set(dependency.packageName, dependency);
  }
  return result;
}

function proposalSignature(changes: readonly UpgradeChange[]): string {
  return [...changes]
    .sort((a, b) => a.packageName.localeCompare(b.packageName))
    .map((change) => `${change.packageName}@${change.targetVersion}`)
    .join('\n');
}

function sortedChanges(changes: readonly UpgradeChange[]): UpgradeChange[] {
  return [...changes].sort(
    (a, b) => a.packageName.localeCompare(b.packageName) || semver.compare(a.targetVersion, b.targetVersion)
  );
}

function blockingFindings(analysis: CompatibilityAnalysis): CompatibilityFinding[] {
  return analysis.findings
    .filter((finding) => finding.status === 'conflict')
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Find direct packages implicated by a conflict. Direct subjects take
 * precedence; a transitive subject maps to its direct relation root. The peer
 * requirement is also eligible when it is a different, unchanged direct
 * dependency.
 */
function expansionReasons(
  findings: readonly CompatibilityFinding[],
  allowed: ReadonlyMap<string, UpgradeableDirectDependency>,
  changedNames: ReadonlySet<string>
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const add = (name: string | undefined, findingId: string): void => {
    if (name === undefined || changedNames.has(name) || !allowed.has(name)) return;
    const ids = result.get(name) ?? new Set<string>();
    ids.add(findingId);
    result.set(name, ids);
  };

  for (const finding of findings) {
    if (
      finding.kind !== 'peer-incompatible' &&
      finding.kind !== 'peer-missing' &&
      finding.kind !== 'invalid-peer-range'
    ) {
      continue;
    }
    add(finding.subject.name, finding.id);
    add(finding.relation.packageNames[0], finding.id);
    if (finding.kind !== 'invalid-peer-range') add(finding.requirement?.name, finding.id);
  }
  return new Map([...result.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeCandidates(
  dependency: UpgradeableDirectDependency,
  raw: StableVersionCandidates,
  maximum: number
): CandidateCacheEntry {
  let malformed = false;
  const unique = new Set<string>();
  for (const version of raw.versions) {
    if (!isSafeSemverVersion(version)) {
      malformed = true;
      continue;
    }
    if (semver.prerelease(version) !== null || !semver.gt(version, dependency.currentVersion)) continue;
    unique.add(version);
  }
  const all = [...unique].sort(semver.rcompare);
  return {
    versions: all.slice(0, maximum),
    complete: raw.complete && all.length <= maximum,
    malformed,
  };
}

function copyReasons(reasons: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  return new Map([...reasons].map(([name, ids]) => [name, new Set(ids)]));
}

function statusAcceptsPlan(analysis: CompatibilityAnalysis): boolean {
  return analysis.status === 'compatible' || analysis.status === 'warning';
}

function planChanges(state: SearchState): UpgradePlanChange[] {
  return sortedChanges(state.changes).map((change) => {
    const ids = [...(state.reasons.get(change.packageName) ?? [])].sort();
    if (change.packageName === state.analysis.proposal.requested.packageName) {
      return { change, reason: { kind: 'requested', findingIds: [] } };
    }
    return { change, reason: { kind: 'compatibility-findings', findingIds: ids } };
  });
}

interface StrongComponent {
  names: string[];
  cyclic: boolean;
}

function stronglyConnectedComponents(
  names: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>
): StrongComponent[] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: StrongComponent[] = [];

  const visit = (name: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indices.set(name, index);
    lowLinks.set(name, index);
    stack.push(name);
    onStack.add(name);

    for (const target of [...(edges.get(name) ?? [])].sort()) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(name, Math.min(lowLinks.get(name) ?? index, lowLinks.get(target) ?? index));
      } else if (onStack.has(target)) {
        lowLinks.set(name, Math.min(lowLinks.get(name) ?? index, indices.get(target) ?? index));
      }
    }

    if (lowLinks.get(name) !== indices.get(name)) return;
    const members: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      members.push(member);
      if (member === name) break;
    }
    members.sort();
    components.push({
      names: members,
      cyclic: members.length > 1 || (edges.get(members[0] ?? '')?.has(members[0] ?? '') ?? false),
    });
  };

  for (const name of [...names].sort()) {
    if (!indices.has(name)) visit(name);
  }
  return components;
}

function buildGroups(state: SearchState, changes: readonly UpgradePlanChange[]): UpgradePlanGroup[] {
  const changedNames = new Set(changes.map((entry) => entry.change.packageName));
  const edges = new Map<string, Set<string>>(
    [...changedNames].map((name) => [name, new Set<string>()])
  );

  // A peer owner conceptually precedes the peer it constrains. Mutual peer
  // relationships become an SCC and therefore one atomic coordinated group.
  for (const finding of state.analysis.findings) {
    const peerName = finding.requirement?.name;
    if (
      peerName !== undefined &&
      changedNames.has(finding.subject.name) &&
      changedNames.has(peerName)
    ) {
      edges.get(finding.subject.name)?.add(peerName);
    }
  }

  const components = stronglyConnectedComponents([...changedNames], edges);
  const componentForName = new Map<string, number>();
  components.forEach((component, index) => {
    for (const name of component.names) componentForName.set(name, index);
  });
  const componentEdges = new Map<number, Set<number>>(
    components.map((_, index) => [index, new Set<number>()])
  );
  for (const [source, targets] of edges) {
    const sourceIndex = componentForName.get(source);
    if (sourceIndex === undefined) continue;
    for (const target of targets) {
      const targetIndex = componentForName.get(target);
      if (targetIndex !== undefined && targetIndex !== sourceIndex) {
        componentEdges.get(sourceIndex)?.add(targetIndex);
      }
    }
  }

  const groupId = (index: number): string => `group:${components[index]?.names.join('+') ?? index}`;
  const indegrees = new Map<number, number>(components.map((_, index) => [index, 0]));
  for (const targets of componentEdges.values()) {
    for (const target of targets) indegrees.set(target, (indegrees.get(target) ?? 0) + 1);
  }
  const ready = components
    .map((_, index) => index)
    .filter((index) => indegrees.get(index) === 0)
    .sort((a, b) => groupId(a).localeCompare(groupId(b)));
  const ordered: number[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    ordered.push(current);
    for (const target of [...(componentEdges.get(current) ?? [])].sort((a, b) => groupId(a).localeCompare(groupId(b)))) {
      const degree = (indegrees.get(target) ?? 0) - 1;
      indegrees.set(target, degree);
      if (degree === 0) {
        ready.push(target);
        ready.sort((a, b) => groupId(a).localeCompare(groupId(b)));
      }
    }
  }

  const byName = new Map(changes.map((entry) => [entry.change.packageName, entry]));
  return ordered.map((index) => {
    const component = components[index];
    if (component === undefined) throw new InvalidSmartPlanInputError('Invalid coordinated group.');
    const entries = component.names
      .map((name) => byName.get(name))
      .filter((entry): entry is UpgradePlanChange => entry !== undefined);
    return {
      id: groupId(index),
      changes: entries,
      cyclic: component.cyclic,
      mustPrecedeGroupIds: [...(componentEdges.get(index) ?? [])]
        .map(groupId)
        .sort(),
      reasonFindingIds: [...new Set(entries.flatMap((entry) => [...entry.reason.findingIds]))].sort(),
    };
  });
}

function buildPlan(state: SearchState): UpgradePlan {
  const changes = planChanges(state);
  return {
    proposal: state.analysis.proposal,
    compatibility: state.analysis,
    changes,
    groups: buildGroups(state, changes),
  };
}

function analysisOptions(
  options: PlanSmartUpgradeOptions,
  proposal: UpgradeProposal,
  includeResolver: boolean
): AnalyzeCompatibilityOptions {
  const result: AnalyzeCompatibilityOptions = {
    graph: options.graph,
    proposal,
    policy: options.policy,
  };
  if (options.metadataProvider !== undefined) result.metadataProvider = options.metadataProvider;
  if (includeResolver && options.resolverVerifier !== undefined) result.resolverVerifier = options.resolverVerifier;
  if (options.staticMetadataCompleteness !== undefined) {
    result.staticMetadataCompleteness = options.staticMetadataCompleteness;
  }
  if (options.signal !== undefined) result.signal = options.signal;
  return result;
}

/**
 * Bounded, deterministic smart-upgrade search. It never resolves arbitrary
 * packages: expansion starts from preflight conflicts and remains restricted
 * to the host-provided direct-dependency allowlist.
 */
export async function planSmartUpgrade(options: PlanSmartUpgradeOptions): Promise<PlanSearchResult> {
  throwIfCancelled(options.signal);
  const bounds = normalizeBounds(options.bounds);
  const allowed = validateUpgradeableDependencies(options.graph, options.upgradeableDirectDependencies);
  const initialChanges = sortedChanges(options.initialAnalysis.proposal.changes);
  const initialReasons = new Map<string, Set<string>>(
    initialChanges.map((change) => [change.packageName, new Set<string>()])
  );
  const queue: SearchState[] = [{
    analysis: options.initialAnalysis,
    changes: initialChanges,
    reasons: initialReasons,
  }];
  const seen = new Set<string>([proposalSignature(initialChanges)]);
  const candidateCache = new Map<string, CandidateCacheEntry | 'failed'>();
  const allBlockerIds = new Set<string>();
  const statistics: SmartPlanSearchStatistics = {
    bounds,
    statesAnalyzed: 1,
    compatibilityChecks: 0,
    candidateQueries: 0,
    candidateVersionsConsidered: 0,
    duplicateStatesPruned: 0,
  };
  let limitReached = false;
  let uncertaintyObserved = false;

  const loadCandidates = async (
    dependency: UpgradeableDirectDependency
  ): Promise<CandidateCacheEntry | 'failed' | 'limit'> => {
    const cached = candidateCache.get(dependency.packageName);
    if (cached !== undefined) return cached;
    if (statistics.candidateQueries >= bounds.maxCandidateQueries) {
      limitReached = true;
      return 'limit';
    }
    statistics.candidateQueries += 1;
    try {
      const raw = await options.candidateProvider.getStableVersionCandidates(
        dependency.packageName,
        options.signal
      );
      throwIfCancelled(options.signal);
      const normalized = normalizeCandidates(dependency, raw, bounds.maxCandidatesPerPackage);
      candidateCache.set(dependency.packageName, normalized);
      statistics.candidateVersionsConsidered += normalized.versions.length;
      if (!normalized.complete && raw.versions.length > bounds.maxCandidatesPerPackage) limitReached = true;
      if (!normalized.complete || normalized.malformed) uncertaintyObserved = true;
      return normalized;
    } catch (cause) {
      if (isCancellation(cause, options.signal)) throw new SmartPlanCancelledError();
      candidateCache.set(dependency.packageName, 'failed');
      uncertaintyObserved = true;
      return 'failed';
    }
  };

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    throwIfCancelled(options.signal);
    const state = queue[queueIndex];
    if (state === undefined) continue;
    if (statusAcceptsPlan(state.analysis)) {
      return { outcome: 'found', plan: buildPlan(state), statistics };
    }
    if (state.analysis.status === 'unknown') {
      uncertaintyObserved = true;
      continue;
    }

    const blockers = blockingFindings(state.analysis);
    for (const finding of blockers) allBlockerIds.add(finding.id);
    if (blockers.length === 0) {
      // An opaque resolver conflict supplies no safe package to expand.
      uncertaintyObserved = true;
      continue;
    }
    const changedNames = new Set(state.changes.map((change) => change.packageName));
    const expansions = expansionReasons(blockers, allowed, changedNames);
    if (expansions.size === 0) continue;
    if (state.changes.length - initialChanges.length >= bounds.maxAdditionalChanges) {
      limitReached = true;
      continue;
    }

    for (const [packageName, findingIds] of expansions) {
      const dependency = allowed.get(packageName);
      if (dependency === undefined) continue;
      const candidates = await loadCandidates(dependency);
      if (candidates === 'failed' || candidates === 'limit') continue;
      for (const targetVersion of candidates.versions) {
        if (statistics.statesAnalyzed >= bounds.maxStates) {
          limitReached = true;
          break;
        }
        const nextChange: UpgradeChange = {
          packageName,
          currentVersion: dependency.currentVersion,
          targetVersion,
          classification: dependency.classification,
        };
        const changes = sortedChanges([...state.changes, nextChange]);
        const signature = proposalSignature(changes);
        if (seen.has(signature)) {
          statistics.duplicateStatesPruned += 1;
          continue;
        }
        seen.add(signature);
        const reasons = copyReasons(state.reasons);
        reasons.set(packageName, new Set(findingIds));
        const proposal: UpgradeProposal = {
          requested: options.initialAnalysis.proposal.requested,
          changes,
        };
        // Static graph/metadata conflicts already prove this state cannot be
        // executed and also identify which direct package can resolve the
        // conflict. Running npm/pnpm for every such intermediate state adds
        // seconds without changing the search. Invoke the real resolver only
        // once a state is statically viable; that final candidate remains
        // fully resolver-verified before it can be offered.
        let analysis = await analyzeCompatibility(analysisOptions(options, proposal, false));
        if (statusAcceptsPlan(analysis) && options.resolverVerifier !== undefined) {
          analysis = await analyzeCompatibility(analysisOptions(options, proposal, true));
        }
        statistics.compatibilityChecks += 1;
        statistics.statesAnalyzed += 1;
        queue.push({ analysis, changes, reasons });
      }
    }
  }

  const failure = {
    statistics,
    blockerFindingIds: [...allBlockerIds].sort(),
  };
  if (limitReached) return { outcome: 'limit-reached', ...failure };
  if (uncertaintyObserved) return { outcome: 'unknown', ...failure };
  return { outcome: 'impossible', ...failure };
}
