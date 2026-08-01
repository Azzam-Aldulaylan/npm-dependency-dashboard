/**
 * package-lock.json / npm-shrinkwrap.json parsing into a normalized graph.
 *
 * Three on-disk shapes exist and they are not interchangeable:
 *   v1  only `dependencies` — a nested tree mirroring node_modules
 *   v2  both `dependencies` and `packages` — `packages` is authoritative
 *   v3  only `packages` — a flat map keyed by install path
 *
 * `packages` is the primary parse path (spec). v1's nested `dependencies` tree
 * is supported for older projects. An unrecognized lockfileVersion is a hard
 * failure, not a guess: silently mis-parsing a lockfile produces confidently
 * wrong "current version" numbers, which is worse than an error because the
 * user acts on them.
 *
 * Nodes are keyed by install path, not by name — a package legitimately appears
 * at several versions in one tree (e.g. node_modules/semver alongside
 * node_modules/x/node_modules/semver), and collapsing those loses the
 * distinction that vulnerability attribution depends on.
 */

import type { DependencyGraph, DependencyNode } from '../types.js';
import type { Manifest } from '../manifest/parse.js';

const NODE_MODULES = 'node_modules/';

export class UnsupportedLockfileError extends Error {
  readonly lockfileVersion: unknown;
  constructor(lockfileVersion: unknown) {
    super(
      `Unsupported lockfileVersion: ${JSON.stringify(lockfileVersion)}. ` +
        `Supported: 1, 2, 3.`
    );
    this.name = 'UnsupportedLockfileError';
    this.lockfileVersion = lockfileVersion;
  }
}

/**
 * Extract the package name from a `packages` key.
 *
 * "node_modules/react"                          -> react
 * "node_modules/@scope/pkg"                     -> @scope/pkg
 * "node_modules/a/node_modules/b"               -> b
 * "packages/app"  (workspace member, not a dep) -> null
 * ""              (the root project)            -> null
 */
export function nameFromPackageKey(key: string): string | null {
  const idx = key.lastIndexOf(NODE_MODULES);
  if (idx === -1) return null;
  const name = key.slice(idx + NODE_MODULES.length);
  return name === '' ? null : name;
}

function edgeNames(entry: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const field of ['dependencies', 'optionalDependencies']) {
    const block = entry[field];
    if (typeof block === 'object' && block !== null) {
      for (const k of Object.keys(block)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out.add(k);
      }
    }
  }
  return [...out];
}

/** v1: `requires` holds the edge names instead of `dependencies`. */
function edgeNamesV1(entry: Record<string, unknown>): string[] {
  const requires = entry['requires'];
  if (typeof requires !== 'object' || requires === null) return [];
  return Object.keys(requires).filter(
    (k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype'
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse the modern `packages` map (lockfileVersion 2 and 3).
 */
function parsePackages(
  packages: Record<string, unknown>,
  declaredRanges: Map<string, string>
): Map<string, DependencyNode> {
  const nodes = new Map<string, DependencyNode>();

  for (const key of Object.keys(packages)) {
    if (key === '') continue; // the root project itself
    const entry = asRecord(packages[key]);
    if (entry === null) continue;

    const name = nameFromPackageKey(key);
    // A key without node_modules/ is a workspace member directory
    // (e.g. "packages/app"). It is a project, not a dependency node — its
    // node_modules/<name> counterpart carries "link": true and is what the
    // dependents actually resolve to.
    if (name === null) continue;

    const isLink = entry['link'] === true;
    const version = typeof entry['version'] === 'string' ? entry['version'] : null;

    const node: DependencyNode = {
      name,
      version: isLink ? null : version,
      range: declaredRanges.get(name) ?? '',
      dev: entry['dev'] === true || entry['devOptional'] === true,
      direct: key === `${NODE_MODULES}${name}` && declaredRanges.has(name),
      path: key,
      deps: edgeNames(entry),
    };

    // Spec: a workspace-linked package has no registry entry. Tag it and skip
    // the lookup rather than erroring.
    if (isLink) node.unresolvable = 'workspace-link';

    nodes.set(key, node);
  }

  return nodes;
}

/**
 * Parse the legacy nested `dependencies` tree (lockfileVersion 1).
 */
function parseV1Dependencies(
  dependencies: Record<string, unknown>,
  declaredRanges: Map<string, string>
): Map<string, DependencyNode> {
  const nodes = new Map<string, DependencyNode>();

  const walk = (block: Record<string, unknown>, prefix: string): void => {
    for (const name of Object.keys(block)) {
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
      const entry = asRecord(block[name]);
      if (entry === null) continue;

      const path = `${prefix}${NODE_MODULES}${name}`;
      const version = typeof entry['version'] === 'string' ? entry['version'] : null;

      const node: DependencyNode = {
        name,
        version,
        range: declaredRanges.get(name) ?? '',
        dev: entry['dev'] === true,
        direct: prefix === '' && declaredRanges.has(name),
        path,
        deps: edgeNamesV1(entry),
      };

      // v1 has no "link" flag; a workspace member shows up as a relative
      // "version" like "file:packages/app".
      if (version !== null && version.startsWith('file:')) {
        node.version = null;
        node.unresolvable = 'workspace-link';
      }

      nodes.set(path, node);

      const nested = asRecord(entry['dependencies']);
      if (nested !== null) walk(nested, `${path}/`);
    }
  };

  walk(dependencies, '');
  return nodes;
}

export interface BuildGraphOptions {
  /** Absolute path to the directory holding package.json. */
  root: string;
  manifest: Manifest;
  /** Raw lockfile text, or null when no lockfile exists. */
  lockfileText: string | null;
}

/**
 * Build the normalized graph.
 *
 * With no lockfile, every declared dependency still becomes a node — with a
 * null version and the 'no-lockfile' tag — so the table renders ranges rather
 * than nothing.
 */
export function buildGraph(options: BuildGraphOptions): DependencyGraph {
  const { root, manifest, lockfileText } = options;

  const declaredRanges = new Map<string, string>();
  for (const dep of manifest.dependencies) {
    declaredRanges.set(dep.name, dep.range);
  }

  if (lockfileText === null) {
    const nodes = new Map<string, DependencyNode>();
    for (const dep of manifest.dependencies) {
      const node: DependencyNode = {
        name: dep.name,
        version: null,
        range: dep.range,
        dev: dep.dev,
        direct: true,
        path: `${NODE_MODULES}${dep.name}`,
        deps: [],
        // A non-registry specifier keeps its own, more specific reason.
        unresolvable: dep.unresolvable ?? 'no-lockfile',
      };
      nodes.set(node.path, node);
    }
    return { root, lockfileVersion: null, nodes };
  }

  const json: unknown = JSON.parse(lockfileText);
  const lock = asRecord(json);
  if (lock === null) throw new UnsupportedLockfileError(undefined);

  const rawVersion = lock['lockfileVersion'];
  if (rawVersion !== 1 && rawVersion !== 2 && rawVersion !== 3) {
    throw new UnsupportedLockfileError(rawVersion);
  }
  const lockfileVersion: 1 | 2 | 3 = rawVersion;

  const packages = asRecord(lock['packages']);
  const dependencies = asRecord(lock['dependencies']);

  let nodes: Map<string, DependencyNode>;
  if (packages !== null) {
    // v2 and v3. For v2 this deliberately ignores the legacy `dependencies`
    // mirror, which exists only for old npm clients.
    nodes = parsePackages(packages, declaredRanges);
  } else if (dependencies !== null) {
    nodes = parseV1Dependencies(dependencies, declaredRanges);
  } else {
    nodes = new Map();
  }

  // Carry manifest-level specifier tags onto their resolved nodes, and make
  // sure every declared dependency has a row even if the lockfile lacks it.
  for (const dep of manifest.dependencies) {
    const path = `${NODE_MODULES}${dep.name}`;
    const existing = nodes.get(path);
    if (existing === undefined) {
      const node: DependencyNode = {
        name: dep.name,
        version: null,
        range: dep.range,
        dev: dep.dev,
        direct: true,
        path,
        deps: [],
      };
      if (dep.unresolvable !== undefined) node.unresolvable = dep.unresolvable;
      nodes.set(path, node);
      continue;
    }
    existing.direct = true;
    existing.range = dep.range;
    // The lockfile's "link": true is the stronger signal — don't overwrite it
    // with a weaker manifest-derived tag.
    if (dep.unresolvable !== undefined && existing.unresolvable === undefined) {
      existing.unresolvable = dep.unresolvable;
    }
  }

  return { root, lockfileVersion, nodes };
}

/**
 * Resolve which node satisfies `name` as seen from `fromPath`, following npm's
 * lookup rule: check the dependent's own node_modules, then walk up.
 */
export function resolveFrom(
  graph: DependencyGraph,
  fromPath: string,
  name: string
): DependencyNode | null {
  let prefix = fromPath === '' ? '' : `${fromPath}/`;
  for (;;) {
    const candidate = graph.nodes.get(`${prefix}${NODE_MODULES}${name}`);
    if (candidate !== undefined) return candidate;
    if (prefix === '') return null;
    // Strip the last "<segment>/node_modules/<pkg>/" level and retry.
    const trimmed = prefix.slice(0, -1);
    const idx = trimmed.lastIndexOf(`${NODE_MODULES}`);
    if (idx === -1) return null;
    prefix = trimmed.slice(0, idx);
  }
}

/** Direct dependencies, in declaration order of the manifest. */
export function directNodes(graph: DependencyGraph): DependencyNode[] {
  return [...graph.nodes.values()].filter((n) => n.direct);
}
