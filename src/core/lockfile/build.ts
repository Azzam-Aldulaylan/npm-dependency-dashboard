import type { DependencyGraph, PackageManagerKind } from '../types.js';
import type { Manifest } from '../manifest/parse.js';
import { buildGraph as buildNpmGraph } from './parse.js';
import { buildPnpmGraph } from './pnpm.js';

export interface BuildDependencyGraphOptions {
  root: string;
  manifest: Manifest;
  lockfileText: string | null;
  packageManager: PackageManagerKind;
  /** Required for a pnpm workspace member; ignored for npm. */
  importerId?: string;
}

/** Package-manager facade returning the same normalized graph domain. */
export function buildDependencyGraph(options: BuildDependencyGraphOptions): DependencyGraph {
  if (options.packageManager === 'pnpm') {
    return buildPnpmGraph({
      root: options.root,
      manifest: options.manifest,
      lockfileText: options.lockfileText,
      ...(options.importerId === undefined ? {} : { importerId: options.importerId }),
    });
  }
  return buildNpmGraph({ root: options.root, manifest: options.manifest, lockfileText: options.lockfileText });
}
