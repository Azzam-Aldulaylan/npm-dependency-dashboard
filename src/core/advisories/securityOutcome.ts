/**
 * Whether a proposed upgrade actually fixes, leaves, or has an undetermined
 * effect on the vulnerabilities already attributed to a dependency row.
 *
 * The one rule this file exists to enforce: "the target version is newer" is
 * never treated as proof of a fix. A transitive advisory can only be marked
 * `resolved`/`remains` when real resolver evidence (a materialized post-upgrade
 * dependency graph — see IsolatedResolverVerifier.materializeResolvedGraph in
 * src/host/resolverVerifier.ts) says so; without it, a transitive advisory's
 * fate is `unknown`, never guessed from the direct dependency's own version
 * bump alone.
 */

import semver from 'semver';

import { attributeAdvisories } from './attribution.js';
import type { AdvisoriesByName } from './attribution.js';
import { directNodes, resolveDependency } from '../lockfile/parse.js';
import type { Advisory, AttributedAdvisory, DependencyGraph, DependencyNode, PatchedVersionResult } from '../types.js';

export type SecurityOutcomeStatus = 'resolved' | 'remains' | 'unknown' | 'not-applicable';

export interface RemainingVulnerability {
  advisory: Advisory;
  flaggedPackage: string;
  path: string[];
  /** Per-item fate: proven still present, vs. undetermined (no resolver evidence for a transitive advisory). */
  status: 'remains' | 'unknown';
  /** The version actually present in the proposed tree, when resolver evidence supplied it. */
  resolvedVersion: string | null;
  patchedVersion: PatchedVersionResult;
}

export interface SecurityOutcome {
  status: SecurityOutcomeStatus;
  resolvedAdvisories: AttributedAdvisory[];
  remaining: RemainingVulnerability[];
}

function advisoryKey(advisory: Advisory, flaggedPackage: string): string {
  return `${String(advisory.id)}::${flaggedPackage}`;
}

/**
 * Re-walks a `path` (chain of package names from the direct dependency down
 * to the flagged package, as recorded by attribution.ts's own BFS) against a
 * *different* graph, to find the version actually resolved there. `path`
 * names a route, not a graph-specific node id, so this must be re-derived
 * rather than looked up directly — the same rule attribution.ts follows.
 */
function resolveNodeAlongPath(graph: DependencyGraph, path: readonly string[]): DependencyNode | null {
  const [rootName, ...rest] = path;
  if (rootName === undefined) return null;
  let current = directNodes(graph).find((node) => node.name === rootName) ?? null;
  if (current === null) return null;
  for (const name of rest) {
    current = resolveDependency(graph, current.path, name, ['runtime', 'optional']);
    if (current === null) return null;
  }
  return current;
}

function overallStatus(remaining: readonly RemainingVulnerability[]): SecurityOutcomeStatus {
  if (remaining.some((r) => r.status === 'remains')) return 'remains';
  if (remaining.some((r) => r.status === 'unknown')) return 'unknown';
  return 'resolved';
}

export interface EvaluateSecurityOutcomeOptions {
  /** This row's attributed advisories before the upgrade — i.e. `PackageRow.advisories`. */
  before: readonly AttributedAdvisory[];
  /** The direct dependency's own proposed version — used only for the direct (path.length === 1) deterministic check. */
  targetVersion: string;
  rootPackageName: string;
  /**
   * A materialized post-upgrade dependency graph from the isolated resolver,
   * when available — see src/host/resolverVerifier.ts. `'no-resolver-evidence'`
   * when that step wasn't run or failed; transitive advisories then resolve to
   * `unknown` rather than being guessed at.
   */
  after: { graph: DependencyGraph; advisoriesByName: AdvisoriesByName } | 'no-resolver-evidence';
}

export function evaluateSecurityOutcome(options: EvaluateSecurityOutcomeOptions): SecurityOutcome {
  const { before, targetVersion, rootPackageName, after } = options;

  if (before.length === 0) {
    return { status: 'not-applicable', resolvedAdvisories: [], remaining: [] };
  }

  if (after === 'no-resolver-evidence') {
    const remaining: RemainingVulnerability[] = [];
    const resolvedAdvisories: AttributedAdvisory[] = [];

    for (const entry of before) {
      if (entry.path.length > 1) {
        // Transitive — cannot be determined without resolver evidence.
        remaining.push({
          advisory: entry.advisory,
          flaggedPackage: entry.flaggedPackage,
          path: entry.path,
          status: 'unknown',
          resolvedVersion: null,
          patchedVersion: entry.patchedVersion,
        });
        continue;
      }

      // Direct: the flagged package IS the package being upgraded, so its
      // resulting version is exactly `targetVersion` — a deterministic range
      // check, no resolver needed.
      let stillVulnerable: boolean;
      try {
        stillVulnerable = semver.satisfies(targetVersion, entry.advisory.vulnerableVersions, {
          includePrerelease: true,
        });
      } catch {
        stillVulnerable = true; // Malformed range: can't prove a fix, don't claim one.
      }

      if (stillVulnerable) {
        remaining.push({
          advisory: entry.advisory,
          flaggedPackage: entry.flaggedPackage,
          path: entry.path,
          status: 'remains',
          resolvedVersion: targetVersion,
          patchedVersion: entry.patchedVersion,
        });
      } else {
        resolvedAdvisories.push(entry);
      }
    }

    return { status: overallStatus(remaining), resolvedAdvisories, remaining };
  }

  // Resolver evidence available: re-attribute against the real, materialized
  // post-upgrade tree and diff by (advisory id, flagged package).
  const afterAttributed = attributeAdvisories(after.graph, after.advisoriesByName).get(rootPackageName) ?? [];
  const afterByKey = new Map(afterAttributed.map((entry) => [advisoryKey(entry.advisory, entry.flaggedPackage), entry]));

  const remaining: RemainingVulnerability[] = [];
  const resolvedAdvisories: AttributedAdvisory[] = [];

  for (const entry of before) {
    const stillPresent = afterByKey.get(advisoryKey(entry.advisory, entry.flaggedPackage));
    if (stillPresent === undefined) {
      resolvedAdvisories.push(entry);
      continue;
    }
    const resolvedNode = resolveNodeAlongPath(after.graph, stillPresent.path);
    remaining.push({
      advisory: entry.advisory,
      flaggedPackage: entry.flaggedPackage,
      path: stillPresent.path,
      status: 'remains',
      resolvedVersion: resolvedNode?.version ?? null,
      patchedVersion: entry.patchedVersion,
    });
  }

  return { status: overallStatus(remaining), resolvedAdvisories, remaining };
}
