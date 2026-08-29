/**
 * On-demand workspace usage analyzer — the one shared implementation behind
 * both "Where is this used?" (one package) and unused-dependency detection
 * (every direct dependency at once). Never runs at activation, dashboard
 * startup, or on any refresh/filter/sort/pagination action — always
 * explicitly triggered, always cancellable — see usageCoordinator.ts for the
 * call sites.
 *
 * One pass over the workspace's source files regardless of how many package
 * names are requested: each file is read once, every import/require/dynamic-
 * import in it is extracted once (src/core/usage/importScan.ts), and each
 * match is bucketed into whichever requested package it belongs to. This is
 * what lets a full "Analyze cleanup" run (all direct dependencies) cost the
 * same file I/O as checking a single package.
 */

import * as vscode from 'vscode';

import { configReferencesPackage } from '../../core/usage/configHeuristics.js';
import { scanFilesBounded } from '../../core/usage/boundedFileScan.js';
import { findPackageInScripts } from '../../core/usage/packageScripts.js';
import type { DependencyUsageResult } from '../../core/usage/types.js';
import { UsageReferenceIndex } from '../../core/usage/referenceIndex.js';
import type { PerformanceRecorder } from '../../core/performance/measurement.js';
import { NOOP_PERFORMANCE_RECORDER } from '../../core/performance/measurement.js';
import {
  findConfigFiles,
  findSourceFiles,
  planWorkspaceFiles,
  readTextFileCapped,
} from './workspaceFiles.js';

const DEFAULT_MAX_FILES = 6000;

export interface AnalyzeUsageOptions {
  folder: vscode.WorkspaceFolder;
  /** The project's own workspace-folder-relative directory ("" for the folder root) — scan is scoped to this subtree, not sibling monorepo members. */
  dir: string;
  manifestText: string;
  packageNames: readonly string[];
  maxFiles?: number;
  onProgress?: (scanned: number, total: number) => void;
  token: vscode.CancellationToken;
  performance?: PerformanceRecorder;
}

export async function analyzeDependencyUsage(
  options: AnalyzeUsageOptions
): Promise<Map<string, DependencyUsageResult>> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const requested = new Set(options.packageNames);
  const referenceIndex = new UsageReferenceIndex(options.packageNames);
  const performance = options.performance ?? NOOP_PERFORMANCE_RECORDER;

  const endDiscovery = performance.start('usage file discovery');
  const [sourceFiles, configFiles] = await Promise.all([
    findSourceFiles(options.folder, options.dir, maxFiles, options.token),
    findConfigFiles(options.folder, options.dir, options.token),
  ]);
  const files = planWorkspaceFiles(options.folder, sourceFiles, configFiles);
  const overlappingFiles = sourceFiles.length + configFiles.length - files.length;
  performance.increment('usage source discoveries', sourceFiles.length);
  performance.increment('usage config discoveries', configFiles.length);
  performance.increment('usage unique files', files.length);
  endDiscovery({
    'source files': sourceFiles.length,
    'config files': configFiles.length,
    'unique files': files.length,
    overlaps: overlappingFiles,
  });
  const fileCapReached = sourceFiles.length >= maxFiles;

  let scannedSourceFiles = 0;
  let failedReadCount = 0;
  const endWorkspaceScan = performance.start('usage workspace scan');
  const workspaceScan = await scanFilesBounded({
    items: files,
    read: ({ uri }) => readTextFileCapped(uri, {
      onStat: () => performance.increment('usage stats'),
      onRead: (bytes) => {
        performance.increment('usage reads');
        performance.increment('usage bytes', bytes);
      },
    }),
    consume: (file, text) => {
      if (file.source) referenceIndex.addSourceFile(file.filePath, text);
      if (!file.config) return;
      const configName = file.filePath.slice(file.filePath.lastIndexOf('/') + 1);
      for (const name of requested) {
        if (configReferencesPackage(text, name)) {
          referenceIndex.addReference(name, {
            filePath: file.filePath,
            line: 0,
            column: 0,
            snippet: configName,
            kind: 'config',
            context: configName,
          });
        }
      }
    },
    isCancelled: () => options.token.isCancellationRequested,
    onReadFailure: () => {
      failedReadCount += 1;
      performance.increment('usage read failures');
    },
    onItemProcessed: (file) => {
      if (!file.source) return;
      scannedSourceFiles += 1;
      options.onProgress?.(scannedSourceFiles, sourceFiles.length);
    },
  });
  // A cancellation can settle during discovery with an empty/partial result,
  // before the bounded scanner has an item on which to observe it. Never
  // publish that degraded pass as complete.
  const cancelledEarly = workspaceScan.cancelled || options.token.isCancellationRequested;
  endWorkspaceScan({
    'unique files': workspaceScan.processed,
    'source files': scannedSourceFiles,
    'read failures': failedReadCount,
    packages: requested.size,
  });

  for (const name of requested) {
    for (const scriptMatch of findPackageInScripts(options.manifestText, name)) {
      referenceIndex.addReference(name, {
        filePath: 'package.json',
        line: 0,
        column: 0,
        snippet: `"${scriptMatch.scriptName}": "${scriptMatch.scriptCommand}"`,
        kind: 'script',
        context: scriptMatch.scriptName,
      });
    }
  }

  const scannedAt = new Date().toISOString();
  // A missing, unreadable, or oversized eligible file is an evidence gap,
  // just like a file-cap or cancellation. References found elsewhere remain
  // valid, but a zero-reference result from this pass cannot honestly prove
  // that the package is unused or low-risk to remove.
  const truncated = fileCapReached || cancelledEarly || failedReadCount > 0;
  const results = new Map<string, DependencyUsageResult>();
  for (const name of requested) {
    results.set(name, {
      packageName: name,
      references: referenceIndex.forPackage(name),
      truncated,
      scannedFileCount: scannedSourceFiles,
      scannedAt,
    });
  }
  return results;
}
