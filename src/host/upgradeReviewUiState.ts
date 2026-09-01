import type {
  DashboardData,
  HostToWebviewMessage,
  UpgradeAnalysisChange,
  UpgradeAnalysisSmartPlanChange,
  UpgradeResultPresentation,
} from './webviewProtocol.js';
import { isUpgradeAnalysisSoftStale } from './upgradeFreshness.js';

/** Dashboard enrichment is not a review lifecycle event. Preserve the reader's
 * results for the same project. A revalidating dashboard is not proof that
 * analysis inputs changed. Host content checks and expiry still own execution. */
export function upgradeReviewDashboardEffect(
  activePackage: string | null,
  previous: DashboardData | null,
  incoming: HostToWebviewMessage
): 'reset' | 'preserve' | 'mark-stale' {
  if (activePackage === null || previous === null || !('data' in incoming)) return 'reset';
  const next = incoming.data;
  if (
    previous.project.label !== next.project.label ||
    previous.project.manifestPath !== next.project.manifestPath ||
    !next.rows.some((row) => row.name === activePackage)
  ) return 'reset';
  // Ignore revalidation notices with identical data and metadata/severity/
  // generatedAt changes, never local versions
  // or declarations (including other roots in a coordinated upgrade).
  const previousRows = new Map(previous.rows.map((row) => [row.name, row]));
  const declarationsChanged = next.rows.length !== previous.rows.length || next.rows.some((row) => {
    const prior = previousRows.get(row.name);
    return prior === undefined || prior.current !== row.current || prior.range !== row.range ||
      prior.dev !== row.dev || prior.optional !== row.optional;
  });
  return declarationsChanged ? 'mark-stale' : 'preserve';
}

/**
 * Presentation-only lifecycle for the one targeted enrichment started by an
 * applied upgrade. The refresh id is host-minted and is the sole correlation
 * key: dashboard snapshots and terminal messages for another refresh cannot
 * complete this state accidentally.
 */
export type UpgradeEnrichmentUiState =
  | { phase: 'refreshing'; refreshId: string; package: string }
  | {
      phase: 'failed';
      refreshId: string;
      package: string;
      outcome: 'failed' | 'cancelled';
      message: string;
    }
  | {
      phase: 'superseded';
      refreshId: string;
      package: string;
      message: string;
    };

export interface UpgradeEnrichmentTerminal {
  refreshId: string;
  package: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'superseded';
  error?: { message: string } | undefined;
}

export function beginUpgradeEnrichment(result: UpgradeResultPresentation): UpgradeEnrichmentUiState | null {
  return result.refreshingDerivedData
    ? { phase: 'refreshing', refreshId: result.refreshId, package: result.package }
    : null;
}

const TERMINAL_MESSAGE: Record<Exclude<UpgradeEnrichmentTerminal['outcome'], 'succeeded'>, string> = {
  failed: 'Dependency security and update data could not be refreshed.',
  cancelled: 'Dependency security and update data refresh was cancelled.',
  superseded: 'Another project change superseded this dependency data refresh.',
};

export function applyUpgradeEnrichmentTerminal(
  state: UpgradeEnrichmentUiState | null,
  terminal: UpgradeEnrichmentTerminal
): UpgradeEnrichmentUiState | null {
  if (
    state === null ||
    state.phase !== 'refreshing' ||
    state.refreshId !== terminal.refreshId ||
    state.package !== terminal.package
  ) {
    return state;
  }
  if (terminal.outcome === 'succeeded') return null;
  if (terminal.outcome === 'superseded') {
    return {
      phase: 'superseded',
      refreshId: state.refreshId,
      package: state.package,
      message: terminal.error?.message ?? TERMINAL_MESSAGE.superseded,
    };
  }
  return {
    phase: 'failed',
    refreshId: state.refreshId,
    package: state.package,
    outcome: terminal.outcome,
    message: terminal.error?.message ?? TERMINAL_MESSAGE[terminal.outcome],
  };
}

/** Retry keeps the same host-minted correlation id; the host rejects overlap. */
export function retryUpgradeEnrichment(state: UpgradeEnrichmentUiState): UpgradeEnrichmentUiState {
  return state.phase === 'failed'
    ? { phase: 'refreshing', refreshId: state.refreshId, package: state.package }
    : state;
}

/** Registry/update/advisory facts stay quarantined during and after a failed refresh. */
export function shouldQuarantineUpgradeDerivedData(state: UpgradeEnrichmentUiState | null): boolean {
  return state !== null;
}

/** Severity dots are derived from advisory data, so they share its quarantine. */
export function shouldShowUpgradeVulnerabilitySeverity(state: UpgradeEnrichmentUiState | null): boolean {
  return !shouldQuarantineUpgradeDerivedData(state);
}

/**
 * A later completed full-dashboard snapshot may abandon a targeted lifecycle
 * that has already terminated unsuccessfully. This is not targeted success:
 * callers discard the old completion card and render the authoritative
 * dashboard snapshot normally. In-flight targeted refreshes still require
 * their exact correlated terminal, and `stale`/progress/loading messages are
 * never completion evidence.
 */
export function completedDashboardSnapshotAbandonsUpgradeEnrichment(
  state: UpgradeEnrichmentUiState | null,
  status: string
): boolean {
  return (
    state !== null &&
    state.phase !== 'refreshing' &&
    (status === 'ready' || status === 'partial-error' || status === 'empty')
  );
}

export type UpgradeAnalysisFreshness = 'fresh' | 'soft-stale' | 'expired';

/**
 * A malformed/missing hard-expiry timestamp fails closed for execution. The
 * one-hour age threshold remains only a refresh recommendation; source
 * mutation is a separate host signal and never inferred here from time.
 */
export function upgradeAnalysisFreshness(
  analyzedAt: string,
  expiresAt: string,
  now: number
): UpgradeAnalysisFreshness {
  const analyzed = Date.parse(analyzedAt);
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(analyzed) || !Number.isFinite(expiry) || now >= expiry) return 'expired';
  return isUpgradeAnalysisSoftStale(analyzedAt, now) ? 'soft-stale' : 'fresh';
}

/**
 * Changes introduced or retargeted by the planner, compared with every
 * originally-requested package/target pair. This handles bulk A+B requests:
 * if the coordinated proposal is A+B+C, only C is planner-added.
 */
export function plannerAddedUpgradeChanges(
  requested: readonly Pick<UpgradeAnalysisChange, 'packageName' | 'targetVersion'>[],
  coordinated: readonly UpgradeAnalysisSmartPlanChange[]
): UpgradeAnalysisSmartPlanChange[] {
  const requestedTargets = new Map(requested.map((change) => [change.packageName, change.targetVersion]));
  return coordinated.filter((change) => requestedTargets.get(change.packageName) !== change.targetVersion);
}

export function hasPlannerAddedCoordination(
  requested: readonly Pick<UpgradeAnalysisChange, 'packageName' | 'targetVersion'>[],
  coordinated: readonly UpgradeAnalysisSmartPlanChange[]
): boolean {
  return plannerAddedUpgradeChanges(requested, coordinated).length > 0;
}

/** Makes the patched version's ownership explicit for transitive findings. */
export function remainingVulnerabilityPatchedVersionLabel(flaggedPackage: string): string {
  return `Patched version for ${flaggedPackage}`;
}

/**
 * Advisory navigation never accepts a URL. The host resolves the destination
 * from the advisory identifier already present in its trusted scan and checks
 * this exact dependency path.
 */
export function advisoryNavigationRequest(
  packageName: string,
  advisoryId: string | number,
  path: readonly string[],
  reference?: string
): {
  type: 'open-advisory';
  package: string;
  advisoryId: string | number;
  path: string[];
  reference?: string;
} {
  const request = { type: 'open-advisory' as const, package: packageName, advisoryId, path: [...path] };
  return reference === undefined ? request : { ...request, reference };
}
