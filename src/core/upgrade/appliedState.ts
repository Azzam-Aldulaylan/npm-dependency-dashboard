import type { UpgradeChange } from '../compatibility/types.js';
import { load as loadYaml } from 'js-yaml';
import semver from 'semver';
import { buildDependencyGraph } from '../lockfile/build.js';
import { directNodes } from '../lockfile/parse.js';
import { parseManifest } from '../manifest/parse.js';
import type { PackageManagerKind } from '../types.js';
import type { DependencyClassification } from './plan.js';

export interface AppliedUpgradeProjectSnapshot {
  root: string;
  manifestText: string;
  lockfileText: string | null;
  packageManager: PackageManagerKind;
  importerId: string;
}

export interface AppliedUpgradeLocalChange {
  packageName: string;
  previousVersion: string;
  requestedVersion: string;
  currentVersion: string | null;
  declaredRange: string | null;
  classification: DependencyClassification | null;
}

export interface AppliedUpgradeState {
  confirmed: boolean;
  changes: AppliedUpgradeLocalChange[];
}

function classificationOf(dependency: {
  dev: boolean;
  optional: boolean;
}): DependencyClassification {
  if (dependency.optional) return 'optional';
  return dependency.dev ? 'dev' : 'prod';
}

/**
 * Confirmation needs stronger evidence than "package.json still has a key".
 * The declaration must be an ordinary registry semver range and must admit
 * the exact version the active lockfile resolved. Tags and non-registry
 * specifiers cannot prove that relationship locally and are rejected.
 */
function declarationAdmitsTarget(
  declaration: { range: string; unresolvable?: unknown },
  targetVersion: string
): boolean {
  const range = declaration.range.trim();
  return (
    range.length > 0 &&
    declaration.unresolvable === undefined &&
    semver.valid(targetVersion) !== null &&
    semver.validRange(range) !== null &&
    semver.satisfies(targetVersion, range, { includePrerelease: true })
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ownValue(record: Record<string, unknown> | null, key: string): unknown {
  return record !== null && Object.hasOwn(record, key) ? record[key] : undefined;
}

function lockfileBlockForClassification(classification: DependencyClassification): string {
  if (classification === 'dev') return 'devDependencies';
  if (classification === 'optional') return 'optionalDependencies';
  return 'dependencies';
}

function rangeAdmitsTarget(range: unknown, targetVersion: string): boolean {
  if (typeof range !== 'string' || range.trim() === '') return false;
  return (
    semver.validRange(range) !== null &&
    semver.satisfies(targetVersion, range, { includePrerelease: true })
  );
}

interface DirectLockEvidence {
  importerDeclared: boolean;
  resolvedVersion: string | null;
}

function normalizeNpmImporterId(importerId: string): string {
  const normalized = importerId
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

/**
 * npm resolves a dependency from the selected importer's node_modules first,
 * then walks ancestor node_modules locations until it reaches the lock root.
 * The first lock entry found shadows every later hoisted candidate, even when
 * that entry is malformed and therefore cannot be confirmation evidence.
 */
function npmResolutionKeys(importerKey: string, packageName: string): string[] {
  const keys: string[] = [];
  let directory = importerKey;
  while (true) {
    keys.push(directory === '' ? `node_modules/${packageName}` : `${directory}/node_modules/${packageName}`);
    if (directory === '') break;
    const separator = directory.lastIndexOf('/');
    directory = separator < 0 ? '' : directory.slice(0, separator);
  }
  return keys;
}

function npmResolvedVersion(
  packages: Record<string, unknown> | null,
  importerKey: string,
  packageName: string
): string | null {
  if (packages === null) return null;
  for (const key of npmResolutionKeys(importerKey, packageName)) {
    if (!Object.hasOwn(packages, key)) continue;
    const entry = asRecord(packages[key]);
    if (entry === null || entry['link'] === true) return null;
    return typeof entry['version'] === 'string' ? entry['version'] : null;
  }
  return null;
}

/**
 * Reads both declaration and exact resolution evidence for the selected npm
 * importer. Modern npm locks retain importer declarations and enough package
 * paths to reproduce local/hoisted resolution. A v1 lock has only one root
 * dependency tree, so it cannot prove anything about a non-root importer.
 */
function inspectNpmDirectLockEvidence(
  lockfileText: string,
  importerId: string,
  expected: UpgradeChange
): DirectLockEvidence {
  const lock = asRecord(JSON.parse(lockfileText));
  if (lock === null) return { importerDeclared: false, resolvedVersion: null };
  const version = lock['lockfileVersion'];
  if (version === 1) {
    if (normalizeNpmImporterId(importerId) !== '') {
      return { importerDeclared: false, resolvedVersion: null };
    }
    const entry = asRecord(ownValue(asRecord(lock['dependencies']), expected.packageName));
    const resolvedVersion = typeof entry?.['version'] === 'string' ? entry['version'] : null;
    const importerDeclared =
      entry !== null &&
      (expected.classification === 'dev'
        ? entry['dev'] === true
        : expected.classification === 'optional'
          ? entry['optional'] === true
          : entry['dev'] !== true && entry['optional'] !== true);
    return { importerDeclared, resolvedVersion };
  }
  if (version !== 2 && version !== 3) {
    return { importerDeclared: false, resolvedVersion: null };
  }

  const packages = asRecord(lock['packages']);
  const importerKey = normalizeNpmImporterId(importerId);
  const importer = asRecord(ownValue(packages, importerKey));
  const block = asRecord(importer?.[lockfileBlockForClassification(expected.classification)]);
  return {
    importerDeclared: rangeAdmitsTarget(ownValue(block, expected.packageName), expected.targetVersion),
    resolvedVersion: npmResolvedVersion(packages, importerKey, expected.packageName),
  };
}

/** Explicitly checks the selected pnpm importer in addition to the graph. */
function pnpmLockfileProvesDirectResolution(
  lockfileText: string,
  importerId: string,
  expected: UpgradeChange
): boolean {
  const lock = asRecord(loadYaml(lockfileText));
  const normalizedImporter = importerId.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  const importer = asRecord(ownValue(asRecord(lock?.['importers']), normalizedImporter));
  const block = asRecord(importer?.[lockfileBlockForClassification(expected.classification)]);
  const rawReference = ownValue(block, expected.packageName);
  if (typeof rawReference === 'string') {
    return rangeAdmitsTarget(rawReference, expected.targetVersion);
  }
  const reference = asRecord(rawReference);
  return (
    reference !== null &&
    typeof reference['version'] === 'string' &&
    rangeAdmitsTarget(reference['specifier'], expected.targetVersion)
  );
}

function inspectDirectLockEvidence(
  project: AppliedUpgradeProjectSnapshot,
  expected: UpgradeChange,
  graphResolvedVersion: string | null
): DirectLockEvidence {
  if (project.lockfileText === null) {
    return { importerDeclared: false, resolvedVersion: null };
  }
  if (project.packageManager === 'npm') {
    return inspectNpmDirectLockEvidence(project.lockfileText, project.importerId, expected);
  }
  return {
    importerDeclared: pnpmLockfileProvesDirectResolution(
      project.lockfileText,
      project.importerId,
      expected
    ),
    resolvedVersion: graphResolvedVersion,
  };
}

/**
 * Reconstructs only local, authoritative dependency facts after an install.
 * No registry, audit, advisory, or cached dashboard value participates in
 * this confirmation: package.json proves declaration/classification and the
 * active lockfile proves the exact resolved direct version.
 */
export function inspectAppliedUpgradeState(
  project: AppliedUpgradeProjectSnapshot,
  expectedChanges: readonly UpgradeChange[]
): AppliedUpgradeState {
  const manifest = parseManifest(project.manifestText);
  const graph = buildDependencyGraph({
    root: project.root,
    manifest,
    lockfileText: project.lockfileText,
    packageManager: project.packageManager,
    importerId: project.importerId,
  });
  const nodesByName = new Map(directNodes(graph).map((node) => [node.name, node]));
  const declarationsByName = new Map(manifest.dependencies.map((dependency) => [dependency.name, dependency]));
  const lockEvidence = expectedChanges.map((expected) =>
    inspectDirectLockEvidence(
      project,
      expected,
      nodesByName.get(expected.packageName)?.version ?? null
    )
  );

  const changes = expectedChanges.map((expected, index): AppliedUpgradeLocalChange => {
    const declaration = declarationsByName.get(expected.packageName);
    return {
      packageName: expected.packageName,
      previousVersion: expected.currentVersion,
      requestedVersion: expected.targetVersion,
      currentVersion: lockEvidence[index]?.resolvedVersion ?? null,
      declaredRange: declaration?.range ?? null,
      classification: declaration === undefined ? null : classificationOf(declaration),
    };
  });

  return {
    confirmed: changes.every((change, index) => {
      const expected = expectedChanges[index];
      const declaration = expected === undefined ? undefined : declarationsByName.get(expected.packageName);
      return (
        expected !== undefined &&
        change.currentVersion === expected.targetVersion &&
        lockEvidence[index]?.importerDeclared === true &&
        declaration !== undefined &&
        change.classification === expected.classification &&
        declarationAdmitsTarget(declaration, expected.targetVersion)
      );
    }),
    changes,
  };
}
