/** pnpm-lock.yaml v9 parsing into the shared normalized dependency graph. */

import { load as loadYaml } from 'js-yaml';
import semver from 'semver';

import type { DependencyEdge, DependencyGraph, DependencyNode } from '../types.js';
import type { DeclaredDependency, Manifest } from '../manifest/parse.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeEntries(record: Record<string, unknown> | null): Array<[string, unknown]> {
  return record === null
    ? []
    : Object.entries(record).filter(([key]) => !FORBIDDEN_KEYS.has(key));
}

export class UnsupportedPnpmLockfileError extends Error {
  readonly lockfileVersion: unknown;

  constructor(lockfileVersion: unknown) {
    super(`Unsupported pnpm lockfileVersion: ${JSON.stringify(lockfileVersion)}. Supported: 9.0.`);
    this.name = 'UnsupportedPnpmLockfileError';
    this.lockfileVersion = lockfileVersion;
  }
}

export interface BuildPnpmGraphOptions {
  root: string;
  manifest: Manifest;
  lockfileText: string | null;
  /** pnpm importer key relative to the directory containing pnpm-lock.yaml. */
  importerId?: string;
}

function normalizeImporterId(value: string | undefined): string {
  const normalized = (value ?? '.').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

function emptyDirectNode(dep: DeclaredDependency, importerId: string): DependencyNode {
  const node: DependencyNode = {
    name: dep.name,
    version: null,
    range: dep.range,
    dev: dep.dev,
    direct: true,
    path: `pnpm:importer:${importerId}:${dep.name}`,
    deps: [],
    edges: [],
  };
  if (dep.unresolvable !== undefined) node.unresolvable = dep.unresolvable;
  return node;
}

function buildWithoutLockfile(root: string, manifest: Manifest, importerId: string): DependencyGraph {
  const nodes = new Map<string, DependencyNode>();
  for (const dep of manifest.dependencies) {
    const node = emptyDirectNode(dep, importerId);
    node.unresolvable ??= 'no-lockfile';
    nodes.set(node.path, node);
  }
  return { root, packageManager: 'pnpm', lockfileVersion: null, nodes };
}

function stripPeerContext(value: string): string {
  const index = value.indexOf('(');
  return index === -1 ? value : value.slice(0, index);
}

function packageIdentity(
  rawKey: string,
  metadata: Record<string, unknown> | null
): { name: string; version: string } | null {
  const explicitName = metadata?.['name'];
  const explicitVersion = metadata?.['version'];
  if (typeof explicitName === 'string' && typeof explicitVersion === 'string') {
    return { name: explicitName, version: explicitVersion };
  }

  const key = stripPeerContext(rawKey.replace(/^\//, ''));
  const separator = key.lastIndexOf('@');
  if (separator <= 0 || separator === key.length - 1) return null;
  return { name: key.slice(0, separator), version: key.slice(separator + 1) };
}

function peerOptional(metadata: Record<string, unknown>, name: string): boolean {
  const meta = asRecord(metadata['peerDependenciesMeta']);
  const peer = meta === null ? null : asRecord(meta[name]);
  return peer?.['optional'] === true;
}

function addEdges(
  into: Map<string, DependencyEdge>,
  block: Record<string, unknown> | null,
  kind: DependencyEdge['kind'],
  optional: boolean
): void {
  for (const [name, raw] of safeEntries(block)) {
    if (kind === 'optional') into.delete(`runtime:${name}`);
    into.set(`${kind}:${name}`, {
      name,
      requestedRange: typeof raw === 'string' ? raw : '',
      kind,
      targetNodeId: null,
      optional,
    });
  }
}

function nodeEdges(
  snapshot: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null
): DependencyEdge[] {
  const edges = new Map<string, DependencyEdge>();
  addEdges(edges, asRecord(snapshot?.['dependencies']), 'runtime', false);
  addEdges(edges, asRecord(snapshot?.['optionalDependencies']), 'optional', true);

  const peers = asRecord(metadata?.['peerDependencies']);
  for (const [name, range] of safeEntries(peers)) {
    edges.set(`peer:${name}`, {
      name,
      requestedRange: typeof range === 'string' ? range : '',
      kind: 'peer',
      targetNodeId: null,
      optional: metadata === null ? false : peerOptional(metadata, name),
    });
  }
  return [...edges.values()];
}

function importerReference(raw: unknown): { specifier: string; version: string } | null {
  if (typeof raw === 'string') return { specifier: raw, version: raw };
  const entry = asRecord(raw);
  if (entry === null) return null;
  const version = entry['version'];
  if (typeof version !== 'string') return null;
  return {
    specifier: typeof entry['specifier'] === 'string' ? entry['specifier'] : '',
    version,
  };
}

function packageReferenceCandidates(name: string, reference: string): string[] {
  if (
    reference.startsWith('link:') ||
    reference.startsWith('workspace:') ||
    reference.startsWith('file:')
  ) {
    return [];
  }

  let actualName = name;
  let actualReference = reference.replace(/^\//, '');
  if (actualReference.startsWith('npm:')) {
    const alias = actualReference.slice('npm:'.length);
    const separator = stripPeerContext(alias).lastIndexOf('@');
    if (separator > 0) {
      actualName = alias.slice(0, separator);
      actualReference = alias.slice(separator + 1);
    }
  }

  const values = [
    `${actualName}@${actualReference}`,
    actualReference.startsWith(`${actualName}@`) ? actualReference : '',
  ].filter((value) => value !== '');
  return [...new Set(values)];
}

function resolveReference(
  idsByLockKey: ReadonlyMap<string, string>,
  name: string,
  reference: string
): string | null {
  for (const candidate of packageReferenceCandidates(name, reference)) {
    const found = idsByLockKey.get(candidate) ?? idsByLockKey.get(candidate.replace(/^\//, ''));
    if (found !== undefined) return found;
  }
  return null;
}

function resolvePeerTarget(
  graph: DependencyGraph,
  node: DependencyNode,
  edge: DependencyEdge,
  directTargets: ReadonlyMap<string, string>
): string | null {
  const direct = directTargets.get(edge.name);
  if (direct !== undefined) {
    const target = graph.nodes.get(direct);
    if (
      target !== undefined &&
      target.version !== null &&
      (edge.requestedRange === '' || semver.satisfies(target.version, edge.requestedRange, { includePrerelease: true }))
    ) {
      return direct;
    }
  }

  const candidates = [...graph.nodes.values()].filter((candidate) => {
    if (candidate.name !== edge.name || candidate.version === null) return false;
    if (edge.requestedRange !== '' && !semver.satisfies(candidate.version, edge.requestedRange, { includePrerelease: true })) {
      return false;
    }
    return node.path.includes(`${candidate.name}@${candidate.version}`);
  });
  return candidates.length === 1 ? candidates[0]?.path ?? null : null;
}

export function buildPnpmGraph(options: BuildPnpmGraphOptions): DependencyGraph {
  const importerId = normalizeImporterId(options.importerId);
  if (options.lockfileText === null) return buildWithoutLockfile(options.root, options.manifest, importerId);

  const parsed = loadYaml(options.lockfileText, { json: true });
  const lock = asRecord(parsed);
  const rawVersion = lock?.['lockfileVersion'];
  if (lock === null || !/^9(?:\.0)?$/.test(String(rawVersion))) {
    throw new UnsupportedPnpmLockfileError(rawVersion);
  }

  const packages = asRecord(lock['packages']);
  const snapshots = asRecord(lock['snapshots']);
  const nodes = new Map<string, DependencyNode>();
  const idsByLockKey = new Map<string, string>();
  const snapshotKeys = safeEntries(snapshots).map(([key]) => key);
  const snapshotBases = new Set(snapshotKeys.map(stripPeerContext));
  const packageOnlyKeys = safeEntries(packages)
    .map(([key]) => key)
    .filter((key) => !snapshotBases.has(key));
  const allKeys = new Set([...snapshotKeys, ...packageOnlyKeys]);

  for (const key of allKeys) {
    const metadata = packages === null
      ? null
      : (asRecord(packages[key]) ?? asRecord(packages[stripPeerContext(key)]));
    const snapshot = snapshots === null ? null : asRecord(snapshots[key]);
    const identity = packageIdentity(key, metadata);
    if (identity === null) continue;
    const path = `pnpm:${key}`;
    const edges = nodeEdges(snapshot, metadata);
    const node: DependencyNode = {
      name: identity.name,
      version: identity.version,
      range: '',
      dev: false,
      direct: false,
      path,
      deps: edges.filter((edge) => edge.kind !== 'peer').map((edge) => edge.name),
      edges,
    };
    nodes.set(path, node);
    idsByLockKey.set(key, path);
    idsByLockKey.set(key.replace(/^\//, ''), path);
  }

  const graph: DependencyGraph = {
    root: options.root,
    packageManager: 'pnpm',
    lockfileVersion: String(rawVersion),
    nodes,
  };

  // Resolve package snapshot dependency references first.
  for (const [key, rawSnapshot] of safeEntries(snapshots)) {
    const node = nodes.get(idsByLockKey.get(key) ?? '');
    const snapshot = asRecord(rawSnapshot);
    if (node === undefined || snapshot === null) continue;
    const references = new Map<string, string>();
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, raw] of safeEntries(asRecord(snapshot[field]))) {
        if (typeof raw === 'string') references.set(name, raw);
      }
    }
    node.edges = node.edges.map((edge) =>
      edge.kind === 'peer'
        ? edge
        : { ...edge, targetNodeId: resolveReference(idsByLockKey, edge.name, references.get(edge.name) ?? '') }
    );
  }

  const importer = asRecord(asRecord(lock['importers'])?.[importerId]);
  const directTargets = new Map<string, string>();
  const manifestByName = new Map(options.manifest.dependencies.map((dep) => [dep.name, dep]));
  const importerBlocks = [
    'dependencies',
    'optionalDependencies',
    'devDependencies',
  ];

  for (const field of importerBlocks) {
    for (const [name, raw] of safeEntries(asRecord(importer?.[field]))) {
      const reference = importerReference(raw);
      if (reference === null) continue;
      const declared = manifestByName.get(name);
      // The manifest is authoritative for which packages are direct. An old
      // importer entry left behind by lockfile drift must not create a row.
      if (declared === undefined) continue;
      if (declared.unresolvable !== undefined) {
        const synthetic = emptyDirectNode(declared, importerId);
        nodes.set(synthetic.path, synthetic);
        continue;
      }
      const targetId = resolveReference(idsByLockKey, name, reference.version);
      if (targetId !== null) {
        const target = nodes.get(targetId);
        if (target !== undefined) {
          target.direct = true;
          target.dev = declared.dev;
          target.range = declared.range;
          directTargets.set(name, targetId);
          continue;
        }
      }
      if (!nodes.has(`pnpm:importer:${importerId}:${name}`)) {
        const synthetic = emptyDirectNode(declared, importerId);
        if (reference.version.startsWith('link:') || reference.specifier.startsWith('workspace:')) {
          synthetic.unresolvable = 'workspace-link';
        }
        nodes.set(synthetic.path, synthetic);
      }
    }
  }

  // A drifted lockfile still gets a row for every manifest declaration.
  for (const declared of options.manifest.dependencies) {
    if ([...nodes.values()].some((node) => node.direct && node.name === declared.name)) continue;
    const synthetic = emptyDirectNode(declared, importerId);
    nodes.set(synthetic.path, synthetic);
  }

  for (const node of nodes.values()) {
    node.edges = node.edges.map((edge) =>
      edge.kind === 'peer'
        ? { ...edge, targetNodeId: resolvePeerTarget(graph, node, edge, directTargets) }
        : edge
    );
  }

  return graph;
}
