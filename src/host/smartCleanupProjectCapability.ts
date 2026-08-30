import type { PackageManagerKind } from '../core/types.js';

export interface SmartCleanupProjectSource {
  packageManager: PackageManagerKind;
  importerId: string;
  lockfileName: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml' | null;
}

export type SmartCleanupProjectCapability =
  | { executionSupported: true }
  | { executionSupported: false; reason: string };

/**
 * Removal-first execution is intentionally narrower than read-only analysis.
 * Workspace members sharing a root lockfile, lockfile-less projects, and
 * npm-shrinkwrap projects remain analysis-only until their whole-workspace
 * mutation semantics have dedicated coverage.
 */
export function smartCleanupProjectCapability(
  source: SmartCleanupProjectSource
): SmartCleanupProjectCapability {
  if (source.importerId !== '.') {
    return {
      executionSupported: false,
      reason: 'This workspace member shares a root lockfile, so Smart Cleanup is analysis-only here.',
    };
  }
  if (source.lockfileName === null) {
    return {
      executionSupported: false,
      reason: 'Smart Cleanup needs a supported lockfile before it can execute removals.',
    };
  }
  if (source.lockfileName === 'npm-shrinkwrap.json') {
    return {
      executionSupported: false,
      reason: 'npm-shrinkwrap projects are analysis-only in this Smart Cleanup release.',
    };
  }
  if (source.packageManager !== 'npm' && source.packageManager !== 'pnpm') {
    return {
      executionSupported: false,
      reason: `Smart Cleanup cannot execute with the ${source.packageManager} package manager.`,
    };
  }
  return { executionSupported: true };
}
