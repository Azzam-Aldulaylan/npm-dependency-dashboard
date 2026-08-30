/**
 * Complete before/after security comparison for a proposed dependency graph.
 *
 * This deliberately does not subtract dashboard row counts. It evaluates the
 * advisories supplied for each complete graph, groups every reachable affected
 * package by public advisory identity, and reports vulnerabilities that are
 * fixed, remain (including on a different resolved version), or are newly
 * introduced. Dependency paths are evidence, never extra vulnerability counts.
 */

import semver from 'semver';

import { vulnerabilityIdentifiers } from '../core/advisories/identifiers.js';
import { buildInstallPathIndex, pathsToNodes } from '../core/graph/paths.js';
import type { AdvisoriesByName } from '../core/advisories/attribution.js';
import type { Advisory, DependencyGraph, Severity } from '../core/types.js';

export interface CompleteGraphAdvisorySnapshot {
  graph: DependencyGraph;
  advisoriesByName: AdvisoriesByName;
  advisories: 'complete' | 'unavailable';
}

export interface SecurityIdentityEvidence {
  /** Stable preferred identifier (public CVE/GHSA when available, otherwise the internal npm source id). */
  identity: string;
  /** Every source/public alias that established this identity cluster. */
  aliases: string[];
  flaggedPackage: string;
  severity: Severity;
  title: string;
  beforeVersions: string[];
  afterVersions: string[];
  beforePaths: string[][];
  afterPaths: string[][];
  beforePathsTruncated: boolean;
  afterPathsTruncated: boolean;
}

export type ProposedGraphSecurityImpact =
  | {
      status: 'complete';
      /** Advisory + affected package + resolved version occurrences. */
      beforeOccurrenceCount: number;
      /** Advisory + affected package + resolved version occurrences. */
      afterOccurrenceCount: number;
      /** Advisory identities no longer applicable to any reachable version. */
      fixed: SecurityIdentityEvidence[];
      /** Advisory identities applicable in both graphs, even if the vulnerable version changed. */
      remaining: SecurityIdentityEvidence[];
      /** Advisory identities present only in the proposed graph. */
      introduced: SecurityIdentityEvidence[];
    }
  | {
      status: 'unavailable';
      reason:
        | 'before-advisories-unavailable'
        | 'after-advisories-unavailable'
        | 'both-advisories-unavailable'
        | 'invalid-advisory-range';
    };

interface RawOccurrence {
  state: 'before' | 'after';
  advisory: Advisory;
  aliases: string[];
  flaggedPackage: string;
  version: string;
  paths: string[][];
  pathsTruncated: boolean;
}

interface CollectedOccurrences {
  occurrences: RawOccurrence[];
  invalidAdvisoryRange: boolean;
}

interface GroupedState {
  advisories: Advisory[];
  aliases: Set<string>;
  versions: Set<string>;
  paths: Map<string, string[]>;
  pathsTruncated: boolean;
}

interface IdentityGroup {
  identity: string;
  flaggedPackage: string;
  aliases: Set<string>;
  before?: GroupedState;
  after?: GroupedState;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  info: 0,
};

const MAX_PATHS_PER_OCCURRENCE = 5;
const MAX_PATHS_PER_IDENTITY = 100;

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
    aliases.find((identifier) => identifier.startsWith('CVE-')) ??
    aliases.find((identifier) => identifier.startsWith('GHSA-')) ??
    aliases.find((identifier) => identifier.startsWith('NPM:')) ??
    aliases[0] ??
    'UNKNOWN'
  );
}

function pathKey(path: readonly string[]): string {
  return path.join('\u0000');
}

function collectOccurrences(
  snapshot: CompleteGraphAdvisorySnapshot,
  state: RawOccurrence['state']
): CollectedOccurrences {
  const index = buildInstallPathIndex(snapshot.graph);
  const occurrences: RawOccurrence[] = [];
  let invalidAdvisoryRange = false;

  for (const node of snapshot.graph.nodes.values()) {
    if (node.version === null || !index.distance.has(node.path)) continue;
    const advisories = snapshot.advisoriesByName.get(node.name) ?? [];
    for (const advisory of advisories) {
      if (semver.validRange(advisory.vulnerableVersions) === null) {
        invalidAdvisoryRange = true;
        continue;
      }
      let applies = false;
      try {
        applies = semver.satisfies(node.version, advisory.vulnerableVersions, {
          includePrerelease: true,
        });
      } catch {
        invalidAdvisoryRange = true;
        continue;
      }
      if (!applies) continue;

      const paths = pathsToNodes(snapshot.graph, index, new Set([node.path]), {
        maxPaths: MAX_PATHS_PER_OCCURRENCE,
        maxExplored: MAX_PATHS_PER_IDENTITY,
      });
      occurrences.push({
        state,
        advisory,
        aliases: aliasesFor(advisory),
        flaggedPackage: node.name,
        version: node.version,
        paths: paths.paths,
        pathsTruncated: paths.truncated,
      });
    }
  }

  return { occurrences, invalidAdvisoryRange };
}

/** Tiny disjoint-set used to merge advisories whose public/source aliases overlap. */
class AliasSets {
  private readonly parent = new Map<string, string>();

  add(alias: string): void {
    if (!this.parent.has(alias)) this.parent.set(alias, alias);
  }

  find(alias: string): string {
    const parent = this.parent.get(alias);
    if (parent === undefined) {
      this.parent.set(alias, alias);
      return alias;
    }
    if (parent === alias) return alias;
    const root = this.find(parent);
    this.parent.set(alias, root);
    return root;
  }

  union(left: string, right: string): void {
    this.add(left);
    this.add(right);
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    // Stable root keeps output deterministic regardless of input map order.
    if (leftRoot.localeCompare(rightRoot) <= 0) this.parent.set(rightRoot, leftRoot);
    else this.parent.set(leftRoot, rightRoot);
  }
}

function emptyGroupedState(): GroupedState {
  return {
    advisories: [],
    aliases: new Set(),
    versions: new Set(),
    paths: new Map(),
    pathsTruncated: false,
  };
}

function addOccurrence(state: GroupedState, occurrence: RawOccurrence): void {
  if (
    !state.advisories.some(
      (advisory) =>
        typeof advisory.id === typeof occurrence.advisory.id &&
        String(advisory.id) === String(occurrence.advisory.id) &&
        advisory.url === occurrence.advisory.url
    )
  ) {
    state.advisories.push(occurrence.advisory);
  }
  for (const alias of occurrence.aliases) state.aliases.add(alias);
  state.versions.add(occurrence.version);
  for (const path of occurrence.paths) state.paths.set(pathKey(path), path);
  state.pathsTruncated ||= occurrence.pathsTruncated;
}

function groupedOccurrences(occurrences: readonly RawOccurrence[]): IdentityGroup[] {
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
    const componentKey = `${occurrence.flaggedPackage}\u0000${sets.find(first)}`;
    const aliases = componentAliases.get(componentKey) ?? new Set<string>();
    componentAliases.set(componentKey, aliases);
    for (const alias of occurrence.aliases) aliases.add(alias);
  }

  const groups = new Map<string, IdentityGroup>();
  for (const occurrence of occurrences) {
    const sets = aliasesByPackage.get(occurrence.flaggedPackage);
    const first = occurrence.aliases[0];
    if (sets === undefined || first === undefined) continue;
    const componentKey = `${occurrence.flaggedPackage}\u0000${sets.find(first)}`;
    const aliases = componentAliases.get(componentKey) ?? new Set(occurrence.aliases);
    const identity = preferredIdentity([...aliases].sort());
    const key = `${occurrence.flaggedPackage}\u0000${identity}`;
    const group = groups.get(key) ?? {
      identity,
      flaggedPackage: occurrence.flaggedPackage,
      aliases,
    };
    const current = group[occurrence.state] ?? emptyGroupedState();
    addOccurrence(current, occurrence);
    group[occurrence.state] = current;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function representativeAdvisory(group: IdentityGroup): Advisory {
  const candidates = [
    ...(group.after?.advisories ?? []),
    ...(group.before?.advisories ?? []),
  ];
  const sorted = [...candidates].sort(
    (left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      left.title.localeCompare(right.title) ||
      String(left.id).localeCompare(String(right.id))
  );
  const first = sorted[0];
  if (first === undefined) throw new Error('Security identity group has no advisory evidence.');
  return first;
}

function sortedPaths(state: GroupedState | undefined): {
  paths: string[][];
  truncated: boolean;
} {
  if (state === undefined) return { paths: [], truncated: false };
  const all = [...state.paths.values()].sort(
    (left, right) => left.length - right.length || pathKey(left).localeCompare(pathKey(right))
  );
  return {
    paths: all.slice(0, MAX_PATHS_PER_IDENTITY),
    truncated: state.pathsTruncated || all.length > MAX_PATHS_PER_IDENTITY,
  };
}

function evidenceFor(group: IdentityGroup): SecurityIdentityEvidence {
  const advisory = representativeAdvisory(group);
  const before = sortedPaths(group.before);
  const after = sortedPaths(group.after);
  return {
    identity: group.identity,
    aliases: [...group.aliases].sort(),
    flaggedPackage: group.flaggedPackage,
    severity: advisory.severity,
    title: advisory.title,
    beforeVersions: [...(group.before?.versions ?? [])].sort(),
    afterVersions: [...(group.after?.versions ?? [])].sort(),
    beforePaths: before.paths,
    afterPaths: after.paths,
    beforePathsTruncated: before.truncated,
    afterPathsTruncated: after.truncated,
  };
}

function compareEvidence(left: SecurityIdentityEvidence, right: SecurityIdentityEvidence): number {
  return (
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
    left.flaggedPackage.localeCompare(right.flaggedPackage) ||
    left.identity.localeCompare(right.identity)
  );
}

/**
 * Compare two fully-audited graphs. Callers should normally obtain both maps
 * from one union bulk-advisory request so newly introduced package versions
 * are covered by the same source snapshot.
 */
export function compareProposedGraphSecurityImpact(
  before: CompleteGraphAdvisorySnapshot,
  after: CompleteGraphAdvisorySnapshot
): ProposedGraphSecurityImpact {
  if (before.advisories !== 'complete' && after.advisories !== 'complete') {
    return { status: 'unavailable', reason: 'both-advisories-unavailable' };
  }
  if (before.advisories !== 'complete') {
    return { status: 'unavailable', reason: 'before-advisories-unavailable' };
  }
  if (after.advisories !== 'complete') {
    return { status: 'unavailable', reason: 'after-advisories-unavailable' };
  }

  const beforeOccurrences = collectOccurrences(before, 'before');
  const afterOccurrences = collectOccurrences(after, 'after');
  if (beforeOccurrences.invalidAdvisoryRange || afterOccurrences.invalidAdvisoryRange) {
    return { status: 'unavailable', reason: 'invalid-advisory-range' };
  }

  const groups = groupedOccurrences([
    ...beforeOccurrences.occurrences,
    ...afterOccurrences.occurrences,
  ]);
  const fixed: SecurityIdentityEvidence[] = [];
  const remaining: SecurityIdentityEvidence[] = [];
  const introduced: SecurityIdentityEvidence[] = [];
  for (const group of groups) {
    const evidence = evidenceFor(group);
    if (group.before !== undefined && group.after !== undefined) remaining.push(evidence);
    else if (group.before !== undefined) fixed.push(evidence);
    else introduced.push(evidence);
  }

  const occurrenceCount = (state: 'before' | 'after'): number =>
    groups.reduce((total, group) => total + (group[state]?.versions.size ?? 0), 0);

  return {
    status: 'complete',
    beforeOccurrenceCount: occurrenceCount('before'),
    afterOccurrenceCount: occurrenceCount('after'),
    fixed: fixed.sort(compareEvidence),
    remaining: remaining.sort(compareEvidence),
    introduced: introduced.sort(compareEvidence),
  };
}
