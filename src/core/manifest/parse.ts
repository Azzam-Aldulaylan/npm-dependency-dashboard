/**
 * package.json parsing and dependency-specifier classification.
 *
 * The classification here decides which packages ever reach the registry. A
 * specifier like `file:../local` or `git+ssh://…` has no registry entry, so
 * fetching it would produce a guaranteed 404 that reads as an error to the user
 * when it is really a normal, healthy dependency. Spec: those are *tagged*, not
 * errored, and they never enter the fetch pool.
 *
 * Prototype-pollution note: parsed JSON is only ever read with Object.hasOwn and
 * copied key-by-key into fresh objects. Nothing here deep-merges parsed input.
 */

import type { PackageManagerKind, UnresolvableReason } from '../types.js';

export interface PackageManagerDeclaration {
  name: PackageManagerKind;
  /** The unmodified version portion after `npm@`/`pnpm@`, or null when absent. */
  version: string | null;
}

export interface DeclaredDependency {
  name: string;
  /** The raw specifier as written in package.json, e.g. "^18.2.0" or "file:../x". */
  range: string;
  dev: boolean;
  optional: boolean;
  /** Set when the specifier can never resolve against a registry. */
  unresolvable?: UnresolvableReason;
  /** For `npm:` aliases, the real package name the alias points at. */
  aliasTarget?: string;
}

export interface Manifest {
  name: string | null;
  version: string | null;
  /** Declared workspace globs, when this manifest is an npm-workspaces root. */
  workspaces: string[];
  /** A recognized package.json `packageManager` declaration. */
  packageManager: PackageManagerDeclaration | null;
  dependencies: DeclaredDependency[];
}

function readPackageManager(value: unknown): PackageManagerDeclaration | null {
  if (typeof value !== 'string') return null;
  const match = /^(npm|pnpm)(?:@(.+))?$/.exec(value.trim());
  if (match === null) return null;
  const name = match[1];
  if (name !== 'npm' && name !== 'pnpm') return null;
  return { name, version: match[2] ?? null };
}

/** Shorthand GitHub form, e.g. "user/repo" or "user/repo#semver:^1.0.0". */
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+(?:#.*)?$/;

const GIT_PREFIXES = [
  'git:',
  'git+ssh:',
  'git+https:',
  'git+http:',
  'git+file:',
  'github:',
  'gitlab:',
  'bitbucket:',
];

/**
 * Classify a dependency specifier.
 *
 * Returns undefined for ordinary registry ranges (`^1.0.0`, `~2`, `*`, `latest`,
 * `1.x`, or ""), which are the only ones that get a registry lookup.
 */
export function classifySpecifier(spec: string): {
  unresolvable?: UnresolvableReason;
  aliasTarget?: string;
} {
  const value = spec.trim();

  if (value.startsWith('file:')) return { unresolvable: 'file' };
  if (value.startsWith('link:')) return { unresolvable: 'workspace-link' };
  if (value.startsWith('workspace:')) return { unresolvable: 'workspace-link' };

  for (const prefix of GIT_PREFIXES) {
    if (value.startsWith(prefix)) return { unresolvable: 'git' };
  }

  if (value.startsWith('npm:')) {
    // "npm:real-package@^1.0.0" — the alias target is a real registry package,
    // so we keep its name for the caller. Scoped targets keep their leading @.
    const rest = value.slice('npm:'.length);
    const at = rest.lastIndexOf('@');
    const target = at > 0 ? rest.slice(0, at) : rest;
    return target === ''
      ? { unresolvable: 'alias' }
      : { unresolvable: 'alias', aliasTarget: target };
  }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    return { unresolvable: 'tarball' };
  }

  // Bare "user/repo" is GitHub shorthand. Guard against swallowing scoped
  // package names (@scope/name is not a specifier) and path-like values.
  if (
    !value.startsWith('@') &&
    !value.startsWith('.') &&
    !value.startsWith('/') &&
    GITHUB_SHORTHAND.test(value)
  ) {
    return { unresolvable: 'git' };
  }

  return {};
}

function readDepBlock(
  source: unknown,
  dev: boolean,
  optional: boolean,
  into: Map<string, DeclaredDependency>
): void {
  if (typeof source !== 'object' || source === null) return;

  for (const key of Object.keys(source)) {
    // Never let __proto__/constructor keys from parsed JSON become entries.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Object.hasOwn(source, key)) continue;

    const raw = (source as Record<string, unknown>)[key];
    const range = typeof raw === 'string' ? raw : '';
    const { unresolvable, aliasTarget } = classifySpecifier(range);

    const entry: DeclaredDependency = { name: key, range, dev, optional };
    if (unresolvable !== undefined) entry.unresolvable = unresolvable;
    if (aliasTarget !== undefined) entry.aliasTarget = aliasTarget;

    // dependencies wins over devDependencies when a name appears in both,
    // matching npm's own precedence.
    const existing = into.get(key);
    if (existing === undefined || (existing.dev && !dev)) {
      into.set(key, entry);
    }
  }
}

function readWorkspaces(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  // The object form: { "packages": ["packages/*"], "nohoist": [...] }
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'packages')) {
    const packages = (value as Record<string, unknown>)['packages'];
    if (Array.isArray(packages)) {
      return packages.filter((v): v is string => typeof v === 'string');
    }
  }
  return [];
}

/**
 * Parse raw package.json text.
 *
 * Throws only on invalid JSON. A structurally odd but parseable manifest yields
 * an empty dependency list rather than an exception — one malformed manifest in
 * a monorepo must not take down the scan.
 */
export function parseManifest(contents: string): Manifest {
  const json: unknown = JSON.parse(contents);
  if (typeof json !== 'object' || json === null) {
    return { name: null, version: null, workspaces: [], packageManager: null, dependencies: [] };
  }

  const obj = json as Record<string, unknown>;
  const deps = new Map<string, DeclaredDependency>();

  // Read dev first so the prod pass can override it.
  readDepBlock(obj['devDependencies'], true, false, deps);
  readDepBlock(obj['optionalDependencies'], false, true, deps);
  readDepBlock(obj['dependencies'], false, false, deps);

  return {
    name: typeof obj['name'] === 'string' ? obj['name'] : null,
    version: typeof obj['version'] === 'string' ? obj['version'] : null,
    workspaces: readWorkspaces(obj['workspaces']),
    packageManager: readPackageManager(obj['packageManager']),
    dependencies: [...deps.values()],
  };
}
