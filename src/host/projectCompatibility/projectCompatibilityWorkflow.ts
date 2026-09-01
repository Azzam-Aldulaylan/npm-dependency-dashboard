/** Progressive source checks, independent of dependency resolution and UI ownership. */
import { directNodes } from '../../core/lockfile/parse.js';
import type { DependencyGraph } from '../../core/types.js';
import type { PackageMetadataProvider } from '../../core/compatibility/types.js';
import type { PackageVersionMetadata } from '../../core/registry/versions.js';
import type { PerformanceRecorder } from '../../core/performance/measurement.js';
import type { ProjectCompatibilityAnalysis, ProjectCompatibilityIdentity, ToolingPackageEvidence } from '../../core/projectCompatibility/index.js';
import type { CollectedProjectCompatibilityEvidence, ProjectManifestCompatibilityEvidence } from './projectEvidenceCollector.js';
import {
  analyzeProjectCompatibilityMedium, appendProjectCompatibilityImportAnalysis,
  removedTargetPackageCommands, targetExportsEvidence, targetPrivateSubpathPrefixes,
} from './projectCompatibilityAnalysis.js';
import { targetPackageSurfaceCacheKey, type TargetPackageSurface, type TargetPackageSurfaceCache } from './targetPackageInspector.js';

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Upgrade analysis cancelled.', 'AbortError');
}

/** Metadata/source reads can be shared; cancellation stops waiting, not their other consumers. */
function waitForWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // Observe even an already rejected promise when cancellation arrived first.
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(new DOMException('Upgrade analysis cancelled.', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DOMException('Upgrade analysis cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function loadToolingEvidence(input: {
  graph: DependencyGraph;
  declarations: Readonly<Record<string, string>>;
  metadataProvider: PackageMetadataProvider;
  signal: AbortSignal;
}): Promise<{ packages: ToolingPackageEvidence[]; incomplete: boolean }> {
  const directByName = new Map(directNodes(input.graph).map((node) => [node.name, node]));
  const relevant = ['@typescript-eslint/eslint-plugin', '@typescript-eslint/parser']
    .filter((name) => input.declarations[name] !== undefined);
  // At most two independent reads; retain deterministic ordering without serial network waits.
  const results = await Promise.all(relevant.map(async (name) => {
    const version = directByName.get(name)?.version ?? null;
    const base = { name, resolvedVersion: version, declaredRange: input.declarations[name] ?? null };
    if (version !== null) {
      try {
        const metadata = await input.metadataProvider.getPackageVersionMetadata(name, version, input.signal);
        return { complete: true, evidence: { ...base, peerDependencies: metadata.peerDependencies,
          optionalPeers: Object.entries(metadata.peerDependenciesMeta).filter(([, value]) => value.optional).map(([peer]) => peer),
        } };
      } catch { /* Missing metadata is coverage, never compatibility proof. */ }
    }
    return { complete: false, evidence: { ...base, peerDependencies: {} } };
  }));
  return { packages: results.map((entry) => entry.evidence), incomplete: results.some((entry) => !entry.complete) };
}

export interface ProjectCompatibilityWorkflowInput {
  identity: Omit<ProjectCompatibilityIdentity, 'sourceFingerprint'>;
  sourceFingerprint: (evidenceFingerprint: string) => string;
  manifest: ProjectManifestCompatibilityEvidence;
  evidence: Promise<CollectedProjectCompatibilityEvidence>;
  graph: DependencyGraph;
  metadataProvider: PackageMetadataProvider;
  registry: string;
  surfaceCache: TargetPackageSurfaceCache;
  inspect?: (packageName: string, version: string, signal: AbortSignal) => Promise<TargetPackageSurface>;
  /** Resolves only after the preceding resolver subprocess and its cleanup finish. */
  packageManagerIdle: Promise<unknown>;
  performance: PerformanceRecorder;
  signal: AbortSignal;
  onResult: (analysis: ProjectCompatibilityAnalysis) => void;
}

export async function runProjectCompatibilityWorkflow(input: ProjectCompatibilityWorkflowInput): Promise<{
  analysis: ProjectCompatibilityAnalysis;
  evidence: CollectedProjectCompatibilityEvidence;
}> {
  throwIfCancelled(input.signal);
  const endTotal = input.performance.start('project compatibility total analysis');
  const endFirst = input.performance.start('project compatibility time to first result');
  let completed = false;
  const publish = (analysis: ProjectCompatibilityAnalysis): void => {
    throwIfCancelled(input.signal);
    input.onResult(analysis);
  };
  const readMetadata = async (version: string): Promise<PackageVersionMetadata | undefined> => {
    try {
      return await input.metadataProvider.getPackageVersionMetadata(input.identity.packageName, version, input.signal);
    } catch { return undefined; }
  };
  const hasScripts = Object.keys(input.manifest.scripts).length > 0;
  const hasTooling = ['@typescript-eslint/eslint-plugin', '@typescript-eslint/parser']
    .some((name) => input.manifest.declaredDependencies[name] !== undefined);
  // Start metadata alongside source reads. The provider coalesces identical preflight requests.
  const targetPromise = readMetadata(input.identity.targetVersion);
  const currentPromise = hasScripts ? readMetadata(input.identity.currentVersion) : Promise.resolve(undefined);
  const toolingPromise = hasTooling
    ? loadToolingEvidence({ graph: input.graph, declarations: input.manifest.declaredDependencies, metadataProvider: input.metadataProvider, signal: input.signal })
    : Promise.resolve({ packages: [], incomplete: false });
  try {
    const [project, targetMetadata] = await waitForWork(Promise.all([input.evidence, targetPromise]), input.signal);
    const identity = { ...input.identity, sourceFingerprint: input.sourceFingerprint(project.evidenceFingerprint) };
    const endFast = input.performance.start('project compatibility fast analysis');
    let analysis = await analyzeProjectCompatibilityMedium({
      identity, project, ...(targetMetadata === undefined ? {} : { targetMetadata }),
      toolingPackages: [], toolingMetadataIncomplete: hasTooling,
      ...(hasScripts ? {} : { targetCommands: [] }), signal: input.signal,
    });
    endFast({ findings: analysis.findings.length });
    publish(analysis);
    endFirst({ findings: analysis.findings.length });

    // Neither these metadata checks nor a cached import check depends on the resolver.
    if (hasScripts || hasTooling) {
      const [currentMetadata, tooling] = await waitForWork(Promise.all([currentPromise, toolingPromise]), input.signal);
      const targetCommands = hasScripts ? removedTargetPackageCommands({
        packageName: identity.packageName,
        ...(currentMetadata === undefined ? {} : { currentMetadata }),
        ...(targetMetadata === undefined ? {} : { targetMetadata }),
      }) : [];
      const endMedium = input.performance.start('project compatibility medium analysis');
      analysis = await analyzeProjectCompatibilityMedium({
        identity, project, ...(targetMetadata === undefined ? {} : { targetMetadata }),
        toolingPackages: tooling.packages, toolingMetadataIncomplete: tooling.incomplete,
        ...(targetCommands === undefined ? {} : { targetCommands }), signal: input.signal,
      });
      endMedium({ findings: analysis.findings.length });
      publish(analysis);
    }

    let targetSurface: Parameters<typeof appendProjectCompatibilityImportAnalysis>[0]['targetSurface'];
    let unavailableReason: string | undefined;
    if (targetMetadata === undefined) {
      unavailableReason = 'target-metadata-unavailable';
    } else {
      const exports = targetExportsEvidence(targetMetadata.exports, targetMetadata.exportsTruncated !== true);
      const base = { packageName: identity.packageName, version: identity.targetVersion, exports,
        privateSubpathPrefixes: targetPrivateSubpathPrefixes(identity.packageName) };
      if (exports.status === 'known' || project.imports.length === 0) {
        targetSurface = base;
      } else {
        const endInventory = input.performance.start('project compatibility target package inventory');
        let cached = false;
        let files = 0;
        try {
          const key = targetPackageSurfaceCacheKey({ registry: input.registry, packageName: identity.packageName, version: identity.targetVersion });
          let surface = input.surfaceCache.get(key);
          cached = surface !== undefined;
          if (surface === undefined) {
            if (input.inspect === undefined) {
              unavailableReason = 'target-package-inspector-unavailable';
            } else {
              const endQueue = input.performance.start('project compatibility inventory queue');
              try { await waitForWork(input.packageManagerIdle, input.signal); }
              finally { endQueue(); }
              throwIfCancelled(input.signal);
              // Do not race the process promise: its abort handler must reap the child
              // before cleanup and before the coordinator releases its reservation.
              surface = await input.inspect(identity.packageName, identity.targetVersion, input.signal);
              throwIfCancelled(input.signal);
              input.surfaceCache.set(key, surface);
            }
          }
          if (surface !== undefined) {
            files = surface.files.length;
            targetSurface = { ...base, files: { completeness: 'complete', paths: surface.files },
              ...(targetMetadata.main === undefined ? {} : { main: targetMetadata.main }) };
          }
        } catch (cause) {
          throwIfCancelled(input.signal);
          unavailableReason = cause instanceof Error && cause.name === 'TimeoutError'
            ? 'target-package-inventory-timeout' : 'target-package-inventory-unavailable';
        } finally { endInventory({ files, cached, completed: targetSurface !== undefined }); }
      }
    }
    const endDeep = input.performance.start('project compatibility import analysis');
    analysis = await appendProjectCompatibilityImportAnalysis({
      analysis, project, ...(targetSurface === undefined ? {} : { targetSurface }),
      ...(unavailableReason === undefined ? {} : { unavailableReason }), signal: input.signal,
    });
    endDeep({ findings: analysis.findings.length });
    publish(analysis);
    completed = true;
    return { analysis, evidence: project };
  } finally { endTotal({ completed }); }
}
