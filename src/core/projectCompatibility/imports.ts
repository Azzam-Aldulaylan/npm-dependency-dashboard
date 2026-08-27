import { importedPackageName } from '../usage/packageNameMatch.js';
import { createProjectCompatibilityFinding } from './findings.js';
import type {
  ProjectCompatibilityAnalyzerResult,
  ProjectCompatibilityEvidence,
  ProjectCompatibilityIdentity,
} from './types.js';

export interface ProjectImportReference {
  specifier: string;
  kind: 'import' | 'require' | 'dynamic-import';
  filePath: string;
  line: number;
  column: number;
  snippet: string;
  /** Existing host-trusted UsageReferenceStore lookup tuple. */
  usageId?: string;
  referenceIndex?: number;
}

export interface TargetPackageExportsEvidence {
  /** `known` means the supplied subpath-key set is complete. */
  status: 'known' | 'absent' | 'unknown';
  /** Normalized package.json export keys such as "." and "./server". */
  subpaths: readonly string[];
  /** Exact or wildcard export keys whose target is definitely null/blocked. */
  blockedSubpaths?: readonly string[];
  /** Keys with condition-dependent targets that this static evidence did not resolve. */
  conditionalSubpaths?: readonly string[];
}

export interface TargetPackageFilesEvidence {
  /** Only a complete inventory can prove that an unmatched file is absent. */
  completeness: 'complete' | 'partial';
  /** Package-relative paths without a leading slash. */
  paths: readonly string[];
}

/** Host-materialized evidence only. Core never downloads or executes a package. */
export interface TargetPackageSurfaceEvidence {
  packageName: string;
  version: string;
  exports: TargetPackageExportsEvidence;
  files?: TargetPackageFilesEvidence;
  /** Explicit ecosystem knowledge, e.g. "./dist/" for Next.js. */
  privateSubpathPrefixes?: readonly string[];
}

function importEvidence(reference: ProjectImportReference): ProjectCompatibilityEvidence {
  const evidence: ProjectCompatibilityEvidence = {
    kind: 'source-reference',
    filePath: reference.filePath,
    line: reference.line,
    column: reference.column,
    snippet: reference.snippet,
    specifier: reference.specifier,
  };
  if (reference.usageId !== undefined) evidence.usageId = reference.usageId;
  if (reference.referenceIndex !== undefined) evidence.referenceIndex = reference.referenceIndex;
  return evidence;
}

function packageSubpath(specifier: string, packageName: string): string | null {
  if (importedPackageName(specifier) !== packageName) return null;
  if (specifier === packageName) return '.';
  const suffix = specifier.slice(packageName.length);
  return suffix.startsWith('/') && suffix.length > 1 ? `.${suffix}` : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exportKeyMatches(key: string, subpath: string): boolean {
  if (key === subpath) return true;
  const star = key.indexOf('*');
  if (star === -1 || key.indexOf('*', star + 1) !== -1) return false;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return new RegExp(`^${escapeRegex(prefix)}.+${escapeRegex(suffix)}$`).test(subpath);
}

function matchingExport(
  surface: TargetPackageSurfaceEvidence,
  subpath: string
): { blocked: boolean; conditional: boolean } | undefined {
  const candidates = [
    ...surface.exports.subpaths.map((key) => ({ key, blocked: false, conditional: false })),
    ...(surface.exports.blockedSubpaths ?? []).map((key) => ({ key, blocked: true, conditional: false })),
    ...(surface.exports.conditionalSubpaths ?? []).map((key) => ({ key, blocked: false, conditional: true })),
  ].filter((entry) => exportKeyMatches(entry.key, subpath));
  const exact = candidates.find((entry) => entry.key === subpath);
  if (exact !== undefined) return exact;
  candidates.sort((left, right) => {
    const leftStar = left.key.indexOf('*');
    const rightStar = right.key.indexOf('*');
    const leftPrefix = leftStar === -1 ? left.key.length : leftStar;
    const rightPrefix = rightStar === -1 ? right.key.length : rightStar;
    return rightPrefix - leftPrefix || right.key.length - left.key.length;
  });
  return candidates[0];
}

function fileCandidates(subpath: string): string[] {
  const path = subpath.slice(2);
  return [
    path,
    `${path}.js`,
    `${path}.mjs`,
    `${path}.cjs`,
    `${path}.jsx`,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.d.ts`,
    `${path}.json`,
    `${path}.node`,
    `${path}/index.js`,
    `${path}/index.mjs`,
    `${path}/index.cjs`,
    `${path}/index.jsx`,
    `${path}/index.ts`,
    `${path}/index.tsx`,
    `${path}/index.d.ts`,
    `${path}/index.json`,
  ];
}

function fileExists(surface: TargetPackageSurfaceEvidence, subpath: string): boolean {
  if (surface.files === undefined) return false;
  const normalized = new Set(surface.files.paths.map((path) => path.replace(/^\.\//, '')));
  return fileCandidates(subpath).some((candidate) => normalized.has(candidate));
}

function privateSubpath(surface: TargetPackageSurfaceEvidence, subpath: string): boolean {
  return (surface.privateSubpathPrefixes ?? []).some((prefix) => {
    const normalized = prefix.startsWith('./') ? prefix : `./${prefix.replace(/^\//, '')}`;
    return subpath === normalized.replace(/\/$/, '') || subpath.startsWith(normalized.endsWith('/') ? normalized : `${normalized}/`);
  });
}

export function analyzeImportCompatibility(input: {
  identity: ProjectCompatibilityIdentity;
  references: readonly ProjectImportReference[];
  targetSurface: TargetPackageSurfaceEvidence;
}): ProjectCompatibilityAnalyzerResult {
  if (
    input.targetSurface.packageName !== input.identity.packageName ||
    input.targetSurface.version !== input.identity.targetVersion
  ) {
    return {
      analyzerId: 'import-compatibility',
      status: 'unavailable',
      findings: [],
      unavailableReason: 'target-surface-identity-mismatch',
    };
  }

  const findings = [];
  let insufficientEvidence = false;
  for (const reference of input.references) {
    const subpath = packageSubpath(reference.specifier, input.identity.packageName);
    if (subpath === null) continue;

    const isPrivate = privateSubpath(input.targetSurface, subpath);
    if (input.targetSurface.exports.status === 'known') {
      const exportMatch = matchingExport(input.targetSurface, subpath);
      if (exportMatch === undefined || exportMatch.blocked) {
        findings.push(
          createProjectCompatibilityFinding(input.identity, {
            ruleId: 'target-export-blocks-import',
            category: 'import',
            confidence: 'confirmed',
            title: 'Import compatibility issue',
            explanation: `${reference.specifier} is not exported by ${input.identity.packageName} ${input.identity.targetVersion}.`,
            migrationHint: 'Replace this import with a public entry point exposed by the target package.',
            evidence: [importEvidence(reference), { kind: 'target-package-surface', context: subpath }],
            discriminator: [reference.filePath, reference.line, reference.column, reference.specifier],
          })
        );
        continue;
      }
      if (exportMatch.conditional) insufficientEvidence = true;
    } else if (subpath === '.') {
      // Without an exports map, root resolution depends on main/module/index
      // metadata that this evidence model deliberately does not guess.
      insufficientEvidence = true;
      continue;
    } else if (input.targetSurface.exports.status === 'absent') {
      if (fileExists(input.targetSurface, subpath)) {
        // Classic Node package resolution proves this package-relative file is present.
      } else if (input.targetSurface.files?.completeness === 'complete') {
        findings.push(
          createProjectCompatibilityFinding(input.identity, {
            ruleId: 'target-package-file-missing',
            category: 'import',
            confidence: 'confirmed',
            title: 'Import compatibility issue',
            explanation: `${reference.specifier} does not resolve to a published file in ${input.identity.packageName} ${input.identity.targetVersion}.`,
            migrationHint: 'Replace this import with an entry point present in the target package.',
            evidence: [importEvidence(reference), { kind: 'target-package-surface', context: subpath }],
            discriminator: [reference.filePath, reference.line, reference.column, reference.specifier],
          })
        );
        continue;
      } else {
        insufficientEvidence = true;
      }
    } else if (!fileExists(input.targetSurface, subpath)) {
      insufficientEvidence = true;
    }

    if (isPrivate) {
      findings.push(
        createProjectCompatibilityFinding(input.identity, {
          ruleId: 'private-package-api',
          category: 'private-api',
          confidence: 'review',
          title: 'Private package API',
          explanation: `${reference.specifier} uses an internal package path that may change without semver compatibility guarantees.`,
          migrationHint: 'Prefer a documented public package entry point.',
          evidence: [importEvidence(reference)],
          discriminator: [reference.filePath, reference.line, reference.column, reference.specifier],
        })
      );
    }
  }

  return {
    analyzerId: 'import-compatibility',
    status: insufficientEvidence ? 'partial' : 'complete',
    findings,
    ...(insufficientEvidence ? { unavailableReason: 'target-surface-incomplete' } : {}),
  };
}
