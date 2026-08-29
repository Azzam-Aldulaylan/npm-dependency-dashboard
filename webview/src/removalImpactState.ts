import type { RemovalAssessment } from '../../src/core/types.js';

/**
 * The one shared client-side removal-impact state, driven by
 * `analyze-removal-impact`/`removal-impact-*` — reused by both the bulk
 * Review step (ManageDependenciesModal) and the single-package "Analyze
 * removal" card (ManageDependencyModal), since both funnel through the
 * identical host-owned batched engine (see usageCoordinator.ts's
 * handleAnalyzeRemovalImpact). Keyed by package name so either caller can
 * look up just the packages it cares about; a result set only ever contains
 * the packages from whichever request produced it — see App.tsx's own
 * handler for why each response replaces the whole map rather than merging.
 */
export type RemovalImpactState =
  | { phase: 'idle' }
  | { phase: 'analyzing'; requestId: string; packages: readonly string[]; scanned: number; total: number }
  | {
      phase: 'done';
      requestId: string;
      /** Exact canonical package set this result analyzed; selection coverage is equality, never subset containment. */
      packages: readonly string[];
      assessments: ReadonlyMap<string, { assessment: RemovalAssessment; usageId: string }>;
      generatedAt: string;
    }
  | { phase: 'error'; requestId: string; packages: readonly string[]; message: string };

/** Shared label vocabulary for a RemovalAssessment's status — one source of truth for both ManageDependenciesModal and ManageDependencyModal. */
export const REMOVAL_IMPACT_LABEL: Record<RemovalAssessment['status'], string> = {
  'low-risk': 'Low risk',
  review: 'Review required',
  blocked: 'Removal blocked',
  unknown: 'Unknown',
};
