import {
  analyzeImportCompatibility,
  analyzePackageScripts,
  analyzeRuntimeCompatibility,
  analyzeToolingPeerAlignment,
  runProjectCompatibilityAnalyzers,
  limitProjectCompatibilityAnalyzerResults,
} from '../../core/projectCompatibility/index.js';
import type {
  ProjectCompatibilityAnalysis,
  ProjectCompatibilityAnalyzerResult,
  ProjectCompatibilityIdentity,
  TargetPackageSurfaceEvidence,
  ToolingPackageEvidence,
  TargetCommandEvidence,
} from '../../core/projectCompatibility/index.js';
import { createNextProjectCompatibilityAnalyzer } from '../../core/projectCompatibility/rules/next/index.js';
import { analyzeDeprecatedApis } from '../../core/projectCompatibility/deprecatedApis.js';
import type { PackageVersionMetadata } from '../../core/registry/versions.js';
import type { CollectedProjectCompatibilityEvidence } from './projectEvidenceCollector.js';

function unavailable(analyzerId: string, reason: string): ProjectCompatibilityAnalyzerResult {
  return { analyzerId, status: 'unavailable', findings: [], unavailableReason: reason };
}

export async function analyzeProjectCompatibilityMedium(input: {
  identity: ProjectCompatibilityIdentity;
  project: CollectedProjectCompatibilityEvidence;
  targetMetadata?: PackageVersionMetadata;
  toolingPackages: readonly ToolingPackageEvidence[];
  toolingMetadataIncomplete: boolean;
  targetCommands?: readonly TargetCommandEvidence[];
  signal?: AbortSignal;
}): Promise<ProjectCompatibilityAnalysis> {
  const scanReason = input.project.scanLimitations?.join('|') || 'project-source-scan-truncated';
  const analyzers = [
    input.targetMetadata === undefined
      ? () => unavailable('runtime-compatibility', 'target-metadata-unavailable')
      : () => analyzeRuntimeCompatibility({
          identity: input.identity,
          evidence: {
            packageName: input.targetMetadata?.name ?? input.identity.packageName,
            targetVersion: input.targetMetadata?.version ?? input.identity.targetVersion,
            targetNodeRange: input.targetMetadata?.engines?.['node'] ?? null,
            projectNodeRange: input.project.projectNodeRange,
            // VS Code's extension-host Node is not evidence of the project's runtime.
            runtimeNodeVersion: null,
          },
        }),
    () => {
      const result = analyzeToolingPeerAlignment({ identity: input.identity, packages: input.toolingPackages });
      if (!input.toolingMetadataIncomplete) return result;
      return {
        ...result,
        status: result.status === 'cancelled' ? result.status : 'partial' as const,
        unavailableReason: 'tooling-metadata-incomplete',
      };
    },
    createNextProjectCompatibilityAnalyzer({
      files: input.project.ruleFiles,
      scripts: input.project.scripts,
      declaredDependencies: input.project.declaredDependencies,
    }),
    () => {
      const result = analyzeDeprecatedApis({ identity: input.identity, references: input.project.imports, sourceComplete: !input.project.truncated });
      return result.status === 'partial' ? { ...result, unavailableReason: scanReason } : result;
    },
    input.targetCommands === undefined
      ? () => unavailable('package-script-compatibility', 'package-command-metadata-unavailable')
      : () => analyzePackageScripts({
          identity: input.identity,
          scripts: input.project.scripts,
          targetCommands: input.targetCommands ?? [],
        }),
    () => ({
      analyzerId: 'project-source-scan',
      status: input.project.truncated ? 'partial' as const : 'complete' as const,
      findings: [],
      ...(input.project.truncated ? { unavailableReason: scanReason } : {}),
    }),
  ];
  return runProjectCompatibilityAnalyzers({
    identity: input.identity,
    analyzers,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function binNames(bin: PackageVersionMetadata['bin'], packageName: string): string[] {
  if (typeof bin === 'string') return [packageName.startsWith('@') ? packageName.slice(packageName.indexOf('/') + 1) : packageName];
  if (bin === undefined) return [];
  return Object.keys(bin).sort();
}

/**
 * Generic CLI evidence is intentionally narrow: only a command published by
 * the current exact version and absent from the target exact version is
 * called unsupported. Subcommand migrations remain rule-pack knowledge.
 */
export function removedTargetPackageCommands(input: {
  packageName: string;
  currentMetadata?: PackageVersionMetadata;
  targetMetadata?: PackageVersionMetadata;
}): TargetCommandEvidence[] | undefined {
  if (input.currentMetadata === undefined || input.targetMetadata === undefined) return undefined;
  const current = new Set(binNames(input.currentMetadata.bin, input.packageName));
  const target = new Set(binNames(input.targetMetadata.bin, input.packageName));
  return [...current]
    .filter((command) => !target.has(command))
    .sort()
    .map((command) => ({
      executable: command,
      status: 'unsupported' as const,
      explanation: `${input.packageName} ${input.targetMetadata?.version ?? ''} no longer publishes the ${command} executable.`,
      migrationHint: `Replace scripts that invoke ${command} with a command supported by the target package.`,
    }));
}

export async function appendProjectCompatibilityImportAnalysis(input: {
  analysis: ProjectCompatibilityAnalysis;
  project: CollectedProjectCompatibilityEvidence;
  targetSurface?: TargetPackageSurfaceEvidence;
  unavailableReason?: string;
  signal?: AbortSignal;
}): Promise<ProjectCompatibilityAnalysis> {
  const deep = await runProjectCompatibilityAnalyzers({
    identity: input.analysis.identity,
    analyzers: [input.targetSurface === undefined
      ? () => unavailable('import-compatibility', input.unavailableReason ?? 'target-surface-unavailable')
      : () => analyzeImportCompatibility({
          identity: input.analysis.identity,
          references: input.project.imports,
          targetSurface: input.targetSurface as TargetPackageSurfaceEvidence,
        })],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const analyzers = limitProjectCompatibilityAnalyzerResults([...input.analysis.analyzers, ...deep.analyzers]);
  // A clean subset must not masquerade as a complete source check.
  if (input.project.truncated) {
    const imports = analyzers.find((entry) => entry.analyzerId === 'import-compatibility');
    if (imports?.status === 'complete' || imports?.status === 'partial') {
      imports.status = 'partial';
      imports.unavailableReason = [...new Set([
        ...(imports.unavailableReason?.split('|') ?? []),
        ...(input.project.scanLimitations?.length ? input.project.scanLimitations : ['project-source-scan-truncated']),
      ])].join('|');
    }
  }
  return {
    ...input.analysis,
    analyzers,
    findings: analyzers.flatMap((result) => result.findings),
    completedAt: deep.completedAt,
  };
}

/** Exact package.json `exports` keys; non-subpath condition maps are the root export sugar. */
export function targetExportsEvidence(value: unknown, complete = true): TargetPackageSurfaceEvidence['exports'] {
  if (!complete) return { status: 'unknown', subpaths: [] };
  if (value === undefined) return { status: 'absent', subpaths: [] };
  const definitelyBlocked = (entry: unknown): boolean => {
    if (entry === null) return true;
    if (Array.isArray(entry)) return entry.length > 0 && entry.every(definitelyBlocked);
    if (typeof entry === 'object') {
      const values = Object.values(entry as Record<string, unknown>);
      return values.length > 0 && values.every(definitelyBlocked);
    }
    return false;
  };
  const isConditionalTarget = (entry: unknown): boolean => {
    if (Array.isArray(entry)) return entry.some(isConditionalTarget);
    if (typeof entry !== 'object' || entry === null) return false;
    return Object.keys(entry as Record<string, unknown>).some((key) => !key.startsWith('.'));
  };
  if (value === null) return { status: 'known', subpaths: [], blockedSubpaths: ['.'] };
  if (typeof value === 'string') return { status: 'known', subpaths: ['.'] };
  if (Array.isArray(value)) {
    return definitelyBlocked(value)
      ? { status: 'known', subpaths: [], blockedSubpaths: ['.'] }
      : isConditionalTarget(value)
        ? { status: 'known', subpaths: [], conditionalSubpaths: ['.'] }
        : { status: 'known', subpaths: ['.'] };
  }
  if (typeof value !== 'object') return { status: 'unknown', subpaths: [] };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const subpaths = keys.filter((key) => key === '.' || key.startsWith('./'));
  if (subpaths.length > 0) {
    const blockedSubpaths = subpaths.filter((key) => definitelyBlocked(record[key]));
    const conditionalSubpaths = subpaths.filter((key) =>
      !blockedSubpaths.includes(key) && isConditionalTarget(record[key])
    );
    const exportedSubpaths = subpaths.filter((key) =>
      !blockedSubpaths.includes(key) && !conditionalSubpaths.includes(key)
    );
    return {
      status: 'known',
      subpaths: [...new Set(exportedSubpaths)].sort(),
      ...(blockedSubpaths.length === 0 ? {} : { blockedSubpaths: [...new Set(blockedSubpaths)].sort() }),
      ...(conditionalSubpaths.length === 0 ? {} : { conditionalSubpaths: [...new Set(conditionalSubpaths)].sort() }),
    };
  }
  return definitelyBlocked(record)
    ? { status: 'known', subpaths: [], blockedSubpaths: ['.'] }
    : isConditionalTarget(record)
      ? { status: 'known', subpaths: [], conditionalSubpaths: ['.'] }
      : { status: 'known', subpaths: ['.'] };
}

export function targetPrivateSubpathPrefixes(packageName: string): readonly string[] {
  // Ecosystem-specific surface knowledge stays isolated here, not in UI rendering.
  return packageName === 'next' ? ['./dist/'] : [];
}
