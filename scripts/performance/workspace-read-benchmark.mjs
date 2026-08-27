#!/usr/bin/env node

/**
 * Deterministic workspace-read amplification benchmark. Legacy counts are a
 * clearly labelled model of the removed two-pass flow; current counts are
 * observed by running the real bounded scanner, planner, cache state, and
 * join-eligibility seam without depending on VS Code or machine disk cache.
 */

import { performance } from 'node:perf_hooks';

import { computeSourceFingerprint } from '../../out/core/cache/sourceFingerprint.js';
import { scanFilesBounded } from '../../out/core/usage/boundedFileScan.js';
import { planWorkspaceAnalysisFiles } from '../../out/core/usage/workspaceAnalysisPlan.js';
import {
  UsageAnalysisState,
  canJoinBackgroundUsageScan,
} from '../../out/host/usage/usageAnalysisState.js';

const SOURCE_COUNT = 6_000;
const BYTES_PER_FILE = 4_096;
const sourcePaths = Array.from({ length: SOURCE_COUNT }, (_, index) =>
  index < 12 ? `tool-${index}.config.ts` : `src/file-${index}.ts`
);
const configPaths = [
  '.eslintrc',
  '.babelrc',
  'tsconfig.json',
  ...Array.from({ length: 12 }, (_, index) => `tool-${index}.config.ts`),
];

const startedAt = performance.now();
const plan = planWorkspaceAnalysisFiles(sourcePaths, configPaths);
const elapsedMs = performance.now() - startedAt;
const legacyReadsPerScan = sourcePaths.length + configPaths.length;
const currentIo = { stats: 0, reads: 0, bytes: 0, consumed: 0 };
const fixtureText = 'x'.repeat(BYTES_PER_FILE);
const currentScan = await scanFilesBounded({
  items: plan,
  read: async () => {
    currentIo.stats += 1;
    currentIo.reads += 1;
    currentIo.bytes += BYTES_PER_FILE;
    return fixtureText;
  },
  consume: () => { currentIo.consumed += 1; },
});

const fingerprint = computeSourceFingerprint({ manifestText: '{}', lockfileText: null, lockfilePath: null });
const state = new UsageAnalysisState(600_000);
const identity = state.identity('benchmark-project', fingerprint);
for (const packageName of ['react', 'vite']) {
  state.set('benchmark-project', packageName, identity, {
    packageName,
    references: [],
    truncated: false,
    scannedFileCount: SOURCE_COUNT,
    scannedAt: '2026-08-27T00:00:00.000Z',
  });
}
const cleanupFeedsRemoval = state.getComplete('benchmark-project', ['react', 'vite'], identity) !== undefined;
const cacheHits = state.getComplete('benchmark-project', ['react', 'vite'], identity)?.size ?? 0;
const foregroundCanJoin = canJoinBackgroundUsageScan({
  backgroundOwner: true,
  scanProjectId: 'benchmark-project',
  requestedProjectId: 'benchmark-project',
  scanIdentity: identity,
  requestedIdentity: identity,
  scannedPackages: new Set(['react', 'vite']),
  requestedPackages: ['react'],
});

const report = {
  interpretation: {
    legacy: 'modeled from the removed sequential source/config and cleanup/removal flow',
    current: 'measured through the current planner, bounded scanner, cache, and join seam',
    excludes: 'VS Code discovery latency and physical filesystem timing',
  },
  fixture: {
    sourceDiscoveries: sourcePaths.length,
    configDiscoveries: configPaths.length,
    overlappingDiscoveries: sourcePaths.length + configPaths.length - plan.length,
    uniqueFiles: plan.length,
    planningMs: Number(elapsedMs.toFixed(3)),
  },
  cleanupThenRemoval: {
    modeledLegacy: {
      scans: 2,
      stats: legacyReadsPerScan * 2,
      reads: legacyReadsPerScan * 2,
      bytes: legacyReadsPerScan * 2 * BYTES_PER_FILE,
      cacheHits: 0,
    },
    measuredCurrent: {
      scans: 1,
      stats: currentIo.stats,
      reads: currentIo.reads,
      bytes: currentIo.bytes,
      consumed: currentIo.consumed,
      cacheHits,
    },
  },
  backgroundCleanupWithForegroundRemoval: {
    modeledLegacy: {
      scans: 1,
      reads: legacyReadsPerScan,
      foregroundOutcome: 'ANALYSIS_IN_PROGRESS',
      joinedScans: 0,
    },
    measuredCurrent: {
      scans: 1,
      reads: currentIo.reads,
      foregroundOutcome: foregroundCanJoin ? 'joined-result' : 'not-compatible',
      joinedScans: foregroundCanJoin ? 1 : 0,
    },
  },
};

console.log('Deterministic modeled/measured workspace read benchmark');
console.log(JSON.stringify(report, null, 2));

if (!cleanupFeedsRemoval) throw new Error('cleanup results did not satisfy complete removal reuse');
if (currentScan.processed !== plan.length || currentScan.cancelled) throw new Error('bounded scanner did not process the fixture');
if (currentIo.reads >= legacyReadsPerScan) throw new Error('overlapping config reads were not removed');
if (!foregroundCanJoin) throw new Error('compatible foreground scan did not join');
