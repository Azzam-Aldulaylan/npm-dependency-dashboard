/**
 * Pure construction of a package.json used for a mixed-classification
 * coordinated upgrade. The host supplies only planner/controller-owned exact
 * versions; the transaction layer owns writing these bytes with compare-and-
 * swap protection before one package-manager reconciliation install.
 */

import {
  isSafeNpmPackageName,
  isSafeSemverVersion,
  type DependencyClassification,
} from './plan.js';

export interface StagedManifestChange {
  packageName: string;
  target: string;
  classification: DependencyClassification;
}

export interface StagedManifestRemoval {
  packageName: string;
  classification: DependencyClassification;
}

export type StagedManifestErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_CHANGE'
  | 'DUPLICATE_CHANGE'
  | 'MISSING_DECLARATION';

export class StagedManifestError extends Error {
  constructor(
    readonly code: StagedManifestErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'StagedManifestError';
  }
}

const BLOCK_BY_CLASSIFICATION: Record<DependencyClassification, string> = {
  prod: 'dependencies',
  dev: 'devDependencies',
  optional: 'optionalDependencies',
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoot(contents: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new StagedManifestError('INVALID_MANIFEST', 'package.json is not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new StagedManifestError('INVALID_MANIFEST', 'package.json must contain a JSON object.');
  }
  return parsed;
}

function dependencyBlock(root: Record<string, unknown>, name: string): Record<string, unknown> | null {
  if (!Object.hasOwn(root, name)) return null;
  const block = root[name];
  if (!isRecord(block)) {
    throw new StagedManifestError('INVALID_MANIFEST', `${name} must be a JSON object.`);
  }
  return block;
}

function indentation(contents: string): string | number | undefined {
  const match = /^(\s+)(?="(?:name|version|private|type|scripts|dependencies|devDependencies|optionalDependencies|peerDependencies|packageManager|workspaces)"\s*:)/m.exec(contents);
  if (match === null) return undefined;
  const whitespace = match[1]?.replace(/[\r\n]/g, '') ?? '';
  return whitespace.length === 0 ? undefined : whitespace;
}

function stringifyLikeSource(root: Record<string, unknown>, source: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = /(?:\r\n|\n)$/.test(source);
  const formatted = JSON.stringify(root, null, indentation(source));
  const normalized = newline === '\n' ? formatted : formatted.replace(/\n/g, newline);
  return finalNewline ? `${normalized}${newline}` : normalized;
}

/**
 * Return manifest text with exact planned versions in their existing blocks.
 * No dependency is added, moved, or removed. If a package also appears in a
 * shadowed block, only the host-asserted authoritative classification is
 * updated, matching manifest parsing's existing precedence behavior.
 */
export function buildStagedManifest(
  contents: string,
  changes: readonly StagedManifestChange[]
): string {
  if (changes.length === 0) {
    throw new StagedManifestError('INVALID_CHANGE', 'At least one coordinated manifest change is required.');
  }

  const root = parseRoot(contents);
  const seen = new Set<string>();

  for (const change of changes) {
    if (
      FORBIDDEN_KEYS.has(change.packageName) ||
      !isSafeNpmPackageName(change.packageName) ||
      !isSafeSemverVersion(change.target)
    ) {
      throw new StagedManifestError('INVALID_CHANGE', 'A coordinated manifest change is not a safe exact package version.');
    }
    if (seen.has(change.packageName)) {
      throw new StagedManifestError('DUPLICATE_CHANGE', `Duplicate coordinated change for ${change.packageName}.`);
    }
    seen.add(change.packageName);

    const expectedBlock = BLOCK_BY_CLASSIFICATION[change.classification];
    const block = dependencyBlock(root, expectedBlock);
    if (
      block === null ||
      !Object.hasOwn(block, change.packageName) ||
      typeof block[change.packageName] !== 'string'
    ) {
      throw new StagedManifestError(
        'MISSING_DECLARATION',
        `${change.packageName} is not a string declaration in ${expectedBlock}.`
      );
    }
    block[change.packageName] = change.target;
  }

  return stringifyLikeSource(root, contents);
}

/**
 * Return manifest text with the given declared dependencies deleted from
 * their existing blocks. Nothing is added or modified — every sibling
 * dependency in the same block, and every other key in the manifest, is
 * left exactly as written; only the removed packages' own key/value pairs
 * disappear.
 */
export function buildStagedManifestForRemoval(
  contents: string,
  removals: readonly StagedManifestRemoval[]
): string {
  if (removals.length === 0) {
    throw new StagedManifestError('INVALID_CHANGE', 'At least one dependency to remove is required.');
  }

  const root = parseRoot(contents);
  const seen = new Set<string>();

  for (const removal of removals) {
    if (FORBIDDEN_KEYS.has(removal.packageName) || !isSafeNpmPackageName(removal.packageName)) {
      throw new StagedManifestError('INVALID_CHANGE', 'A dependency to remove is not a safe package name.');
    }
    if (seen.has(removal.packageName)) {
      throw new StagedManifestError('DUPLICATE_CHANGE', `Duplicate removal for ${removal.packageName}.`);
    }
    seen.add(removal.packageName);

    const expectedBlock = BLOCK_BY_CLASSIFICATION[removal.classification];
    const block = dependencyBlock(root, expectedBlock);
    if (
      block === null ||
      !Object.hasOwn(block, removal.packageName) ||
      typeof block[removal.packageName] !== 'string'
    ) {
      throw new StagedManifestError(
        'MISSING_DECLARATION',
        `${removal.packageName} is not a string declaration in ${expectedBlock}.`
      );
    }
    delete block[removal.packageName];
  }

  return stringifyLikeSource(root, contents);
}
