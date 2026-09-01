import semver from 'semver';

import { DEFAULT_CONCURRENCY, runPool } from '../registry/pool.js';
import type { DependencyGraph, DependencyNode } from '../types.js';
import { isSafeNpmPackageName, isSafeSemverVersion } from '../upgrade/plan.js';
import type { PackageVersionMetadata } from '../registry/versions.js';
import type {
  CompatibilityAnalysis,
  CompatibilityCompleteness,
  CompatibilityFinding,
  CompatibilityStatus,
  DependencyRelation,
  PackageMetadataProvider,
  PeerResolutionPolicy,
  ResolverVerification,
  ResolverVerifier,
  UpgradeChange,
  UpgradeProposal,
} from './types.js';

interface NormalizedDependencyEdge {
  name: string;
  requestedRange: string;
  kind: 'runtime' | 'optional' | 'peer';
  targetNodeId: string | null;
  optional: boolean;
}

type NodeWithEdges = DependencyNode & { edges?: readonly NormalizedDependencyEdge[] };

export interface AnalyzeCompatibilityOptions {
  graph: DependencyGraph;
  proposal: UpgradeProposal;
  metadataProvider?: PackageMetadataProvider;
  policy: PeerResolutionPolicy;
  resolverVerifier?: ResolverVerifier;
  /** Override when a parser knows its peer metadata is incomplete. */
  staticMetadataCompleteness?: CompatibilityCompleteness;
  signal?: AbortSignal;
}

export class InvalidUpgradeProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUpgradeProposalError';
  }
}

export class CompatibilityCancelledError extends Error {
  constructor() {
    super('Compatibility analysis was cancelled.');
    this.name = 'CompatibilityCancelledError';
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CompatibilityCancelledError();
}

function cancellationCause(cause: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (cause instanceof Error && cause.name === 'AbortError');
}

function validateChange(change: UpgradeChange): void {
  if (!isSafeNpmPackageName(change.packageName)) {
    throw new InvalidUpgradeProposalError(`Invalid package name: ${change.packageName}`);
  }
  if (!isSafeSemverVersion(change.currentVersion) || !isSafeSemverVersion(change.targetVersion)) {
    throw new InvalidUpgradeProposalError(`Upgrade versions must be exact semver for ${change.packageName}.`);
  }
  if (!semver.gt(change.targetVersion, change.currentVersion)) {
    throw new InvalidUpgradeProposalError(`Target must be newer than current for ${change.packageName}.`);
  }
}

function validateProposal(proposal: UpgradeProposal): void {
  if (proposal.changes.length === 0) {
    throw new InvalidUpgradeProposalError('An upgrade proposal must contain at least one change.');
  }
  const seen = new Set<string>();
  for (const change of proposal.changes) {
    validateChange(change);
    if (seen.has(change.packageName)) {
      throw new InvalidUpgradeProposalError(`Duplicate package in proposal: ${change.packageName}`);
    }
    seen.add(change.packageName);
  }
  validateChange(proposal.requested);
  const requested = proposal.changes.find((change) => change.packageName === proposal.requested.packageName);
  if (
    requested === undefined ||
    requested.currentVersion !== proposal.requested.currentVersion ||
    requested.targetVersion !== proposal.requested.targetVersion ||
    requested.classification !== proposal.requested.classification
  ) {
    throw new InvalidUpgradeProposalError('The requested upgrade must appear exactly in proposal changes.');
  }
}

function edgesOf(node: DependencyNode): readonly NormalizedDependencyEdge[] {
  const edges = (node as NodeWithEdges).edges;
  if (!Array.isArray(edges)) return [];
  return edges.filter(
    (edge): edge is NormalizedDependencyEdge =>
      typeof edge === 'object' &&
      edge !== null &&
      typeof edge.name === 'string' &&
      typeof edge.requestedRange === 'string' &&
      (edge.kind === 'runtime' || edge.kind === 'optional' || edge.kind === 'peer') &&
      (edge.targetNodeId === null || typeof edge.targetNodeId === 'string') &&
      typeof edge.optional === 'boolean'
  );
}

function sortedNodes(graph: DependencyGraph): Array<[string, DependencyNode]> {
  return [...graph.nodes.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Shortest deterministic runtime path from a direct dependency to each node. */
function buildRelationPaths(graph: DependencyGraph): Map<string, DependencyRelation> {
  const result = new Map<string, DependencyRelation>();
  const queue: Array<{ id: string; nodeIds: string[]; names: string[] }> = [];
  for (const [id, node] of sortedNodes(graph).filter(([, value]) => value.direct)) {
    queue.push({ id, nodeIds: [id], names: [node.name] });
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined || result.has(current.id)) continue;
    const node = graph.nodes.get(current.id);
    if (node === undefined) continue;
    result.set(current.id, {
      kind: current.nodeIds.length === 1 ? 'direct' : 'transitive',
      nodeIds: current.nodeIds,
      packageNames: current.names,
    });
    const next = edgesOf(node)
      .filter((edge) => edge.kind !== 'peer' && edge.targetNodeId !== null)
      .sort((a, b) => a.name.localeCompare(b.name) || (a.targetNodeId ?? '').localeCompare(b.targetNodeId ?? ''));
    for (const edge of next) {
      if (edge.targetNodeId === null || result.has(edge.targetNodeId)) continue;
      const target = graph.nodes.get(edge.targetNodeId);
      if (target === undefined) continue;
      queue.push({
        id: edge.targetNodeId,
        nodeIds: [...current.nodeIds, edge.targetNodeId],
        names: [...current.names, target.name],
      });
    }
  }
  return result;
}

function relationFor(
  nodeId: string | null,
  node: DependencyNode | undefined,
  paths: ReadonlyMap<string, DependencyRelation>,
  fallbackName: string
): DependencyRelation {
  if (nodeId !== null) {
    const path = paths.get(nodeId);
    if (path !== undefined) return path;
  }
  return {
    kind: node?.direct === true ? 'direct' : 'transitive',
    nodeIds: nodeId === null ? [] : [nodeId],
    packageNames: [node?.name ?? fallbackName],
  };
}

function findingId(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function peerStatus(
  state: 'missing' | 'incompatible',
  optional: boolean,
  policy: PeerResolutionPolicy
): CompatibilityStatus {
  if (state === 'missing' && optional) return 'compatible';
  if (policy.legacyPeerDeps) return 'warning';
  if (state === 'missing' && !policy.strictPeerDeps) return 'warning';
  return 'conflict';
}

function peerFinding(input: {
  ownerId: string | null;
  owner: DependencyNode | undefined;
  ownerVersion: string | null;
  peerName: string;
  range: string;
  optional: boolean;
  observedVersion: string | null;
  relation: DependencyRelation;
  policy: PeerResolutionPolicy;
}): CompatibilityFinding {
  const requirement = { name: input.peerName, range: input.range, optional: input.optional };
  const subject = {
    name: input.owner?.name ?? input.relation.packageNames.at(-1) ?? 'unknown',
    version: input.ownerVersion,
    nodeId: input.ownerId,
  };
  if (semver.validRange(input.range) === null) {
    return {
      id: findingId(['invalid-peer-range', input.ownerId ?? subject.name, input.peerName, input.range]),
      kind: 'invalid-peer-range',
      status: 'unknown',
      source: 'static',
      subject,
      requirement,
      observedVersion: input.observedVersion,
      relation: input.relation,
      explanation: `${subject.name}@${input.ownerVersion ?? 'unknown'} declares an invalid peer range ${input.peerName}@${input.range}.`,
    };
  }

  if (input.observedVersion === null) {
    const status = peerStatus('missing', input.optional, input.policy);
    return {
      id: findingId([input.optional ? 'optional-peer-missing' : 'peer-missing', input.ownerId ?? subject.name, input.peerName]),
      kind: input.optional ? 'optional-peer-missing' : 'peer-missing',
      status,
      source: 'static',
      subject,
      requirement,
      observedVersion: null,
      relation: input.relation,
      explanation: input.optional
        ? `${subject.name}@${input.ownerVersion ?? 'unknown'} has an optional peer ${input.peerName}@${input.range}, which is not installed.`
        : `${subject.name}@${input.ownerVersion ?? 'unknown'} requires peer ${input.peerName}@${input.range}, which is not currently resolved.`,
    };
  }

  const compatible =
    semver.valid(input.observedVersion) !== null &&
    semver.satisfies(input.observedVersion, input.range, { includePrerelease: true });
  if (compatible) {
    return {
      id: findingId(['peer-compatible', input.ownerId ?? subject.name, input.peerName, input.observedVersion]),
      kind: 'peer-compatible',
      status: 'compatible',
      source: 'static',
      subject,
      requirement,
      observedVersion: input.observedVersion,
      relation: input.relation,
      explanation: `${subject.name}@${input.ownerVersion ?? 'unknown'} accepts ${input.peerName}@${input.observedVersion} (${input.range}).`,
    };
  }

  const status = peerStatus('incompatible', input.optional, input.policy);
  return {
    id: findingId(['peer-incompatible', input.ownerId ?? subject.name, input.peerName, input.observedVersion]),
    kind: 'peer-incompatible',
    status,
    source: 'static',
    subject,
    requirement,
    observedVersion: input.observedVersion,
    relation: input.relation,
    explanation: `${subject.name}@${input.ownerVersion ?? 'unknown'} requires ${input.peerName}@${input.range}, but the proposal resolves ${input.observedVersion}.`,
  };
}

function findDirectNode(graph: DependencyGraph, packageName: string): [string, DependencyNode] | null {
  return sortedNodes(graph).find(([, node]) => node.direct && node.name === packageName) ?? null;
}

function observedPeerVersion(input: {
  graph: DependencyGraph;
  owner: DependencyNode | undefined;
  peerName: string;
  changesByName: ReadonlyMap<string, UpgradeChange>;
}): string | null {
  const proposed = input.changesByName.get(input.peerName);
  if (proposed !== undefined) return proposed.targetVersion;

  const oldPeer = input.owner === undefined
    ? undefined
    : edgesOf(input.owner).find((edge) => edge.kind === 'peer' && edge.name === input.peerName);
  if (oldPeer?.targetNodeId !== null && oldPeer?.targetNodeId !== undefined) {
    return input.graph.nodes.get(oldPeer.targetNodeId)?.version ?? null;
  }
  return findDirectNode(input.graph, input.peerName)?.[1].version ?? null;
}

function aggregateStatus(
  findings: readonly CompatibilityFinding[],
  resolver: ResolverVerification | undefined
): CompatibilityStatus {
  const statuses = findings.map((finding) => finding.status);
  if (resolver !== undefined) statuses.push(resolver.status);
  if (statuses.includes('conflict')) return 'conflict';
  // Unknown means there is not enough evidence to conclude, even if a less
  // severe warning is also present (for example a major bump plus dead registry).
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('warning')) return 'warning';
  return 'compatible';
}

function inferStaticCompleteness(options: AnalyzeCompatibilityOptions): CompatibilityCompleteness {
  if (options.staticMetadataCompleteness !== undefined) return options.staticMetadataCompleteness;
  // package-lock v1 commonly lacks package peer manifests. Absence is not
  // evidence that no peers exist, so make the limitation explicit.
  return options.graph.lockfileVersion === 1 ? 'partial' : 'complete';
}

function graphPackageManager(graph: DependencyGraph): 'npm' | 'pnpm' {
  const value = (graph as DependencyGraph & { packageManager?: unknown }).packageManager;
  return value === 'pnpm' ? 'pnpm' : 'npm';
}

async function loadTargetMetadata(
  changes: readonly UpgradeChange[],
  provider: PackageMetadataProvider | undefined,
  signal: AbortSignal | undefined
): Promise<Map<string, PackageVersionMetadata | Error>> {
  const ordered = [...changes].sort((a, b) => a.packageName.localeCompare(b.packageName));
  const settled = await runPool(
    ordered,
    async (change, poolSignal): Promise<PackageVersionMetadata> => {
      throwIfCancelled(signal);
      if (provider === undefined) throw new Error('metadata provider unavailable');
      return await provider.getPackageVersionMetadata(
        change.packageName,
        change.targetVersion,
        poolSignal
      );
    },
    {
      limit: DEFAULT_CONCURRENCY,
      ...(signal === undefined ? {} : { signal }),
    }
  );
  throwIfCancelled(signal);
  return new Map(
    ordered.map((change, index) => {
      const result = settled[index];
      return [
        change.packageName,
        result?.ok === true ? result.value : (result?.error ?? new Error('metadata provider failed')),
      ];
    })
  );
}

async function runResolverVerification(
  options: AnalyzeCompatibilityOptions
): Promise<ResolverVerification | undefined> {
  if (options.resolverVerifier === undefined) return undefined;
  try {
    const result = await options.resolverVerifier.verify(options.proposal, options.signal);
    throwIfCancelled(options.signal);
    return result;
  } catch (cause) {
    if (cancellationCause(cause, options.signal)) throw new CompatibilityCancelledError();
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    return {
      status: 'unknown',
      packageManager: graphPackageManager(options.graph),
      packageManagerVersion: null,
      code: timedOut ? 'RESOLVER_TIMEOUT' : 'RESOLVER_UNAVAILABLE',
      explanation: timedOut
        ? 'Package-manager resolution exceeded the analysis time limit. Check registry access and retry; dependency compatibility is not verified.'
        : 'Package-manager resolution verification was unavailable.',
    };
  }
}

/**
 * Layered, reusable upgrade preflight. Static inspection is deterministic;
 * registry metadata and package-manager simulation are injected and lazy.
 */
export async function analyzeCompatibility(
  options: AnalyzeCompatibilityOptions
): Promise<CompatibilityAnalysis> {
  throwIfCancelled(options.signal);
  validateProposal(options.proposal);

  const findings: CompatibilityFinding[] = [];
  const changesByName = new Map(options.proposal.changes.map((change) => [change.packageName, change]));
  const paths = buildRelationPaths(options.graph);
  let completeness = inferStaticCompleteness(options);

  if (completeness === 'partial') {
    findings.push({
      id: findingId(['graph-metadata-incomplete']),
      kind: 'graph-metadata-incomplete',
      status: 'unknown',
      source: 'static',
      subject: { name: options.proposal.requested.packageName, version: options.proposal.requested.targetVersion, nodeId: null },
      relation: { kind: 'direct', nodeIds: [], packageNames: [options.proposal.requested.packageName] },
      explanation: 'The active lockfile does not provide complete peer-dependency metadata.',
    });
  }

  for (const change of [...options.proposal.changes].sort((a, b) => a.packageName.localeCompare(b.packageName))) {
    if (semver.major(change.currentVersion) !== semver.major(change.targetVersion)) {
      const direct = findDirectNode(options.graph, change.packageName);
      findings.push({
        id: findingId(['major-version-change', change.packageName, change.currentVersion, change.targetVersion]),
        kind: 'major-version-change',
        status: 'warning',
        source: 'static',
        subject: { name: change.packageName, version: change.targetVersion, nodeId: direct?.[0] ?? null },
        relation: relationFor(direct?.[0] ?? null, direct?.[1], paths, change.packageName),
        explanation: `${change.packageName} changes major version from ${change.currentVersion} to ${change.targetVersion}.`,
      });
    }
  }

  // Existing packages whose peers point at a changed package.
  for (const [ownerId, owner] of sortedNodes(options.graph)) {
    if (changesByName.has(owner.name)) continue; // target metadata below replaces old peer declarations
    for (const edge of edgesOf(owner)
      .filter((candidate) => candidate.kind === 'peer' && changesByName.has(candidate.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const observed = changesByName.get(edge.name)?.targetVersion ?? null;
      findings.push(
        peerFinding({
          ownerId,
          owner,
          ownerVersion: owner.version,
          peerName: edge.name,
          range: edge.requestedRange,
          optional: edge.optional,
          observedVersion: observed,
          relation: relationFor(ownerId, owner, paths, owner.name),
          policy: options.policy,
        })
      );
    }
  }

  // A proposed package can introduce or change its own peer requirements, so
  // inspect the exact target manifest rather than reusing installed metadata.
  // Exact target metadata and the isolated package-manager resolver depend
  // only on the already-validated graph/proposal. Run them together so a
  // registry/proxy round trip is not placed in front of an already-expensive
  // resolver subprocess. Promise.all attaches cancellation/error handlers to
  // both branches even when one settles first.
  const [metadataByName, resolverVerification] = await Promise.all([
    loadTargetMetadata(options.proposal.changes, options.metadataProvider, options.signal),
    runResolverVerification(options),
  ]);
  for (const change of [...options.proposal.changes].sort((a, b) => a.packageName.localeCompare(b.packageName))) {
    throwIfCancelled(options.signal);
    const metadata = metadataByName.get(change.packageName);
    const direct = findDirectNode(options.graph, change.packageName);
    const ownerId = direct?.[0] ?? null;
    const owner = direct?.[1];
    const relation = relationFor(ownerId, owner, paths, change.packageName);
    if (metadata instanceof Error || metadata === undefined) {
      completeness = 'partial';
      findings.push({
        id: findingId(['metadata-unavailable', change.packageName, change.targetVersion]),
        kind: 'metadata-unavailable',
        status: 'unknown',
        source: 'static',
        subject: { name: change.packageName, version: change.targetVersion, nodeId: ownerId },
        relation,
        explanation: `Peer metadata for ${change.packageName}@${change.targetVersion} could not be retrieved.`,
      });
      continue;
    }

    for (const peerName of Object.keys(metadata.peerDependencies).sort()) {
      const range = metadata.peerDependencies[peerName];
      if (range === undefined) continue;
      const optional = metadata.peerDependenciesMeta[peerName]?.optional === true;
      findings.push(
        peerFinding({
          ownerId,
          owner,
          ownerVersion: change.targetVersion,
          peerName,
          range,
          optional,
          observedVersion: observedPeerVersion({
            graph: options.graph,
            owner,
            peerName,
            changesByName,
          }),
          relation,
          policy: options.policy,
        })
      );
    }
  }

  throwIfCancelled(options.signal);
  if (findings.some((finding) => finding.status === 'unknown')) completeness = 'partial';

  const result: CompatibilityAnalysis = {
    proposal: options.proposal,
    status: aggregateStatus(findings, resolverVerification),
    completeness,
    findings,
  };
  if (resolverVerification !== undefined) result.resolverVerification = resolverVerification;
  return result;
}
