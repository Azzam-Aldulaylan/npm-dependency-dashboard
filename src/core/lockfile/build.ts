import type { DependencyGraph, PackageManagerKind } from '../types.js';
import type { Manifest } from '../manifest/parse.js';
import type { PerformanceRecorder } from '../performance/measurement.js';
import { buildGraph as buildNpmGraph } from './parse.js';
import { buildPnpmGraph } from './pnpm.js';

export interface BuildDependencyGraphOptions {
  root: string;
  manifest: Manifest;
  lockfileText: string | null;
  packageManager: PackageManagerKind;
  /** Required for a pnpm workspace member; ignored for npm. */
  importerId?: string;
  performance?: PerformanceRecorder;
}

/** Package-manager facade returning the same normalized graph domain. */
export function buildDependencyGraph(options: BuildDependencyGraphOptions): DependencyGraph {
  if (options.packageManager === 'pnpm') {
    return buildPnpmGraph({
      root: options.root,
      manifest: options.manifest,
      lockfileText: options.lockfileText,
      ...(options.importerId === undefined ? {} : { importerId: options.importerId }),
      ...(options.performance === undefined ? {} : { performance: options.performance }),
    });
  }
  return buildNpmGraph({
    root: options.root,
    manifest: options.manifest,
    lockfileText: options.lockfileText,
    ...(options.performance === undefined ? {} : { performance: options.performance }),
  });
}
