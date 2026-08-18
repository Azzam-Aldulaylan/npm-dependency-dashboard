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
import { findPackageInScripts } from '../../core/usage/packageScripts.js';
import type { DependencyUsageResult } from '../../core/usage/types.js';
import { UsageReferenceIndex } from '../../core/usage/referenceIndex.js';
import type { PerformanceRecorder } from '../../core/performance/measurement.js';
import { NOOP_PERFORMANCE_RECORDER } from '../../core/performance/measurement.js';
import { findConfigFiles, findSourceFiles, readTextFileCapped, relativeToFolder } from './workspaceFiles.js';

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
  const sourceFiles = await findSourceFiles(options.folder, options.dir, maxFiles, options.token);
  endDiscovery({ files: sourceFiles.length });
  const fileCapReached = sourceFiles.length >= maxFiles;

  const endSourceScan = performance.start('usage source scan');
  let scanned = 0;
  let cancelledEarly = false;
  for (const uri of sourceFiles) {
    if (options.token.isCancellationRequested) {
      cancelledEarly = true;
      break;
    }
    const text = await readTextFileCapped(uri);
    if (text !== null) {
      const filePath = relativeToFolder(options.folder, uri);
      if (filePath !== null) referenceIndex.addSourceFile(filePath, text);
    }
    scanned += 1;
    options.onProgress?.(scanned, sourceFiles.length);
  }
  endSourceScan({ files: scanned, packages: requested.size });

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

  if (!options.token.isCancellationRequested) {
    const endConfigScan = performance.start('usage config scan');
    const configFiles = await findConfigFiles(options.folder, options.dir, options.token);
    for (const uri of configFiles) {
      if (options.token.isCancellationRequested) {
        cancelledEarly = true;
        break;
      }
      const text = await readTextFileCapped(uri);
      if (text === null) continue;
      const filePath = relativeToFolder(options.folder, uri);
      if (filePath === null) continue;
      const configName = filePath.slice(filePath.lastIndexOf('/') + 1);
      for (const name of requested) {
        if (configReferencesPackage(text, name)) {
          referenceIndex.addReference(name, {
            filePath,
            line: 0,
            column: 0,
            snippet: configName,
            kind: 'config',
            context: configName,
          });
        }
      }
    }
    endConfigScan({ files: configFiles.length });
  }

  const scannedAt = new Date().toISOString();
  const truncated = fileCapReached || cancelledEarly;
  const results = new Map<string, DependencyUsageResult>();
  for (const name of requested) {
    results.set(name, {
      packageName: name,
      references: referenceIndex.forPackage(name),
      truncated,
      scannedFileCount: scanned,
      scannedAt,
    });
  }
  return results;
}
