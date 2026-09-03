import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { DependencyFinding } from '../../src/core/hygiene/types.js';
import type { DependencyTypeFilter as DependencyTypeFilterValue } from '../../src/host/dependencyTypeFilter.js';
import { dependencyTypeFilterCounts, dependencyTypeFilterPredicate } from '../../src/host/dependencyTypeFilter.js';
import { dependencyCountLabel } from '../../src/host/dependencySummary.js';
import { criteriaFromDashboardFilters } from '../../src/host/dependencyCriteria.js';
import { filterEmptyStateTitle } from '../../src/host/emptyStateCopy.js';
import type { HygieneFilterId } from '../../src/host/hygieneFilter.js';
import { hygieneFilterCounts, hygieneFilterPredicate } from '../../src/host/hygieneFilter.js';
import { manageRemovalReadyPackage } from '../../src/host/manageRemovalFlow.js';
import type { PageSize } from '../../src/host/pagination.js';
import { DEFAULT_PAGE_SIZE, paginate } from '../../src/host/pagination.js';
import type { SummaryFilterId } from '../../src/host/summaryMetrics.js';
import { summaryFilterPredicate, summaryMetrics } from '../../src/host/summaryMetrics.js';
import { dependencyRowMatchesSearch } from '../../src/host/vulnerabilityUiState.js';
import type { SortColumn, TableSortState } from '../../src/host/tableSort.js';
import { nextColumnSortState, sortRows } from '../../src/host/tableSort.js';
import {
  applyUpgradeResultLocalFacts,
  manageRemovalReplacesUpgradeReview,
  manageUpgradeReplacesRemovalReview,
  targetChangeInvalidatesManageAnalysis,
  upgradeAnalysisMessageMatchesRequest,
  upgradeAnalysisRequestIsAllowed,
  upgradeErrorClearsActiveState,
  upgradeErrorIsUserVisible,
} from '../../src/host/upgradeUiState.js';
import {
  advisoryNavigationRequest,
  applyUpgradeEnrichmentTerminal,
  beginUpgradeEnrichment,
  completedDashboardSnapshotAbandonsUpgradeEnrichment,
  retryUpgradeEnrichment,
  shouldQuarantineUpgradeDerivedData,
  upgradeReviewDashboardEffect,
} from '../../src/host/upgradeReviewUiState.js';
import type { UpgradeEnrichmentUiState } from '../../src/host/upgradeReviewUiState.js';
import type {
  DashboardData,
  HostToWebviewMessage,
  RemoveAnalysisPresentation,
  ScanProgressStage,
  SmartCleanupExecutionCapability,
  SmartCleanupDedupeActionPresentation,
  SmartCleanupDuplicateAssessmentPresentation,
  UpgradeAnalysisPresentation,
  UpgradeResultPresentation,
} from '../../src/host/webviewProtocol.js';
import { isHostToWebviewMessage } from '../../src/host/webviewProtocol.js';
import type { UpgradeAnalysisSections } from '../../src/host/upgradeAnalysisSections.js';
import { applyPartialSection, markPhaseLoading, WAITING_UPGRADE_ANALYSIS_SECTIONS } from '../../src/host/upgradeAnalysisSections.js';
import { DashboardToolbar } from './components/DashboardToolbar.js';
import { DependencyEmptyState } from './components/DependencyEmptyState.js';
import { DependencyLoadingState } from './components/DependencyLoadingState.js';
import { DependencySearch } from './components/DependencySearch.js';
import { DependencyTypeFilter } from './components/DependencyTypeFilter.js';
import { HygieneFilter } from './components/HygieneFilter.js';
import { ManageDependenciesModal } from './components/ManageDependenciesModal.js';
import type { BulkUpgradeCandidate } from './components/ManageDependenciesModal.js';
import { ManageDependencyModal } from './components/ManageDependencyModal.js';
import type { ManageTabId } from './components/ManageDependencyModal.js';
import { Pagination } from './components/Pagination.js';
import { PackageTable } from './components/PackageTable.js';
import { RemoveAnalysisModal } from './components/RemoveAnalysisModal.js';
import { SummaryCards } from './components/SummaryCards.js';
import { SmartCleanupWorkspace } from './components/SmartCleanupWorkspace.js';
import { StatusBanner } from './components/StatusBanner.js';
import { UpgradeAnalysisModal } from './components/UpgradeAnalysisModal.js';
import type { UpgradeTargetLoadState } from './components/UpgradeTargetSelector.js';
import type { UsageRequestState } from './components/UsageReferencesPanel.js';
import { IconBroom, IconListChecks, IconRefresh } from './icons.js';
import type { RemovalImpactState } from './removalImpactState.js';
import { remediationPlanFromState } from './transitiveRemediationState.js';
import type { TransitiveFixUiState } from './transitiveRemediationState.js';
import { buildSmartCleanupPlan } from './smartCleanupPlanAdapter.js';
import {
  createSmartCleanupState,
  SMART_CLEANUP_REVIEW_CACHE_MS,
  selectedSmartCleanupDedupeAction,
  smartCleanupReducer,
  smartCleanupReviewIsReusable,
} from './smartCleanupState.js';
import type { SmartCleanupResult, SmartCleanupReviewCacheIdentity } from './smartCleanupState.js';
import { vscode } from './vscodeApi.js';

function formatTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

function partialErrorText(data: DashboardData): string | null {
  const reasons: string[] = [];
  if (data.availability.updates === 'partial') {
    const unavailable = data.availability.unavailableUpdatePackages.length;
    reasons.push(`${unavailable} package update check${unavailable === 1 ? '' : 's'} unavailable`);
  }
  if (data.advisoriesError !== undefined) {
    reasons.push(`vulnerability data is unavailable (${data.advisoriesError.code})`);
  }
  if (data.auditUnavailable === true) {
    reasons.push('npm audit could not run, so upgrade targets are self-computed');
  }
  return reasons.length === 0 ? null : reasons.join('; ');
}

function duplicateGroupCount(data: DashboardData): number {
  return data.hygieneFindings.filter((finding) => finding.kind === 'duplicate-version').length;
}

function excessDuplicateVersionCount(data: DashboardData): number {
  return data.hygieneFindings.reduce((count, finding) => {
    if (finding.kind !== 'duplicate-version' || finding.evidence.kind !== 'duplicate-version') return count;
    return count + Math.max(0, finding.evidence.versions.length - 1);
  }, 0);
}

function smartCleanupProjectKey(data: DashboardData): string {
  return `${data.project.label}\u0000${data.project.manifestPath}`;
}

interface SmartCleanupExecutionSnapshot {
  before: DashboardData;
  actionIds: readonly string[];
  packages: readonly string[];
  analysisId: string | null;
  /** Smart Cleanup analysis request, used to resolve the opaque dedupe action and cancel the combined review. */
  requestId: string;
  removalRequestId?: string;
  dedupeActionId?: string;
}

interface UpgradeErrorState {
  package: string;
  code: string;
  message: string;
}

export function App(): ReactElement {
  const [message, setMessage] = useState<HostToWebviewMessage | undefined>(undefined);
  const [scanProgress, setScanProgress] = useState<{
    stage: ScanProgressStage;
    completed?: number;
    total?: number;
  } | undefined>(undefined);
  const initialRenderStartedAt = useRef<number | null>(null);
  const initialRenderMeasured = useRef(false);
  // The anchor package for the upgrade flow this webview most recently
  // requested, or null. A coordinated request may contain more changes, but
  // the host still owns one project-wide transaction/lock and identifies the
  // flow by its first, host-validated change.
  const [activeUpgrade, setActiveUpgrade] = useState<string | null>(null);
  // The anchor target plus the selected set let the modal show honest loading
  // copy before the host's `upgrade-analysis` reply carries the real analysis.
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [activeUpgradeChanges, setActiveUpgradeChanges] = useState<readonly BulkUpgradeCandidate[]>([]);
  const [upgradeError, setUpgradeError] = useState<UpgradeErrorState | null>(null);
  // The host-owned analysis for `activeUpgrade`, once it arrives — never
  // constructed or edited here, only ever stored as received and echoed
  // back by its own `analysisId` on confirm/cancel/use-smart-plan.
  const [analysis, setAnalysis] = useState<UpgradeAnalysisPresentation | null>(null);
  const [analyzingPhase, setAnalyzingPhase] = useState<'compatibility' | 'project-compatibility' | 'smart-plan' | null>(null);
  // Per-section progressive state for the active analysis attempt — see
  // src/host/upgradeAnalysisSections.ts. Reset to WAITING_UPGRADE_ANALYSIS_SECTIONS
  // every time a fresh `upgrade`/`bulk-upgrade` request is issued; superseded
  // (not read) once `analysis` itself is non-null.
  const [analysisSections, setAnalysisSections] = useState<UpgradeAnalysisSections>(WAITING_UPGRADE_ANALYSIS_SECTIONS);
  // Non-null exactly when the host has flagged the currently-displayed
  // `analysis` as structurally stale (its own `analysisId` matches) — see
  // `upgrade-analysis-stale` in webviewProtocol.ts. A pure UX hint; Confirm/
  // Use-smart-plan still always re-validate host-side regardless.
  const [hardStaleAnalysisId, setHardStaleAnalysisId] = useState<string | null>(null);
  // True from the moment Confirm/Use coordinated upgrade is clicked until a
  // terminal message (upgrade-error, or any fresh dashboard snapshot
  // following success) arrives — disables the modal's own buttons so a
  // second click can't fire a second confirm-upgrade for the same analysis.
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Mirrors `activeUpgrade` for the message handler below, which is
  // registered once (empty dependency array) and would otherwise only ever
  // see the `null` it closed over on the first render.
  const activeUpgradeRef = useRef<string | null>(null);
  useEffect(() => {
    activeUpgradeRef.current = activeUpgrade;
  }, [activeUpgrade]);
  // Mirrors `analysis?.analysisId` for the message handler below, same
  // reason as activeUpgradeRef — lets the (registered-once) `upgrade-
  // analysis-stale` handler ignore a hint about an analysis this webview
  // isn't even displaying anymore.
  const analysisIdRef = useRef<string | null>(null);
  useEffect(() => {
    analysisIdRef.current = analysis?.analysisId ?? null;
  }, [analysis]);
  // A monotonic, client-minted correlation id for the current analysis
  // attempt — see webviewProtocol.ts's own doc on `requestId`. Distinguishes
  // two sequential analyses for the *same* package (e.g. Cancel then
  // Analyze again) the way `activeUpgradeRef`'s package-name-only guard
  // alone cannot; every `upgrade-analyzing`/`upgrade-analysis-partial`/
  // `upgrade-analysis` message not matching `activeRequestIdRef.current` is
  // dropped as stale/superseded. A plain incrementing counter, not
  // `crypto.randomUUID()` — this is a pure local-session correlation nonce
  // with no security requirement for unguessability.
  const nextRequestIdRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);

  // Same anchor/lock discipline as the upgrade state above, for a
  // coordinated removal — the two share one host-side panel-wide lock, so
  // only one of activeUpgrade/activeRemove is ever non-null at a time.
  const [activeRemove, setActiveRemove] = useState<string | null>(null);
  const [activeRemoveChanges, setActiveRemoveChanges] = useState<readonly string[]>([]);
  // "Why matched" tags from the criteria picker's own selection at the
  // moment Remove was clicked — display-only, computed client-side, never
  // sent to or trusted from the host.
  const [removeMatchTags, setRemoveMatchTags] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const [removeAnalysis, setRemoveAnalysis] = useState<RemoveAnalysisPresentation | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<UpgradeErrorState | null>(null);
  // Set only when this removal review was opened from the Manage dependency
  // modal (requestRemoveFromManage) — lets the review show "← Back" instead
  // of "Cancel" and return to Manage rather than the dashboard. Starting a
  // removal from Manage never clears `manageRow`, so "closing" this review
  // is enough to reveal Manage again with its state intact.
  const [removeOrigin, setRemoveOrigin] = useState<'dashboard' | 'manage-dependency' | 'smart-cleanup' | null>(null);
  const removeOriginRef = useRef<'dashboard' | 'manage-dependency' | 'smart-cleanup' | null>(null);
  const activeRemoveRef = useRef<string | null>(null);
  useEffect(() => {
    activeRemoveRef.current = activeRemove;
  }, [activeRemove]);
  useEffect(() => {
    removeOriginRef.current = removeOrigin;
  }, [removeOrigin]);

  // UI-only, entirely derived from data already on screen — see
  // src/host/{summaryMetrics,dependencyTypeFilter,tableSort,pagination}.ts.
  // None of this ever triggers a re-scan or a postMessage; all of it simply
  // narrows/reorders/slices `data.rows` for PackageTable. Lifted up here
  // (rather than living inside <Dashboard>) so it survives an intermediate
  // loading/fatal-error blip that unmounts <Dashboard> — the whole point of
  // "persist while the panel session is open" is that these do not depend
  // on `message` still carrying data.
  const [search, setSearch] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<SummaryFilterId>('all');
  const [dependencyType, setDependencyType] = useState<DependencyTypeFilterValue>('all');
  const [hygieneFilter, setHygieneFilter] = useState<HygieneFilterId>('all');
  // The dashboard opens sorted by vulnerability severity, worst first — the
  // one piece of information most worth seeing before any interaction, even
  // matching the default "all" card's own implied order (see
  // cardDefaultComparator). A real column sort state, not `null`, so the
  // Vulnerabilities header shows its descending indicator immediately on
  // first render rather than only after a manual click. Selecting a summary
  // card still resets to that card's own default (handleSelectFilter below)
  // — this initial value only governs the very first render.
  const [sortState, setSortState] = useState<TableSortState>({ column: 'vulnerabilities', direction: 'desc' });
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);

  // This webview session's own record of which packages it has asked the
  // host to run "Analyze remediation" for, and what came back — never a
  // fact about the dependency itself (PackageRow carries none of this), so
  // it is cleared, like every other optimistic upgrade-adjacent state below,
  // the moment a fresh scan supersedes it.
  const [remediationByPackage, setRemediationByPackage] = useState<ReadonlyMap<string, TransitiveFixUiState>>(
    () => new Map()
  );
  const [remediationError, setRemediationError] = useState<{ package: string; message: string } | null>(null);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);

  // The row this webview session currently has "Manage dependency" open
  // for, and its own on-demand usage-analysis state per package — never a
  // fact from the host's own scan. Starting a removal or upgrade review
  // *from* Manage deliberately leaves this set (rather than clearing it) so
  // the workspace stays open the whole time — see requestRemoveFromManage
  // and the Manage dependency render block below.
  const [manageRow, setManageRow] = useState<string | null>(null);
  // Which of Manage's five sections is showing — reset to 'overview'
  // whenever a fresh Manage session opens (openManage) or the underlying
  // scan is superseded. Lifted up here (rather than local to
  // ManageDependencyModal) because Overview's own action cards need to
  // switch it from outside the tab they're rendered in.
  const [manageTab, setManageTab] = useState<ManageTabId>('overview');
  const [upgradeTargetState, setUpgradeTargetState] = useState<UpgradeTargetLoadState>({ phase: 'idle' });
  const [selectedManageTarget, setSelectedManageTarget] = useState<string | null>(null);
  const nextTargetRequestIdRef = useRef(0);
  const activeTargetRequestIdRef = useRef<string | null>(null);
  // Which surface started the currently-active upgrade — 'manage-dependency'
  // (Manage's Upgrade review tab, reviewed inline, never a second dialog) or
  // 'dashboard' (the bulk "Manage dependencies" flow, which still opens the
  // standalone UpgradeAnalysisModal). Same split removeOrigin already uses
  // for removal below.
  const [upgradeOrigin, setUpgradeOrigin] = useState<'dashboard' | 'manage-dependency' | null>(null);
  const [upgradeResult, setUpgradeResult] = useState<UpgradeResultPresentation | null>(null);
  const upgradeResultRef = useRef<UpgradeResultPresentation | null>(null);
  const [upgradeEnrichment, setUpgradeEnrichment] = useState<UpgradeEnrichmentUiState | null>(null);
  const upgradeEnrichmentRef = useRef<UpgradeEnrichmentUiState | null>(null);
  const pendingEnrichmentDashboardMessageRef = useRef<HostToWebviewMessage | null>(null);
  const [usageByPackage, setUsageByPackage] = useState<ReadonlyMap<string, UsageRequestState>>(() => new Map());
  // Read inside the auto-scan effect below without making it a dependency —
  // the effect must only re-run when `manageRow` itself changes (a new
  // Manage session open), never merely because some package's usage state
  // updated, or it would re-request on every progress tick / error for whichever
  // package's modal happens to still be open.
  const usageByPackageRef = useRef<ReadonlyMap<string, UsageRequestState>>(new Map());
  useEffect(() => {
    usageByPackageRef.current = usageByPackage;
  }, [usageByPackage]);
  const [cleanupState, setCleanupState] = useState<
    | { phase: 'idle' }
    | { phase: 'analyzing'; scanned: number; total: number }
    | { phase: 'done'; analyzedAt: string; cacheExpiresAt: string }
  >({ phase: 'idle' });
  const [cleanupFindings, setCleanupFindings] = useState<DependencyFinding[]>([]);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [smartCleanupOpen, setSmartCleanupOpen] = useState(false);
  const [smartCleanupState, dispatchSmartCleanup] = useReducer(
    smartCleanupReducer,
    createSmartCleanupState('Current project')
  );
  const [smartCleanupMetadata, setSmartCleanupMetadata] = useState<{
    phase: 'idle' | 'analyzing' | 'done' | 'error';
    findings: DependencyFinding[];
    unavailablePackages: string[];
    capability: SmartCleanupExecutionCapability | null;
    message?: string;
  }>({ phase: 'idle', findings: [], unavailablePackages: [], capability: null });
  const [smartCleanupDuplicates, setSmartCleanupDuplicates] = useState<{
    phase: 'idle' | 'analyzing' | 'done' | 'error';
    assessments: SmartCleanupDuplicateAssessmentPresentation[];
    action: SmartCleanupDedupeActionPresentation | null;
    unavailableReason?: string;
    message?: string;
  }>({ phase: 'idle', assessments: [], action: null });
  const smartCleanupOpenRef = useRef(false);
  const smartCleanupStateRef = useRef(smartCleanupState);
  const smartCleanupRequestIdRef = useRef(0);
  const activeSmartCleanupRequestIdRef = useRef<string | null>(null);
  const smartCleanupExecutionRef = useRef<SmartCleanupExecutionSnapshot | null>(null);
  const smartCleanupReviewCacheRef = useRef<SmartCleanupReviewCacheIdentity | null>(null);
  const smartCleanupDrilldownRef = useRef<{
    projectKey: string;
    dashboardGeneratedAt: string;
    requestId: string;
    removalImpact: RemovalImpactState;
  } | null>(null);
  const dashboardDataRef = useRef<DashboardData | null>(null);
  const dashboardSnapshotStatusRef = useRef<'empty' | 'ready' | 'stale' | 'partial-error' | null>(null);
  // The one shared removal-impact preview state — see removalImpactState.ts's
  // own doc for why the bulk Review step and the single-package "Analyze
  // removal" card share it rather than each keeping their own copy.
  const [removalImpact, setRemovalImpact] = useState<RemovalImpactState>({ phase: 'idle' });
  const nextRemovalImpactRequestIdRef = useRef(0);
  const activeRemovalImpactRequestRef = useRef<{ requestId: string; packages: readonly string[] } | null>(null);
  // A Manage-tab removal first runs this read-only impact scan. Only its
  // matching result starts the existing removal preflight; posting both at
  // once would reserve the coordinator and make the host reject the scan.
  const [pendingManageRemoval, setPendingManageRemoval] = useState<string | null>(null);
  const cleanupShouldSelectFilter = useRef(false);
  /** False immediately on Cancel so already-queued progress cannot put the cleanup banner back into analyzing. */
  const cleanupProgressActiveRef = useRef(false);
  const [minuteClock, setMinuteClock] = useState(() => Date.now());

  useEffect(() => {
    smartCleanupOpenRef.current = smartCleanupOpen;
  }, [smartCleanupOpen]);

  useEffect(() => {
    smartCleanupStateRef.current = smartCleanupState;
  }, [smartCleanupState]);

  useEffect(() => {
    const timer = window.setInterval(() => setMinuteClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // The minute clock is sufficient for the one-hour advisory copy, but the
  // host-provided execution expiry is a real authority boundary. Schedule a
  // dedicated tick at that exact deadline so an open review cannot remain
  // visibly actionable for the remainder of an arbitrary minute interval.
  useEffect(() => {
    if (analysis === null) return;
    const expiresAt = Date.parse(analysis.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      setMinuteClock(Date.now());
      return;
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setMinuteClock(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setMinuteClock(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [analysis]);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // The webview is its own security context and `message` events are not
      // exclusively ours. Anything that does not match the protocol exactly is
      // dropped rather than partially trusted.
      if (!isHostToWebviewMessage(event.data)) {
        console.warn('Dependency Dashboard: dropped a message that failed validation');
        return;
      }
      const incoming = event.data;

      if (incoming.status === 'scan-progress') {
        setScanProgress({
          stage: incoming.stage,
          ...(incoming.completed === undefined ? {} : { completed: incoming.completed }),
          ...(incoming.total === undefined ? {} : { total: incoming.total }),
        });
        return;
      }

      if (incoming.status === 'upgrade-targets-loading') {
        if (upgradeAnalysisMessageMatchesRequest(activeTargetRequestIdRef.current, incoming.requestId)) {
          setUpgradeTargetState({ phase: 'loading' });
        }
        return;
      }

      if (incoming.status === 'upgrade-targets') {
        if (upgradeAnalysisMessageMatchesRequest(activeTargetRequestIdRef.current, incoming.requestId)) {
          setUpgradeTargetState({ phase: 'ready', targets: incoming.targets });
          setSelectedManageTarget(incoming.targets.recommendedVersion);
        }
        return;
      }

      if (incoming.status === 'upgrade-targets-error') {
        if (upgradeAnalysisMessageMatchesRequest(activeTargetRequestIdRef.current, incoming.requestId)) {
          setUpgradeTargetState({ phase: 'error', error: incoming.error });
        }
        return;
      }

      if (incoming.status === 'upgrade-result') {
        const enrichment = beginUpgradeEnrichment(incoming.result);
        upgradeEnrichmentRef.current = enrichment;
        setUpgradeEnrichment(enrichment);
        pendingEnrichmentDashboardMessageRef.current = null;
        upgradeResultRef.current = incoming.result;
        setUpgradeResult(incoming.result);
        activeUpgradeRef.current = null;
        activeRequestIdRef.current = null;
        setActiveUpgrade(null);
        setActiveTarget(null);
        setActiveUpgradeChanges([]);
        setAnalysis(null);
        setAnalyzingPhase(null);
        setAnalysisSections(WAITING_UPGRADE_ANALYSIS_SECTIONS);
        setHardStaleAnalysisId(null);
        setConfirmBusy(false);
        setUpgradeError(null);
        setMessage((previous) => {
          if (previous === undefined || !('data' in previous)) return previous;
          return {
            status: 'stale',
            data: applyUpgradeResultLocalFacts(previous.data, incoming.result),
          };
        });
        return;
      }

      if (incoming.status === 'upgrade-enrichment-result') {
        const previousEnrichment = upgradeEnrichmentRef.current;
        const nextEnrichment = applyUpgradeEnrichmentTerminal(previousEnrichment, incoming);
        if (nextEnrichment === previousEnrichment) return;
        upgradeEnrichmentRef.current = nextEnrichment;
        setUpgradeEnrichment(nextEnrichment);
        const pendingResult = upgradeResultRef.current;
        if (
          pendingResult !== null &&
          pendingResult.refreshId === incoming.refreshId &&
          pendingResult.package === incoming.package
        ) {
          const completedResult = { ...pendingResult, refreshingDerivedData: false };
          upgradeResultRef.current = completedResult;
          setUpgradeResult(completedResult);
        }
        if (incoming.outcome === 'succeeded') {
          const enrichedDashboard = pendingEnrichmentDashboardMessageRef.current;
          pendingEnrichmentDashboardMessageRef.current = null;
          if (enrichedDashboard !== null && 'data' in enrichedDashboard) setMessage(enrichedDashboard);
        }
        return;
      }

      if (incoming.status === 'upgrade-error') {
        // Never touches `message` — the rendered table/banners are exactly
        // what they were before this arrived.
        if (upgradeErrorClearsActiveState(incoming.error.code)) {
          activeUpgradeRef.current = null;
          activeRequestIdRef.current = null;
          setActiveUpgrade(null);
          setActiveTarget(null);
          setActiveUpgradeChanges([]);
          setAnalysis(null);
          setAnalyzingPhase(null);
          setAnalysisSections(WAITING_UPGRADE_ANALYSIS_SECTIONS);
          setHardStaleAnalysisId(null);
          setConfirmBusy(false);
        }
        if (upgradeErrorIsUserVisible(incoming.error.code)) {
          setUpgradeError({ package: incoming.package, code: incoming.error.code, message: incoming.error.message });
        }
        return;
      }

      if (incoming.status === 'upgrade-analyzing') {
        if (upgradeAnalysisMessageMatchesRequest(activeRequestIdRef.current, incoming.requestId)) {
          setAnalyzingPhase(incoming.phase);
          setAnalysisSections((previous) => markPhaseLoading(previous, incoming.phase));
        }
        return;
      }

      if (incoming.status === 'upgrade-analysis-partial') {
        // Dropped when it isn't about the attempt this webview is still
        // tracking — a late partial from a superseded/cancelled attempt
        // (re-analyzing the same package, switching rows, etc). See
        // requestUpgrade/requestBulkUpgrade for where a fresh requestId is
        // minted and analysisSections reset.
        if (upgradeAnalysisMessageMatchesRequest(activeRequestIdRef.current, incoming.requestId)) {
          setAnalysisSections((previous) => applyPartialSection(previous, incoming.section));
        }
        return;
      }

      if (incoming.status === 'upgrade-analysis') {
        // Ignored if it's not about the flow this webview is still tracking
        // (e.g. a result that arrived just after a client-side cancel) — see
        // requestCancelUpgrade below for why this can still legitimately
        // happen even though the host is also told to drop it.
        if (upgradeAnalysisMessageMatchesRequest(activeRequestIdRef.current, incoming.requestId)) {
          analysisIdRef.current = incoming.analysis.analysisId;
          setAnalysis(incoming.analysis);
          setAnalyzingPhase(null);
        }
        return;
      }

      if (incoming.status === 'upgrade-analysis-stale') {
        // A pure UX hint — never applied to an analysis this webview isn't
        // even showing anymore (e.g. it arrived after Cancel, or after a
        // newer analysis already replaced it).
        if (incoming.analysisId === analysisIdRef.current) setHardStaleAnalysisId(incoming.analysisId);
        return;
      }

      if (incoming.status === 'remove-error') {
        const smartCleanupRemoval = removeOriginRef.current === 'smart-cleanup';
        // Same shared-lock discipline as upgrade-error — reused directly
        // since UPGRADE_IN_PROGRESS is the one code both flows post when the
        // panel-wide lock is held by the other, and neither predicate looks
        // at anything but the code string.
        if (upgradeErrorClearsActiveState(incoming.error.code)) {
          activeRemoveRef.current = null;
          setActiveRemove(null);
          setActiveRemoveChanges([]);
          setRemoveMatchTags(new Map());
          setRemoveAnalysis(null);
          setRemoveBusy(false);
        }
        setPendingManageRemoval(null);
        if (!smartCleanupRemoval && upgradeErrorIsUserVisible(incoming.error.code)) {
          setRemoveError({ package: incoming.package, code: incoming.error.code, message: incoming.error.message });
        }
        if (smartCleanupRemoval) {
          if (incoming.error.code === 'STALE_SOURCE' || incoming.error.code === 'STALE_ANALYSIS') {
            dispatchSmartCleanup({ type: 'source-stale', message: incoming.error.message });
          } else if (
            incoming.error.code !== 'ROLLBACK_CONFLICT' &&
            incoming.error.code !== 'ROLLBACK_FAILED' &&
            incoming.error.code !== 'REMOVE_TRANSACTION_FAILED' &&
            incoming.error.code !== 'UNKNOWN'
          ) {
            dispatchSmartCleanup({
              type: 'operation-rejected',
              message: `${incoming.error.message} No cleanup changes were made.`,
            });
          } else {
            const snapshot = smartCleanupExecutionRef.current;
            const failedIds = snapshot?.actionIds ?? [];
            const result: SmartCleanupResult = {
              metrics: [],
              completedActionIds: [],
              skippedActionIds: [],
              failedActionIds: [...failedIds],
              resolvedAdvisories: [],
              introducedAdvisories: [],
              verification: 'not-run',
              rollback: 'incomplete',
              detail: incoming.error.message,
            };
            dispatchSmartCleanup({ type: 'execution-incomplete', result, message: incoming.error.message });
          }
          smartCleanupExecutionRef.current = null;
          activeSmartCleanupRequestIdRef.current = null;
          activeRemoveRef.current = null;
          removeOriginRef.current = null;
          setActiveRemove(null);
          setActiveRemoveChanges([]);
          setRemoveMatchTags(new Map());
          setRemoveAnalysis(null);
          setRemoveBusy(false);
          setRemoveError(null);
          setRemoveOrigin(null);
        }
        return;
      }

      if (incoming.status === 'remove-analyzing') {
        // Already reflected by removeAnalysis === null while activeRemove is
        // set — this flow has no observable multi-phase preflight the way an
        // upgrade's compatibility/smart-plan check does, so there's nothing
        // further to update here.
        return;
      }

      if (incoming.status === 'remove-analysis') {
        const smartSnapshot = smartCleanupExecutionRef.current;
        const smartPackagesMatch = smartSnapshot !== null &&
          incoming.analysis.changes.length === smartSnapshot.packages.length &&
          incoming.analysis.changes.every((change, index) => change.packageName === smartSnapshot.packages[index]);
        const smartDedupeMatches = smartSnapshot !== null &&
          incoming.analysis.dedupe?.actionId === smartSnapshot.dedupeActionId;
        if (
          incoming.analysis.package === activeRemoveRef.current &&
          (removeOriginRef.current !== 'smart-cleanup' || (smartPackagesMatch && smartDedupeMatches))
        ) {
          setRemoveAnalysis(incoming.analysis);
          if (removeOriginRef.current === 'smart-cleanup') {
            smartCleanupExecutionRef.current = smartSnapshot === null
              ? null
              : { ...smartSnapshot, analysisId: incoming.analysis.analysisId };
            setRemoveBusy(false);
          }
        }
        return;
      }

      if (incoming.status === 'remove-result') {
        if (removeOriginRef.current === 'smart-cleanup') {
          const snapshot = smartCleanupExecutionRef.current;
          const resultPackagesMatch = snapshot !== null &&
            incoming.result.analysisId === snapshot.analysisId &&
            incoming.result.packages.length === snapshot.packages.length &&
            incoming.result.packages.every((name, index) => name === snapshot.packages[index]);
          if (!resultPackagesMatch) return;
          const hostCompletion = incoming.result.smartCleanup;
          if (snapshot !== null && hostCompletion !== undefined) {
            const kept = incoming.result.outcome !== 'rolled-back';
            const result: SmartCleanupResult = {
              metrics: hostCompletion.metrics,
              completedActionIds: kept ? hostCompletion.completedActionIds : [],
              skippedActionIds: kept ? hostCompletion.skippedActionIds : [...snapshot.actionIds],
              failedActionIds: kept ? hostCompletion.failedActionIds : [],
              resolvedAdvisories: hostCompletion.removedAdvisories,
              introducedAdvisories: hostCompletion.introducedAdvisories,
              verification: incoming.result.verification === 'passed'
                ? 'passed'
                : incoming.result.verification === 'failed'
                  ? 'failed'
                  : 'not-run',
              rollback: incoming.result.outcome === 'rolled-back' ? 'restored' : 'not-needed',
              detail: [incoming.result.message, hostCompletion.reason].filter((part) => part !== undefined).join(' '),
            };
            dispatchSmartCleanup(incoming.result.outcome === 'rolled-back'
              ? { type: 'execution-cancelled-and-restored', result }
              : incoming.result.outcome === 'verified' && hostCompletion.status === 'verified'
                ? { type: 'execution-complete', result }
                : {
                    type: 'execution-incomplete',
                    result,
                    message: hostCompletion.status === 'stale'
                      ? 'Cleanup finished, but the final project source changed before results could be verified.'
                      : 'Cleanup finished, but some refreshed result evidence was unavailable.',
                  });
          } else {
          const after = dashboardDataRef.current;
          const afterStatus = dashboardSnapshotStatusRef.current;
          if (
            snapshot !== null &&
            (after === null || after === snapshot.before || afterStatus === null || afterStatus === 'stale')
          ) {
            const kept = incoming.result.outcome !== 'rolled-back';
            const result: SmartCleanupResult = {
              metrics: [],
              completedActionIds: kept ? [...snapshot.actionIds] : [],
              skippedActionIds: kept ? [] : [...snapshot.actionIds],
              failedActionIds: [],
              resolvedAdvisories: [],
              introducedAdvisories: [],
              verification: incoming.result.verification === 'passed'
                ? 'passed'
                : incoming.result.verification === 'failed'
                  ? 'failed'
                  : 'not-run',
              rollback: incoming.result.outcome === 'rolled-back' ? 'restored' : 'not-needed',
              detail: `${incoming.result.message} Fresh dashboard evidence was unavailable, so before/after metrics could not be verified.`,
            };
            dispatchSmartCleanup(
              incoming.result.outcome === 'rolled-back'
                ? { type: 'execution-cancelled-and-restored', result }
                : {
                    type: 'execution-incomplete',
                    result,
                    message: 'Cleanup finished, but the refreshed project state could not be verified.',
                  }
            );
          } else if (snapshot !== null && after !== null) {
            const kept = incoming.result.outcome !== 'rolled-back';
            const metrics: SmartCleanupResult['metrics'] = [
              {
                id: 'dependencies',
                label: 'Direct dependencies',
                before: snapshot.before.rows.length,
                after: after.rows.length,
                detail: kept
                  ? `${Math.max(0, snapshot.before.rows.length - after.rows.length)} removed`
                  : 'Dependency files were restored',
              },
              {
                id: 'duplicate-groups',
                label: 'Duplicate-version groups',
                before: duplicateGroupCount(snapshot.before),
                after: duplicateGroupCount(after),
                detail: 'Measured from the refreshed dependency graph',
              },
              {
                id: 'excess-versions',
                label: 'Excess resolved versions',
                before: excessDuplicateVersionCount(snapshot.before),
                after: excessDuplicateVersionCount(after),
                detail: 'Versions beyond one resolved version per package',
              },
              ...(snapshot.before.availability.advisories === 'complete' && after.availability.advisories === 'complete'
                ? [
                    {
                      id: 'vulnerable-dependencies' as const,
                      label: 'Vulnerable direct dependencies',
                      before: summaryMetrics(snapshot.before.rows).vulnerable,
                      after: summaryMetrics(after.rows).vulnerable,
                      detail: 'Matches the dashboard Vulnerable Dependencies count',
                    },
                    {
                      id: 'advisory-findings' as const,
                      label: 'Advisory findings',
                      before: summaryMetrics(snapshot.before.rows).advisoryFindings,
                      after: summaryMetrics(after.rows).advisoryFindings,
                      detail: 'Distinct advisory records across the installed graph',
                    },
                  ]
                : []),
            ];
            const result: SmartCleanupResult = {
              metrics,
              completedActionIds: kept ? [...snapshot.actionIds] : [],
              skippedActionIds: kept ? [] : [...snapshot.actionIds],
              failedActionIds: [],
              resolvedAdvisories: [],
              introducedAdvisories: [],
              verification: incoming.result.verification === 'passed'
                ? 'passed'
                : incoming.result.verification === 'failed'
                  ? 'failed'
                  : 'not-run',
              rollback: incoming.result.outcome === 'rolled-back' ? 'restored' : 'not-needed',
              detail: incoming.result.message,
            };
            dispatchSmartCleanup(incoming.result.outcome === 'rolled-back'
              ? { type: 'execution-cancelled-and-restored', result }
              : incoming.result.outcome === 'verified'
                ? { type: 'execution-complete', result }
                : {
                    type: 'execution-incomplete',
                    result,
                    message: 'Cleanup was kept, but configured verification did not prove the result.',
                  });
          }
          }
          smartCleanupExecutionRef.current = null;
          activeSmartCleanupRequestIdRef.current = null;
          activeRemoveRef.current = null;
          removeOriginRef.current = null;
          setActiveRemove(null);
          setActiveRemoveChanges([]);
          setRemoveMatchTags(new Map());
          setRemoveAnalysis(null);
          setRemoveBusy(false);
          setRemoveOrigin(null);
        }
        return;
      }

      if (incoming.status === 'remediation-analyzing') {
        setRemediationByPackage((previous) => {
          const next = new Map(previous);
          next.set(incoming.package, { phase: 'analyzing' });
          return next;
        });
        return;
      }

      if (incoming.status === 'remediation-result') {
        setRemediationByPackage((previous) => {
          const next = new Map(previous);
          next.set(incoming.package, { phase: 'legacy-result', status: incoming.result.status });
          return next;
        });
        return;
      }

      if (incoming.status === 'remediation-plan') {
        setRemediationError(null);
        setRemediationByPackage((previous) => {
          const next = new Map(previous);
          next.set(incoming.package, { phase: 'plan', plan: incoming.plan, reviewed: false });
          return next;
        });
        return;
      }

      if (incoming.status === 'remediation-applying') {
        setRemediationByPackage((previous) => {
          const prior = previous.get(incoming.package);
          const plan = remediationPlanFromState(prior);
          if (plan === null || plan.analysisId !== incoming.analysisId) return previous;
          const next = new Map(previous);
          next.set(incoming.package, {
            phase: 'applying',
            plan,
            progress: incoming.phase,
            cancelRequested: incoming.cancelRequested ?? false,
          });
          return next;
        });
        return;
      }

      if (incoming.status === 'remediation-stale') {
        setRemediationByPackage((previous) => {
          const prior = previous.get(incoming.package);
          const plan = remediationPlanFromState(prior);
          if (plan === null || plan.analysisId !== incoming.analysisId) return previous;
          const next = new Map(previous);
          next.set(incoming.package, { phase: 'stale', plan, message: incoming.message });
          return next;
        });
        return;
      }

      if (incoming.status === 'remediation-apply-result') {
        setRemediationByPackage((previous) => {
          const prior = previous.get(incoming.package);
          const plan = remediationPlanFromState(prior);
          if (plan === null || plan.analysisId !== incoming.analysisId) return previous;
          const next = new Map(previous);
          next.set(incoming.package, { phase: 'result', plan, result: incoming.result });
          return next;
        });
        return;
      }

      if (incoming.status === 'remediation-error') {
        setRemediationByPackage((previous) => {
          const next = new Map(previous);
          next.set(
            incoming.package,
            incoming.error.code === 'NO_REMEDIATION_NEEDED'
              ? {
                  phase: 'not-needed',
                  message: 'The current dependency tree has no transitive vulnerabilities that need a fix.',
                }
              : { phase: 'error', message: incoming.error.message }
          );
          return next;
        });
        setRemediationError(null);
        return;
      }

      if (incoming.status === 'usage-analyzing') {
        setUsageByPackage((previous) => {
          const next = new Map(previous);
          next.set(incoming.package, { phase: 'analyzing' });
          return next;
        });
        return;
      }

      if (incoming.status === 'usage-result') {
        setUsageByPackage((previous) => {
          const next = new Map(previous);
          next.set(incoming.package, {
            phase: 'done',
            usageId: incoming.analysis.usageId,
            result: incoming.analysis.result,
            cacheExpiresAt: incoming.analysis.cacheExpiresAt,
            fromCache: incoming.analysis.fromCache,
          });
          return next;
        });
        return;
      }

      if (incoming.status === 'usage-error') {
        setUsageByPackage((previous) => {
          const next = new Map(previous);
          next.set(incoming.package, { phase: 'error', message: incoming.error.message });
          return next;
        });
        return;
      }

      if (incoming.status === 'cleanup-analyzing') {
        if (cleanupProgressActiveRef.current) {
          setCleanupState({ phase: 'analyzing', scanned: incoming.scanned, total: incoming.total });
        }
        return;
      }

      if (incoming.status === 'cleanup-result') {
        cleanupProgressActiveRef.current = false;
        setCleanupState({
          phase: 'done',
          analyzedAt: incoming.analyzedAt,
          cacheExpiresAt: incoming.cacheExpiresAt,
        });
        setCleanupFindings(incoming.findings);
        if (Date.parse(incoming.cacheExpiresAt) <= Date.now()) {
          smartCleanupReviewCacheRef.current = null;
          if (activeSmartCleanupRequestIdRef.current !== null) {
            dispatchSmartCleanup({
              type: 'source-stale',
              message: 'Project source changed after this cleanup review. Analyze again to refresh the evidence.',
            });
          }
        }
        if (cleanupShouldSelectFilter.current) {
          cleanupShouldSelectFilter.current = false;
          setHygieneFilter('likely-unused');
          setPage(1);
        }
        return;
      }

      if (incoming.status === 'cleanup-error') {
        cleanupProgressActiveRef.current = false;
        cleanupShouldSelectFilter.current = false;
        setCleanupState({ phase: 'idle' });
        setCleanupError(incoming.error.message);
        if (smartCleanupOpenRef.current) {
          dispatchSmartCleanup({
            type: incoming.error.code === 'CANCELLED' ? 'analysis-cancelled' : 'analysis-failed',
            requestId: `smart-cleanup-${smartCleanupRequestIdRef.current}`,
            message: incoming.error.message,
          });
        }
        return;
      }

      if (incoming.status === 'smart-cleanup-metadata-analyzing') {
        if (incoming.requestId !== activeSmartCleanupRequestIdRef.current) return;
        setSmartCleanupMetadata((previous) => ({
          ...previous,
          phase: 'analyzing',
        }));
        return;
      }

      if (incoming.status === 'smart-cleanup-metadata-result') {
        if (incoming.requestId !== activeSmartCleanupRequestIdRef.current) return;
        setSmartCleanupMetadata({
          phase: 'done',
          findings: incoming.findings,
          unavailablePackages: incoming.unavailablePackages,
          capability: incoming.capability,
        });
        return;
      }

      if (incoming.status === 'smart-cleanup-metadata-error') {
        if (incoming.requestId !== activeSmartCleanupRequestIdRef.current) return;
        setSmartCleanupMetadata({
          phase: 'error',
          findings: [],
          unavailablePackages: [],
          capability: {
            executionSupported: false,
            reason: 'Smart Cleanup could not verify whether this project supports automated removal.',
          },
          message: incoming.error.message,
        });
        if (incoming.error.code === 'STALE_SOURCE') {
          dispatchSmartCleanup({ type: 'source-stale', message: incoming.error.message });
        }
        return;
      }

      if (incoming.status === 'smart-cleanup-duplicates-analyzing') {
        if (incoming.requestId !== activeSmartCleanupRequestIdRef.current) return;
        setSmartCleanupDuplicates((previous) => ({ ...previous, phase: 'analyzing' }));
        return;
      }

      if (incoming.status === 'smart-cleanup-duplicates-result') {
        if (incoming.requestId !== activeSmartCleanupRequestIdRef.current) return;
        setSmartCleanupDuplicates({
          phase: 'done',
          assessments: incoming.assessments,
          action: incoming.action ?? null,
          ...(incoming.unavailableReason === undefined ? {} : { unavailableReason: incoming.unavailableReason }),
        });
        return;
      }

      if (incoming.status === 'smart-cleanup-duplicates-error') {
        if (incoming.requestId !== activeSmartCleanupRequestIdRef.current) return;
        smartCleanupReviewCacheRef.current = null;
        setSmartCleanupDuplicates({
          phase: 'error',
          assessments: [],
          action: null,
          message: incoming.error.message,
        });
        if (incoming.error.code === 'STALE_SOURCE') {
          dispatchSmartCleanup({ type: 'source-stale', message: incoming.error.message });
        }
        return;
      }

      if (incoming.status === 'removal-impact-analyzing') {
        const active = activeRemovalImpactRequestRef.current;
        if (
          active !== null &&
          active.requestId === incoming.requestId &&
          active.packages.length === incoming.packages.length &&
          active.packages.every((name, index) => name === incoming.packages[index])
        ) {
          setRemovalImpact({
            phase: 'analyzing',
            requestId: incoming.requestId,
            packages: incoming.packages,
            scanned: incoming.scanned,
            total: incoming.total,
          });
        }
        return;
      }

      if (incoming.status === 'removal-impact-result') {
        const active = activeRemovalImpactRequestRef.current;
        if (
          active !== null &&
          active.requestId === incoming.requestId &&
          active.packages.length === incoming.packages.length &&
          active.packages.every((name, index) => name === incoming.packages[index])
        ) {
          setRemovalImpact({
            phase: 'done',
            requestId: incoming.requestId,
            packages: incoming.packages,
            assessments: new Map(
              incoming.assessments.map((entry) => [entry.packageName, { assessment: entry.assessment, usageId: entry.usageId }])
            ),
            generatedAt: incoming.generatedAt,
          });
        }
        return;
      }

      if (incoming.status === 'removal-impact-error') {
        const active = activeRemovalImpactRequestRef.current;
        if (
          active !== null &&
          active.requestId === incoming.requestId &&
          active.packages.length === incoming.packages.length &&
          active.packages.every((name, index) => name === incoming.packages[index])
        ) {
          setPendingManageRemoval(null);
          setRemovalImpact({
            phase: 'error',
            requestId: incoming.requestId,
            packages: incoming.packages,
            message: incoming.error.message,
          });
          if (incoming.error.code === 'STALE_SOURCE') {
            smartCleanupReviewCacheRef.current = null;
            dispatchSmartCleanup({ type: 'source-stale', message: incoming.error.message });
          }
          if (smartCleanupOpenRef.current) {
            if (incoming.error.code !== 'STALE_SOURCE') {
              dispatchSmartCleanup({
                type: 'analysis-failed',
                requestId: `smart-cleanup-${smartCleanupRequestIdRef.current}`,
                message: incoming.error.message,
              });
            }
          }
        }
        return;
      }

      // Any other message is a dashboard snapshot, not necessarily a change
      // to the review the user is reading. Background enrichment must not
      // discard its results, target choice, or request correlation.
      const reviewEffect = upgradeReviewDashboardEffect(activeUpgradeRef.current, dashboardDataRef.current, incoming);
      let nextMessage = incoming;
      if ('data' in incoming) {
        dashboardDataRef.current = incoming.data;
        dashboardSnapshotStatusRef.current = incoming.status;
        const cachedReview = smartCleanupReviewCacheRef.current;
        if (
          cachedReview !== null &&
          (
            cachedReview.projectKey !== smartCleanupProjectKey(incoming.data) ||
            cachedReview.dashboardGeneratedAt !== incoming.data.generatedAt
          )
        ) {
          smartCleanupReviewCacheRef.current = null;
        }
        if (
          smartCleanupOpenRef.current &&
          activeSmartCleanupRequestIdRef.current !== null &&
          smartCleanupExecutionRef.current === null
        ) {
          dispatchSmartCleanup({
            type: 'source-stale',
            message: 'The project dependency snapshot changed. Analyze Smart Cleanup again before removing anything.',
          });
        }
      }
      const pendingUpgradeResult = upgradeResultRef.current;
      if (pendingUpgradeResult !== null && 'data' in incoming) {
        const enrichment = upgradeEnrichmentRef.current;
        if (completedDashboardSnapshotAbandonsUpgradeEnrichment(enrichment, incoming.status)) {
          // A full authoritative reload completed after the targeted refresh
          // had already failed/cancelled/been superseded. Abandon the old
          // targeted result instead of calling it successful; this snapshot
          // now owns the UI and its own availability flags remain honest.
          upgradeResultRef.current = null;
          setUpgradeResult(null);
          upgradeEnrichmentRef.current = null;
          setUpgradeEnrichment(null);
          pendingEnrichmentDashboardMessageRef.current = null;
        } else if (shouldQuarantineUpgradeDerivedData(enrichment)) {
          // Keep every derived-data snapshot quarantined until the exact
          // targeted lifecycle reports success. The original message is
          // retained privately so that correlated success can publish it;
          // unrelated dashboard traffic can neither end refreshing nor make
          // its registry/security values appear current in the meantime.
          pendingEnrichmentDashboardMessageRef.current = incoming;
          nextMessage = {
            status: 'stale',
            data: applyUpgradeResultLocalFacts(incoming.data, pendingUpgradeResult),
          };
        } else if (incoming.status === 'stale') {
          // A later structural/manual revalidation supersedes the retained
          // completion card. Time-only refreshes do not emit stale, so the
          // result survives its own enrichment replacement.
          upgradeResultRef.current = null;
          setUpgradeResult(null);
          upgradeEnrichmentRef.current = null;
          setUpgradeEnrichment(null);
          pendingEnrichmentDashboardMessageRef.current = null;
        }
      }
      if (reviewEffect === 'reset') {
        activeUpgradeRef.current = null;
        activeRequestIdRef.current = null;
        analysisIdRef.current = null;
        setActiveUpgrade(null);
        setActiveTarget(null);
        setActiveUpgradeChanges([]);
        setAnalysis(null);
        setAnalyzingPhase(null);
        setAnalysisSections(WAITING_UPGRADE_ANALYSIS_SECTIONS);
        setHardStaleAnalysisId(null);
        setConfirmBusy(false);
        setUpgradeError(null);
        setUpgradeOrigin(null);
        activeTargetRequestIdRef.current = null;
        setUpgradeTargetState({ phase: 'idle' });
        setSelectedManageTarget(null);
      } else if (reviewEffect === 'mark-stale') {
        // Keep the evidence readable; a fresh ready snapshot must not clear
        // this warning or re-authorize a host-revoked analysis.
        setHardStaleAnalysisId(analysisIdRef.current);
      }
      activeRemoveRef.current = null;
      setActiveRemove(null);
      setActiveRemoveChanges([]);
      setRemoveMatchTags(new Map());
      setRemoveAnalysis(null);
      setRemoveBusy(false);
      setRemoveError(null);
      if (!(removeOriginRef.current === 'smart-cleanup' && smartCleanupExecutionRef.current !== null)) {
        removeOriginRef.current = null;
        setRemoveOrigin(null);
      }
      // A post-remediation dependency refresh is expected while the task is
      // applying or immediately after it reaches a verified/restored result.
      // Preserve those host-issued transaction states so the modal does not
      // flash back to "Check transitive fixes" before the user can read the
      // outcome. Read-only plans and old errors are intentionally discarded.
      setRemediationByPackage((previous) => new Map(
        [...previous.entries()].filter(([, state]) => state.phase === 'applying' || state.phase === 'result')
      ));
      setRemediationError(null);
      setBulkActionsOpen(false);
      // `manageRow`/`manageTab` deliberately survive this reset: this branch
      // also fires for `status: 'stale'`, which announces structural/manual
      // revalidation and the explicit post-mutation derived-data refresh.
      // Cache-age-only timer refreshes deliberately stay `ready`. Closing
      // the Manage dependency modal or
      // snapping it back to Overview on every one of those would fight the
      // user out of a tab they're actively reading. The modal already
      // self-heals if its row genuinely disappears from the new data — see
      // the `row === undefined` check around ManageDependencyModal below.
      // Usage-analysis results and unused findings are relative to the rows
      // a scan just replaced — never carried forward as if they still
      // describe the current dependency set. `cleanupState` itself is left
      // alone: a running "Analyze cleanup" scan is independent host-side
      // work this message doesn't affect.
      if (pendingUpgradeResult === null) setUsageByPackage(new Map());
      setCleanupFindings([]);
      setCleanupError(null);
      cleanupShouldSelectFilter.current = false;
      activeRemovalImpactRequestRef.current = null;
      setRemovalImpact({ phase: 'idle' });
      setPendingManageRemoval(null);
      setCleanupState((previous) => previous.phase === 'analyzing' ? previous : { phase: 'idle' });
      setScanProgress(undefined);
      if (
        initialRenderStartedAt.current === null &&
        'data' in incoming &&
        document.body.dataset['performanceDebug'] === 'true'
      ) {
        initialRenderStartedAt.current = performance.now();
      }
      setMessage(nextMessage);
    };

    // Listen before announcing readiness, so the host's reply cannot be missed.
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  useEffect(() => {
    if (
      initialRenderMeasured.current ||
      initialRenderStartedAt.current === null ||
      message === undefined ||
      !('data' in message)
    ) {
      return;
    }
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const durationMs = performance.now() - (initialRenderStartedAt.current ?? performance.now());
        initialRenderMeasured.current = true;
        console.debug('Dependency Dashboard webview initial render', {
          operation: 'webview initial render',
          durationMs,
          metadata: { rows: message.data.rows.length },
        });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== 0) cancelAnimationFrame(secondFrame);
    };
  }, [message]);

  const refresh = useCallback(() => {
    vscode.postMessage({ type: 'refresh' });
  }, []);

  const requestRetryUpgradeEnrichment = useCallback(() => {
    const current = upgradeEnrichmentRef.current;
    if (current === null || current.phase !== 'failed') return;
    const retrying = retryUpgradeEnrichment(current);
    upgradeEnrichmentRef.current = retrying;
    setUpgradeEnrichment(retrying);
    pendingEnrichmentDashboardMessageRef.current = null;
    const result = upgradeResultRef.current;
    if (result !== null) {
      const refreshingResult = { ...result, refreshingDerivedData: true };
      upgradeResultRef.current = refreshingResult;
      setUpgradeResult(refreshingResult);
    }
    vscode.postMessage({ type: 'retry-upgrade-enrichment', refreshId: current.refreshId });
  }, []);

  const changeProject = useCallback(() => {
    vscode.postMessage({ type: 'change-project' });
  }, []);

  // Always the Manage dependency workspace's Upgrade review tab now — the
  // row's own former per-row Upgrade button is gone (see PackageTable.tsx),
  // and this never runs as part of a bulk request (see requestBulkUpgrade
  // below for that path). Reviewed inline in Manage rather than opening a
  // second dialog — see the ManageDependencyModal render block's own doc.
  const requestUpgrade = useCallback((packageName: string, target: string) => {
    // The host keeps an accepted analysis locked until confirm/cancel. Never
    // replace the analysis id this client is tracking with a duplicate request
    // that the host will reject as UPGRADE_IN_PROGRESS.
    if (!upgradeAnalysisRequestIsAllowed(activeUpgradeRef.current)) return;
    const requestId = String(++nextRequestIdRef.current);
    activeUpgradeRef.current = packageName;
    upgradeResultRef.current = null;
    setUpgradeResult(null);
    upgradeEnrichmentRef.current = null;
    setUpgradeEnrichment(null);
    pendingEnrichmentDashboardMessageRef.current = null;
    activeRequestIdRef.current = requestId;
    setActiveUpgrade(packageName);
    setActiveTarget(target);
    setActiveUpgradeChanges([{ packageName, currentVersion: '', targetVersion: target, major: false }]);
    setAnalysis(null);
    setAnalyzingPhase(null);
    setAnalysisSections(WAITING_UPGRADE_ANALYSIS_SECTIONS);
    setHardStaleAnalysisId(null);
    setConfirmBusy(false);
    setUpgradeError(null);
    setUpgradeOrigin('manage-dependency');
    vscode.postMessage({ type: 'upgrade', package: packageName, target, requestId });
  }, []);

  const requestBulkUpgrade = useCallback((changes: readonly BulkUpgradeCandidate[]) => {
    const first = changes[0];
    if (first === undefined) return;
    const requestId = String(++nextRequestIdRef.current);
    activeUpgradeRef.current = first.packageName;
    upgradeResultRef.current = null;
    setUpgradeResult(null);
    upgradeEnrichmentRef.current = null;
    setUpgradeEnrichment(null);
    pendingEnrichmentDashboardMessageRef.current = null;
    activeRequestIdRef.current = requestId;
    setActiveUpgrade(first.packageName);
    setActiveTarget(first.targetVersion);
    setActiveUpgradeChanges(changes);
    setAnalysis(null);
    setAnalyzingPhase(null);
    setAnalysisSections(WAITING_UPGRADE_ANALYSIS_SECTIONS);
    setHardStaleAnalysisId(null);
    setConfirmBusy(false);
    setUpgradeOrigin('dashboard');
    vscode.postMessage({
      type: 'bulk-upgrade',
      changes: changes.map((change) => ({ package: change.packageName, target: change.targetVersion })),
      requestId,
    });
  }, []);

  const requestConfirmUpgrade = useCallback(() => {
    if (analysis === null) return;
    setConfirmBusy(true);
    vscode.postMessage({ type: 'confirm-upgrade', analysisId: analysis.analysisId });
  }, [analysis]);

  const requestUseSmartPlan = useCallback(() => {
    if (analysis === null) return;
    setConfirmBusy(true);
    vscode.postMessage({ type: 'use-smart-plan', analysisId: analysis.analysisId });
  }, [analysis]);

  // Closes the modal immediately, client-side, rather than waiting on a host
  // round trip — cancelling mutates nothing, so there's nothing to wait for.
  // Still tells the host either way: a real analysisId releases its lock
  // right away; `null` (still loading, no id issued yet) marks the in-flight
  // analyze request so the host drops its own result instead of storing it —
  // see webviewProtocol.ts's own doc on cancel-upgrade's nullable id.
  const requestCancelUpgrade = useCallback(() => {
    vscode.postMessage({ type: 'cancel-upgrade', analysisId: analysis?.analysisId ?? null });
    setActiveUpgrade(null);
    activeUpgradeRef.current = null;
    activeRequestIdRef.current = null;
    setActiveTarget(null);
    setActiveUpgradeChanges([]);
    setAnalysis(null);
    setAnalyzingPhase(null);
    setAnalysisSections(WAITING_UPGRADE_ANALYSIS_SECTIONS);
    setHardStaleAnalysisId(null);
    setConfirmBusy(false);
    setUpgradeOrigin(null);
  }, [analysis]);

  // Structural staleness's own Refresh action — not a new mechanism, just
  // this same Cancel followed immediately by a fresh Analyze. Safe because
  // `handleCancelUpgrade` is fully synchronous host-side (see
  // upgradeAssistantCoordinator.ts), so the panel-wide lock is guaranteed
  // free before the `upgrade` message right behind it is processed.
  const requestRefreshUpgradeAnalysis = useCallback(
    (packageName: string, target: string) => {
      requestCancelUpgrade();
      requestUpgrade(packageName, target);
    },
    [requestCancelUpgrade, requestUpgrade]
  );

  const changeManageUpgradeTarget = useCallback(
    (packageName: string, target: string) => {
      if (
        targetChangeInvalidatesManageAnalysis(
          packageName,
          selectedManageTarget,
          target,
          activeUpgrade,
          upgradeOrigin
        )
      ) {
        // Cancelling clears the active request id before the new target is
        // selected, so late partials/final results for target A cannot fill
        // target B's review. Analysis remains explicit: selection alone never
        // starts another request and never executes an upgrade.
        requestCancelUpgrade();
      }
      setUpgradeError(null);
      setSelectedManageTarget(target);
    },
    [activeUpgrade, requestCancelUpgrade, selectedManageTarget, upgradeOrigin]
  );

  const requestConfigureVerification = useCallback(() => {
    vscode.postMessage({ type: 'configure-verification' });
  }, []);

  const requestBulkRemove = useCallback(
    (
      packageNames: readonly string[],
      matchTags: ReadonlyMap<string, readonly string[]>,
      origin: 'dashboard' | 'manage-dependency' | 'smart-cleanup' = 'dashboard'
    ) => {
      const first = packageNames[0];
      if (first === undefined) return;
      activeRemoveRef.current = first;
      setActiveRemove(first);
      setActiveRemoveChanges(packageNames);
      setRemoveMatchTags(matchTags);
      setRemoveAnalysis(null);
      setRemoveBusy(false);
      setRemoveError(null);
      setRemoveOrigin(origin);
      removeOriginRef.current = origin;
      vscode.postMessage({ type: 'bulk-remove', changes: packageNames.map((name) => ({ package: name })) });
    },
    []
  );

  const requestConfirmRemove = useCallback(() => {
    if (removeAnalysis === null) return;
    setRemoveBusy(true);
    vscode.postMessage({ type: 'confirm-remove', analysisId: removeAnalysis.analysisId });
  }, [removeAnalysis]);

  // Same immediate-client-side-close discipline as requestCancelUpgrade.
  // When this review was opened from Manage (removeOrigin ===
  // 'manage-dependency'), `manageRow` was never cleared, so this only ever
  // abandons the embedded review itself — closeManage (below) is the one
  // place that also releases `manageRow`, for the X/Escape/Close "close the
  // entire workspace" path.
  const requestCancelRemove = useCallback(() => {
    vscode.postMessage({ type: 'cancel-remove', analysisId: removeAnalysis?.analysisId ?? null });
    setPendingManageRemoval(null);
    setActiveRemove(null);
    activeRemoveRef.current = null;
    setActiveRemoveChanges([]);
    setRemoveMatchTags(new Map());
    setRemoveAnalysis(null);
    setRemoveBusy(false);
    setRemoveOrigin(null);
  }, [removeAnalysis]);

  // Upgrade and removal previews share one host-owned project lock. A
  // completed embedded removal review is a decision screen, not ongoing
  // work, so starting Upgrade review deliberately closes it first. Keep an
  // in-progress removal analysis or file mutation protected from takeover.
  const requestUpgradeFromManage = useCallback(
    (packageName: string, target: string) => {
      if (manageUpgradeReplacesRemovalReview(
        packageName,
        activeRemove,
        removeOrigin === 'smart-cleanup' ? null : removeOrigin
      )) {
        if (removeAnalysis === null || removeBusy) return;
        requestCancelRemove();
      }
      requestUpgrade(packageName, target);
    },
    [activeRemove, removeAnalysis, removeBusy, removeOrigin, requestCancelRemove, requestUpgrade]
  );

  // Selecting a card re-asserts that card's own intelligent default sort
  // (see cardDefaultComparator) over any manual header sort — a fresh
  // filtering context starts from a fresh, useful order rather than
  // whatever column the user happened to have clicked on the last filter's
  // table. Every one of these also starts back at page 1: continuing to
  // show "page 3" of a completely different row set is never useful.
  const handleSelectFilter = useCallback((filter: SummaryFilterId) => {
    setSelectedFilter(filter);
    setSortState(null);
    setPage(1);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const handleDependencyTypeChange = useCallback((value: DependencyTypeFilterValue) => {
    setDependencyType(value);
    setPage(1);
  }, []);

  const handleHygieneFilterChange = useCallback((value: HygieneFilterId) => {
    setHygieneFilter(value);
    setPage(1);
  }, []);

  const handleSort = useCallback((column: SortColumn) => {
    setSortState((previous) => nextColumnSortState(previous, column));
    setPage(1);
  }, []);

  const handlePageSizeChange = useCallback((size: PageSize) => {
    setPageSize(size);
    setPage(1);
  }, []);

  // Never carries a URL — see webviewProtocol.ts's own doc on 'open-advisory'
  // and src/core/advisories/resolve.ts for the actual trust boundary.
  const requestOpenAdvisory = useCallback((packageName: string, advisoryId: string | number, path: string[], reference?: string) => {
    vscode.postMessage(advisoryNavigationRequest(packageName, advisoryId, path, reference));
  }, []);

  // Only ever a package name — see analyze-remediation's own doc in
  // webviewProtocol.ts. The host re-derives everything else from its own
  // last-trusted scan.
  const requestAnalyzeRemediation = useCallback((packageName: string) => {
    setRemediationError(null);
    setRemediationByPackage((previous) => {
      const next = new Map(previous);
      next.set(packageName, { phase: 'analyzing' });
      return next;
    });
    vscode.postMessage({ type: 'analyze-remediation', package: packageName });
  }, []);

  const reviewRemediation = useCallback((packageName: string, analysisId: string) => {
    setRemediationByPackage((previous) => {
      const current = previous.get(packageName);
      if (current?.phase !== 'plan' || current.plan.analysisId !== analysisId || current.reviewed) return previous;
      const next = new Map(previous);
      next.set(packageName, { ...current, reviewed: true });
      return next;
    });
  }, []);

  const requestApplyRemediation = useCallback((analysisId: string) => {
    setRemediationByPackage((previous) => {
      const entry = [...previous.entries()].find(([, state]) => remediationPlanFromState(state)?.analysisId === analysisId);
      if (entry === undefined) return previous;
      const [packageName, state] = entry;
      const plan = remediationPlanFromState(state);
      if (plan === null || state.phase !== 'plan' || !state.reviewed) return previous;
      const next = new Map(previous);
      next.set(packageName, { phase: 'applying', plan, progress: 'preparing', cancelRequested: false });
      return next;
    });
    vscode.postMessage({ type: 'confirm-remediation', analysisId });
  }, []);

  const requestCancelRemediation = useCallback((analysisId: string) => {
    setRemediationByPackage((previous) => {
      const entry = [...previous.entries()].find(([, state]) => remediationPlanFromState(state)?.analysisId === analysisId);
      if (entry === undefined) return previous;
      const [packageName, state] = entry;
      if (state.phase !== 'applying' || state.cancelRequested) return previous;
      const next = new Map(previous);
      next.set(packageName, { ...state, cancelRequested: true });
      return next;
    });
    vscode.postMessage({ type: 'cancel-remediation', analysisId });
  }, []);

  const requestRetryRemediation = useCallback((analysisId: string) => {
    setRemediationByPackage((previous) => {
      const entry = [...previous.entries()].find(([, state]) => remediationPlanFromState(state)?.analysisId === analysisId);
      if (entry === undefined) return previous;
      const [packageName, state] = entry;
      const plan = remediationPlanFromState(state);
      if (plan === null) return previous;
      const next = new Map(previous);
      if (state.phase === 'result' && state.result.outcome === 'unverified') {
        next.set(packageName, { phase: 'applying', plan, progress: 'verifying-security', cancelRequested: false });
      } else {
        next.set(packageName, { phase: 'analyzing' });
      }
      return next;
    });
    vscode.postMessage({ type: 'retry-remediation', analysisId });
  }, []);

  const openManage = useCallback((packageName: string) => {
    if (upgradeResultRef.current?.package !== packageName) {
      upgradeResultRef.current = null;
      setUpgradeResult(null);
      upgradeEnrichmentRef.current = null;
      setUpgradeEnrichment(null);
      pendingEnrichmentDashboardMessageRef.current = null;
    }
    setManageRow(packageName);
    setManageTab('overview');
  }, []);

  // Opening Manage dependency for a package kicks off its usage analysis
  // quietly in the background — no button press needed, and never part of
  // the main loading skeleton (see UsageReferencesPanel.tsx and Overview's
  // own "Checking usage…" glance row). Only fires when `manageRow` itself
  // changes (a new Manage session open), and skips it entirely when a
  // result is already cached for this package this session; the host's own
  // fingerprint/TTL cache (usageCoordinator.ts) is the backstop either way,
  // so a redundant request here would still resolve instantly rather than
  // rescanning.
  useEffect(() => {
    if (manageRow === null) return;
    if (usageByPackageRef.current.get(manageRow)?.phase === 'done') return;
    vscode.postMessage({ type: 'where-used', package: manageRow });
  }, [manageRow]);

  const requestReanalyzeUsage = useCallback((packageName: string) => {
    setUsageByPackage((previous) => {
      const next = new Map(previous);
      next.set(packageName, { phase: 'analyzing' });
      return next;
    });
    vscode.postMessage({ type: 'reanalyze-usage', package: packageName });
  }, []);

  const requestOpenUsageReference = useCallback((usageId: string, referenceIndex: number) => {
    vscode.postMessage({ type: 'open-usage-reference', usageId, referenceIndex });
  }, []);

  const requestBulkAnalyzeCleanup = useCallback(() => {
    if (cleanupProgressActiveRef.current) return;
    cleanupProgressActiveRef.current = true;
    cleanupShouldSelectFilter.current = true;
    setCleanupError(null);
    // Give the control immediate feedback instead of waiting for the host's
    // first progress event to make the re-check visibly busy.
    setCleanupState({ phase: 'analyzing', scanned: 0, total: 0 });
    vscode.postMessage({ type: 'analyze-cleanup' });
  }, []);

  const requestCancelCleanup = useCallback(() => {
    cleanupProgressActiveRef.current = false;
    vscode.postMessage({ type: 'cancel-usage-analysis' });
    cleanupShouldSelectFilter.current = false;
    setCleanupState({ phase: 'idle' });
  }, []);

  // Read-only removal-impact preview — shared by the bulk Review step and
  // the single-package "Analyze removal" card (see removalImpactState.ts).
  // Never gates the actual removal transaction; bulk-remove/confirm-remove
  // still re-validates everything fresh regardless of what this shows.
  const requestAnalyzeRemovalImpact = useCallback((packageNames: readonly string[]) => {
    if (packageNames.length === 0) return;
    const packages = [...new Set(packageNames)].sort((left, right) => left.localeCompare(right));
    const requestId = String(++nextRemovalImpactRequestIdRef.current);
    activeRemovalImpactRequestRef.current = { requestId, packages };
    setRemovalImpact({ phase: 'analyzing', requestId, packages, scanned: 0, total: 0 });
    vscode.postMessage({ type: 'analyze-removal-impact', requestId, packages });
  }, []);

  const requestCancelRemovalImpact = useCallback(() => {
    const active = activeRemovalImpactRequestRef.current;
    activeRemovalImpactRequestRef.current = null;
    if (active !== null) vscode.postMessage({ type: 'cancel-removal-impact', requestId: active.requestId });
    setPendingManageRemoval(null);
    setRemovalImpact({ phase: 'idle' });
  }, []);

  // Closes the whole Manage workspace — the one place that ever abandons an
  // in-flight embedded review. Internal tab navigation never calls this and
  // never cancels anything (see ManageDependencyModal.tsx's own doc):
  // switching to Overview and back preserves whatever the Upgrade/Removal
  // review tab already has. Only X/Escape/Close route here, and only a
  // merely-reviewing (not yet confirming) embedded flow is cancelled —
  // `blockClose` in the render block below refuses the close entirely while
  // a real file-mutating install/removal or the removal-impact scan is
  // actually running.
  const closeManage = useCallback(() => {
    if (removalImpact.phase === 'analyzing') requestCancelRemovalImpact();
    if (upgradeOrigin === 'manage-dependency' && activeUpgrade !== null) requestCancelUpgrade();
    if (removeOrigin === 'manage-dependency' && activeRemove !== null) requestCancelRemove();
    setManageRow(null);
    upgradeResultRef.current = null;
    setUpgradeResult(null);
    upgradeEnrichmentRef.current = null;
    setUpgradeEnrichment(null);
    pendingEnrichmentDashboardMessageRef.current = null;
    setManageTab('overview');
    activeTargetRequestIdRef.current = null;
    setUpgradeTargetState({ phase: 'idle' });
    setSelectedManageTarget(null);
    setPendingManageRemoval(null);
    if (removeOriginRef.current === 'manage-dependency') {
      removeOriginRef.current = null;
      setRemoveOrigin(null);
      setRemoveError(null);
    }
    const drilldown = smartCleanupDrilldownRef.current;
    if (drilldown !== null) {
      smartCleanupDrilldownRef.current = null;
      const currentData = dashboardDataRef.current;
      const reusable = currentData !== null &&
        drilldown.projectKey === smartCleanupProjectKey(currentData) &&
        drilldown.dashboardGeneratedAt === currentData.generatedAt &&
        smartCleanupReviewIsReusable(
        smartCleanupStateRef.current,
        smartCleanupReviewCacheRef.current,
        {
          projectKey: smartCleanupProjectKey(currentData),
          dashboardGeneratedAt: currentData.generatedAt,
        }
      );
      if (reusable) {
        const savedImpact = drilldown.removalImpact;
        const impactWasReplaced = savedImpact.phase === 'done' && (
          removalImpact.phase !== 'done' || removalImpact.requestId !== savedImpact.requestId
        );
        if (impactWasReplaced) requestAnalyzeRemovalImpact(savedImpact.packages);
        else setRemovalImpact(savedImpact);
        activeSmartCleanupRequestIdRef.current = drilldown.requestId;
      } else {
        smartCleanupReviewCacheRef.current = null;
        dispatchSmartCleanup({
          type: 'source-stale',
          message: 'The project changed while package details were open. Analyze again to refresh this cleanup review.',
        });
      }
      setSmartCleanupOpen(true);
    }
  }, [
    removalImpact,
    requestCancelRemovalImpact,
    requestAnalyzeRemovalImpact,
    upgradeOrigin,
    activeUpgrade,
    requestCancelUpgrade,
    removeOrigin,
    activeRemove,
    requestCancelRemove,
  ]);

  // Single-package removal reuses the identical bulk-remove machinery with
  // a one-element list — RemoveAnalysisBody already branches on
  // `packages.length > 1` for its own copy, and the host's
  // validateBulkRemoveRequest/executeStoredRemoval path is unchanged either
  // way. `manageRow` is left set — the Removal review tab renders this
  // inline, so there is no separate drawer to reveal Manage again from.
  const requestRemoveFromManage = useCallback(
    (packageName: string) => {
      // A completed embedded upgrade preview deliberately retains the host's
      // project lock until confirm/cancel. Replacing that decision with a
      // removal must cancel it first; postMessage ordering makes the exact-id
      // cancellation release the lock before removal-impact analysis starts.
      if (manageRemovalReplacesUpgradeReview(packageName, activeUpgrade, upgradeOrigin)) {
        // A still-running preflight has no exact analysis id to release yet.
        // Keep its UI/state intact and wait for it to finish instead of
        // immediately sending an impact request that the host must reject.
        if (analysis === null) return;
        requestCancelUpgrade();
      }
      setPendingManageRemoval(packageName);
      setRemoveError(null);
      requestAnalyzeRemovalImpact([packageName]);
    },
    [activeUpgrade, analysis, requestAnalyzeRemovalImpact, requestCancelUpgrade, upgradeOrigin]
  );

  useEffect(() => {
    const packageName = manageRemovalReadyPackage(pendingManageRemoval, removalImpact);
    if (packageName === null) return;
    setPendingManageRemoval(null);
    requestBulkRemove([packageName], new Map(), 'manage-dependency');
  }, [pendingManageRemoval, removalImpact, requestBulkRemove]);

  // No message yet is the same user-visible state as an explicit loading one.
  const loading = message === undefined || message.status === 'loading';
  const data = message !== undefined && 'data' in message ? message.data : undefined;
  const coreDataIncomplete =
    data !== undefined &&
    (data.availability.updates === 'partial' || data.availability.advisories === 'unavailable');

  // A full packument is fetched only for the dependency whose Manage
  // workspace is open. A fresh dashboard snapshot gets a fresh request id;
  // late responses from the prior snapshot/session are ignored by the
  // message handler above.
  useEffect(() => {
    if (manageRow === null) {
      activeTargetRequestIdRef.current = null;
      setUpgradeTargetState({ phase: 'idle' });
      setSelectedManageTarget(null);
      return;
    }
    const row = data?.rows.find((candidate) => candidate.name === manageRow);
    if (row === undefined || row.upgradeTo === null) {
      activeTargetRequestIdRef.current = null;
      setUpgradeTargetState({ phase: 'idle' });
      setSelectedManageTarget(null);
      return;
    }

    // Keep the existing host-owned target as a usable fallback. While a
    // stale snapshot is revalidating, show the loading state but do not ask
    // the host for choices it will correctly refuse as ineligible.
    setSelectedManageTarget(row.upgradeTo);
    setUpgradeTargetState({ phase: 'loading' });
    if (message?.status === 'stale') {
      activeTargetRequestIdRef.current = null;
      return;
    }

    const requestId = `targets-${++nextTargetRequestIdRef.current}`;
    activeTargetRequestIdRef.current = requestId;
    vscode.postMessage({ type: 'load-upgrade-targets', package: row.name, requestId });
  }, [data?.generatedAt, manageRow, message?.status]);
  const allHygieneFindings = useMemo(
    () => [...(data?.hygieneFindings ?? []), ...cleanupFindings],
    [data?.hygieneFindings, cleanupFindings]
  );

  const startSmartCleanup = useCallback(() => {
    if (data === undefined) return;
    const currentIdentity = {
      projectKey: smartCleanupProjectKey(data),
      dashboardGeneratedAt: data.generatedAt,
    };
    if (smartCleanupReviewIsReusable(smartCleanupState, smartCleanupReviewCacheRef.current, currentIdentity)) {
      activeSmartCleanupRequestIdRef.current = smartCleanupState.requestId;
      setSmartCleanupOpen(true);
      return;
    }
    smartCleanupReviewCacheRef.current = null;
    const requestId = `smart-cleanup-${++smartCleanupRequestIdRef.current}`;
    setSmartCleanupOpen(true);
    activeSmartCleanupRequestIdRef.current = requestId;
    setSmartCleanupMetadata({ phase: 'analyzing', findings: [], unavailablePackages: [], capability: null });
    setSmartCleanupDuplicates({ phase: 'analyzing', assessments: [], action: null });
    setRemovalImpact({ phase: 'idle' });
    const reusableUsage = cleanupState.phase === 'done' && Date.parse(cleanupState.cacheExpiresAt) > Date.now();
    const reusableUnusedCount = reusableUsage
      ? cleanupFindings.filter((finding) => finding.kind === 'likely-unused').length
      : 0;
    dispatchSmartCleanup({
      type: 'analysis-started',
      projectName: data.project.label,
      requestId,
      steps: [
        { id: 'usage', label: 'Checking project usage', status: reusableUsage ? 'complete' : 'running' },
        {
          id: 'removal-safety',
          label: 'Checking removal safety',
          status: reusableUsage ? (reusableUnusedCount === 0 ? 'complete' : 'running') : 'waiting',
        },
        { id: 'duplicates', label: 'Simulating safe duplicate consolidation', status: 'running' },
        { id: 'deprecation', label: 'Checking installed-version deprecations', status: 'running' },
      ],
    });
    cleanupShouldSelectFilter.current = false;
    setCleanupError(null);
    if (!reusableUsage) {
      cleanupProgressActiveRef.current = true;
      vscode.postMessage({ type: 'analyze-cleanup' });
    }
    vscode.postMessage({ type: 'analyze-smart-cleanup-metadata', requestId });
    vscode.postMessage({ type: 'analyze-smart-cleanup-duplicates', requestId });
  }, [cleanupFindings, cleanupState, data, smartCleanupState]);

  const closeSmartCleanup = useCallback(() => {
    if (smartCleanupState.phase === 'analyzing') {
      smartCleanupReviewCacheRef.current = null;
      cleanupProgressActiveRef.current = false;
      vscode.postMessage({ type: 'cancel-usage-analysis' });
      const requestId = activeSmartCleanupRequestIdRef.current;
      if (requestId !== null) vscode.postMessage({ type: 'cancel-smart-cleanup-metadata', requestId });
      if (requestId !== null) vscode.postMessage({ type: 'cancel-smart-cleanup-duplicates', requestId });
      requestCancelRemovalImpact();
    }
    const execution = smartCleanupExecutionRef.current;
    if (smartCleanupState.phase === 'confirming' && execution !== null) {
      vscode.postMessage({ type: 'cancel-remove', analysisId: execution.analysisId, requestId: execution.requestId });
      smartCleanupExecutionRef.current = null;
      activeRemoveRef.current = null;
      removeOriginRef.current = null;
      setActiveRemove(null);
      setActiveRemoveChanges([]);
      setRemoveAnalysis(null);
      setRemoveBusy(false);
      setRemoveOrigin(null);
      dispatchSmartCleanup({ type: 'back-to-review' });
    }
    activeSmartCleanupRequestIdRef.current = null;
    setSmartCleanupOpen(false);
  }, [requestCancelRemovalImpact, smartCleanupState.phase]);

  const openDependencyReviewFromSmartCleanup = useCallback((packageName: string, tab: ManageTabId) => {
    const currentData = dashboardDataRef.current;
    const requestId = smartCleanupState.requestId;
    if (currentData === null || requestId === null) return;
    smartCleanupDrilldownRef.current = {
      projectKey: smartCleanupProjectKey(currentData),
      dashboardGeneratedAt: currentData.generatedAt,
      requestId,
      removalImpact,
    };
    setSmartCleanupOpen(false);
    openManage(packageName);
    setManageTab(tab);
  }, [openManage, removalImpact, smartCleanupState.requestId]);

  useEffect(() => {
    if (!smartCleanupOpen || smartCleanupState.phase !== 'analyzing' || cleanupState.phase !== 'done') return;
    const unusedPackages = cleanupFindings
      .filter((finding) => finding.kind === 'likely-unused')
      .map((finding) => finding.packageName)
      .sort((left, right) => left.localeCompare(right));
    if (unusedPackages.length === 0 || removalImpact.phase !== 'idle') return;
    requestAnalyzeRemovalImpact(unusedPackages);
  }, [
    cleanupFindings,
    cleanupState.phase,
    removalImpact.phase,
    requestAnalyzeRemovalImpact,
    smartCleanupOpen,
    smartCleanupState.phase,
  ]);

  useEffect(() => {
    if (!smartCleanupOpen || smartCleanupState.phase !== 'analyzing' || data === undefined) return;
    const unusedPackages = cleanupFindings
      .filter((finding) => finding.kind === 'likely-unused')
      .map((finding) => finding.packageName);
    const usageReady = cleanupState.phase === 'done';
    const impactReady = unusedPackages.length === 0 || removalImpact.phase === 'done';
    const metadataReady = smartCleanupMetadata.phase === 'done' || smartCleanupMetadata.phase === 'error';
    const duplicatesReady = smartCleanupDuplicates.phase === 'done' || smartCleanupDuplicates.phase === 'error';
    if (!usageReady || !impactReady || !metadataReady || !duplicatesReady) return;

    const requestId = smartCleanupState.requestId;
    if (requestId === null) return;
    const usageCacheExpiry = cleanupState.phase === 'done' ? Date.parse(cleanupState.cacheExpiresAt) : Number.NaN;
    const reviewExpiresAt = Math.min(
      Date.now() + SMART_CLEANUP_REVIEW_CACHE_MS,
      Number.isFinite(usageCacheExpiry) && usageCacheExpiry > Date.now()
        ? usageCacheExpiry
        : Date.now() + SMART_CLEANUP_REVIEW_CACHE_MS
    );
    const rememberReview = (): void => {
      smartCleanupReviewCacheRef.current = {
        projectKey: smartCleanupProjectKey(data),
        dashboardGeneratedAt: data.generatedAt,
        expiresAt: reviewExpiresAt,
      };
    };
    const plan = buildSmartCleanupPlan({
      projectName: data.project.label,
      requestId,
      rows: data.rows,
      hygieneFindings: allHygieneFindings,
      exactDeprecatedFindings: smartCleanupMetadata.findings,
      removalImpact,
      capability: smartCleanupMetadata.capability ?? {
        executionSupported: false,
        reason: 'Smart Cleanup could not verify whether this project supports automated removal.',
      },
      duplicateAssessments: smartCleanupDuplicates.assessments,
      dedupeAction: smartCleanupDuplicates.action,
    });
    const findings = plan.recommendations.length + plan.deprecated.length + plan.duplicates.length + plan.security.length;
    if (findings === 0) {
      rememberReview();
      dispatchSmartCleanup({
        type: 'analysis-empty',
        requestId,
        message: 'No unused, deprecated, duplicate-version, or security cleanup findings were detected.',
      });
      return;
    }
    const partialReasons: string[] = [];
    if (smartCleanupMetadata.phase === 'error') partialReasons.push('exact deprecation metadata was unavailable');
    if (smartCleanupMetadata.unavailablePackages.length > 0) {
      partialReasons.push(`exact metadata was unavailable for ${smartCleanupMetadata.unavailablePackages.length} packages`);
    }
    if (smartCleanupDuplicates.phase === 'error') partialReasons.push('duplicate consolidation analysis was unavailable');
    else if (smartCleanupDuplicates.unavailableReason !== undefined) {
      partialReasons.push(smartCleanupDuplicates.unavailableReason);
    }
    if (data.availability.advisories !== 'complete') partialReasons.push('security data was unavailable');
    if (partialReasons.length > 0) {
      rememberReview();
      dispatchSmartCleanup({
        type: 'analysis-partial',
        requestId,
        plan,
        message: `Some checks are partial: ${partialReasons.join('; ')}.`,
      });
    } else {
      rememberReview();
      dispatchSmartCleanup({ type: 'analysis-ready', requestId, plan });
    }
  }, [
    allHygieneFindings,
    cleanupFindings,
    cleanupState.phase,
    data,
    removalImpact,
    smartCleanupMetadata,
    smartCleanupDuplicates,
    smartCleanupOpen,
    smartCleanupState.phase,
    smartCleanupState.requestId,
  ]);

  useEffect(() => {
    if (!smartCleanupOpen || smartCleanupState.phase !== 'analyzing') return;
    const usageDone = cleanupState.phase === 'done';
    const removalDone = removalImpact.phase === 'done' || (
      usageDone && cleanupFindings.every((finding) => finding.kind !== 'likely-unused')
    );
    dispatchSmartCleanup({
      type: 'analysis-progress',
      requestId: smartCleanupState.requestId ?? '',
      steps: [
        { id: 'usage', label: 'Checking project usage', status: usageDone ? 'complete' : 'running' },
        {
          id: 'removal-safety',
          label: 'Checking removal safety',
          status: removalDone ? 'complete' : usageDone ? 'running' : 'waiting',
        },
        {
          id: 'duplicates',
          label: 'Simulating safe duplicate consolidation',
          status: smartCleanupDuplicates.phase === 'done'
            ? 'complete'
            : smartCleanupDuplicates.phase === 'error'
              ? 'unavailable'
              : 'running',
        },
        {
          id: 'deprecation',
          label: 'Checking installed-version deprecations',
          status: smartCleanupMetadata.phase === 'done'
            ? 'complete'
            : smartCleanupMetadata.phase === 'error'
              ? 'unavailable'
              : 'running',
        },
      ],
    });
  }, [
    cleanupFindings,
    cleanupState.phase,
    removalImpact.phase,
    smartCleanupMetadata.phase,
    smartCleanupDuplicates.phase,
    smartCleanupOpen,
    smartCleanupState.phase,
    smartCleanupState.requestId,
  ]);

  const prepareSmartCleanup = useCallback((actionIds: readonly string[]) => {
    if (
      smartCleanupExecutionRef.current !== null ||
      data === undefined ||
      smartCleanupState.plan === null ||
      smartCleanupState.requestId === null ||
      actionIds.length === 0
    ) return;
    const byId = new Map(smartCleanupState.plan.recommendations.map((item) => [item.id, item]));
    const selectedDedupe = selectedSmartCleanupDedupeAction(smartCleanupState);
    const recommendations = actionIds.flatMap((id) => {
      const recommendation = byId.get(id);
      return recommendation === undefined ? [] : [recommendation];
    });
    const dedupeActionId = selectedDedupe?.id;
    const recognizedCount = recommendations.length + (dedupeActionId !== undefined && actionIds.includes(dedupeActionId) ? 1 : 0);
    if (recognizedCount !== actionIds.length) {
      dispatchSmartCleanup({ type: 'source-stale', message: 'The cleanup selection is no longer current. Analyze again.' });
      return;
    }
    const packages = recommendations.map((item) => item.packageName).sort((left, right) => left.localeCompare(right));
    const analyzed = removalImpact.phase === 'done' ? new Set(removalImpact.packages) : new Set<string>();
    if (packages.length > 0 && (removalImpact.phase !== 'done' || !packages.every((name) => analyzed.has(name)))) {
      dispatchSmartCleanup({ type: 'source-stale', message: 'The cleanup selection is no longer covered by current removal evidence. Analyze again.' });
      return;
    }
    const removalRequestId = packages.length > 0 && removalImpact.phase === 'done'
      ? removalImpact.requestId
      : undefined;
    smartCleanupExecutionRef.current = {
      before: data,
      actionIds: [...actionIds],
      packages,
      analysisId: null,
      requestId: smartCleanupState.requestId,
      ...(removalRequestId === undefined ? {} : { removalRequestId }),
      ...(dedupeActionId === undefined ? {} : { dedupeActionId }),
    };
    const first = packages[0] ?? 'Smart Cleanup';
    activeRemoveRef.current = first;
    removeOriginRef.current = 'smart-cleanup';
    setActiveRemove(first);
    setActiveRemoveChanges(packages);
    setRemoveMatchTags(new Map());
    setRemoveAnalysis(null);
    setRemoveBusy(true);
    setRemoveOrigin('smart-cleanup');
    vscode.postMessage({
      type: 'smart-cleanup-remove',
      requestId: smartCleanupState.requestId,
      packages,
      ...(removalRequestId === undefined ? {} : { removalRequestId }),
      ...(dedupeActionId === undefined ? {} : { dedupeActionId }),
    });
  }, [data, removalImpact, smartCleanupState]);

  const confirmSmartCleanup = useCallback((analysisId: string) => {
    const snapshot = smartCleanupExecutionRef.current;
    if (snapshot === null || snapshot.analysisId !== analysisId || removeAnalysis?.analysisId !== analysisId) return;
    setRemoveBusy(true);
    dispatchSmartCleanup({
      type: 'execution-started',
      total: snapshot.actionIds.length,
      currentLabel: 'Applying the reviewed cleanup actions…',
    });
    vscode.postMessage({ type: 'confirm-remove', analysisId });
  }, [removeAnalysis]);

  const keepDependencyFromSmartCleanupConfirmation = useCallback((actionId: string) => {
    const snapshot = smartCleanupExecutionRef.current;
    if (snapshot !== null) {
      vscode.postMessage({ type: 'cancel-remove', analysisId: snapshot.analysisId, requestId: snapshot.requestId });
    }
    smartCleanupExecutionRef.current = null;
    activeRemoveRef.current = null;
    removeOriginRef.current = null;
    setActiveRemove(null);
    setActiveRemoveChanges([]);
    setRemoveMatchTags(new Map());
    setRemoveAnalysis(null);
    setRemoveBusy(false);
    setRemoveError(null);
    setRemoveOrigin(null);
    dispatchSmartCleanup({ type: 'keep-dependency', actionId });
  }, []);

  const backFromSmartCleanupConfirmation = useCallback(() => {
    const snapshot = smartCleanupExecutionRef.current;
    if (snapshot !== null) {
      vscode.postMessage({ type: 'cancel-remove', analysisId: snapshot.analysisId, requestId: snapshot.requestId });
    }
    smartCleanupExecutionRef.current = null;
    activeRemoveRef.current = null;
    removeOriginRef.current = null;
    setActiveRemove(null);
    setActiveRemoveChanges([]);
    setRemoveAnalysis(null);
    setRemoveBusy(false);
    setRemoveOrigin(null);
    dispatchSmartCleanup({ type: 'back-to-review' });
  }, []);
  // Disabled while an upgrade or removal is active — a manual refresh or
  // project switch mid-operation would race the scan (and, for a project
  // switch, a controller replacement) against a package.json/lockfile the
  // task is still writing to; the host rejects both too (see
  // DashboardPanel.handle), this just keeps the buttons from inviting a
  // click that can't do anything anyway.
  const remediationBusy = [...remediationByPackage.values()].some(
    (state) => state.phase === 'analyzing' || state.phase === 'applying'
  );
  const actionsDisabled =
    loading ||
    activeUpgrade !== null ||
    activeRemove !== null ||
    remediationBusy ||
    cleanupState.phase === 'analyzing';

  return (
    <main className="dashboard">
      <header className="dashboard__header">
        <div className="dashboard__header-titles">
          <h1 className="dashboard__title">Dependency Dashboard</h1>
          {data !== undefined ? <p className="dashboard__project">{data.project.label}</p> : null}
        </div>
        {data !== undefined ? <DependencySearch value={search} onChange={handleSearchChange} /> : null}
      </header>

      {loading ? (
        <DependencyLoadingState
          stage={scanProgress?.stage}
          progress={
            scanProgress?.completed === undefined || scanProgress.total === undefined
              ? undefined
              : { completed: scanProgress.completed, total: scanProgress.total }
          }
        />
      ) : null}

      {message !== undefined && message.status === 'fatal-error' ? (
        <StatusBanner tone="error" action={{ label: 'Retry', onClick: refresh, icon: <IconRefresh /> }}>
          {message.error.message}
        </StatusBanner>
      ) : null}

      {/* upgradeError is only ever set for a user-visible code (see
          upgradeErrorIsUserVisible) — CANCELLED and UPGRADE_IN_PROGRESS never
          reach this state at all, so there is nothing to filter here. */}
      {upgradeError !== null ? (
        <StatusBanner
          tone="error"
          action={{ label: 'Refresh', onClick: refresh, disabled: actionsDisabled, icon: <IconRefresh /> }}
        >
          Couldn't upgrade {upgradeError.package}: {upgradeError.message}
        </StatusBanner>
      ) : null}

      {removeError !== null && removeOrigin !== 'manage-dependency' ? (
        <StatusBanner
          tone="error"
          action={{ label: 'Refresh', onClick: refresh, disabled: actionsDisabled, icon: <IconRefresh /> }}
        >
          Couldn't remove {removeError.package}: {removeError.message}
        </StatusBanner>
      ) : null}

      {remediationError !== null ? (
        <StatusBanner
          tone="error"
          action={{ label: 'Refresh', onClick: refresh, disabled: actionsDisabled, icon: <IconRefresh /> }}
        >
          Couldn't analyze remediation for {remediationError.package}: {remediationError.message}
        </StatusBanner>
      ) : null}

      {cleanupError !== null ? (
        <StatusBanner
          tone="error"
          action={{ label: 'Refresh', onClick: refresh, disabled: actionsDisabled, icon: <IconRefresh /> }}
        >
          Couldn't analyze dependency usage: {cleanupError}
        </StatusBanner>
      ) : null}

      {cleanupState.phase === 'analyzing' ? (
        <StatusBanner
          tone="info"
          icon={<IconRefresh className="banner__icon--spin" />}
          action={{ label: 'Cancel', onClick: requestCancelCleanup }}
        >
          Analyzing dependency usage
          {cleanupState.total > 0 ? ` — ${cleanupState.scanned} of ${cleanupState.total} files checked` : '…'}
        </StatusBanner>
      ) : null}

      {message !== undefined && 'data' in message ? (
        <Dashboard
          status={message.status}
          data={message.data}
          activeRemove={activeRemove}
          onOpenAdvisory={requestOpenAdvisory}
          search={search}
          onSearchChange={handleSearchChange}
          selectedFilter={selectedFilter}
          onSelectFilter={handleSelectFilter}
          dependencyType={dependencyType}
          onDependencyTypeChange={handleDependencyTypeChange}
          hygieneFilter={hygieneFilter}
          onHygieneFilterChange={handleHygieneFilterChange}
          sortState={sortState}
          onSort={handleSort}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={handlePageSizeChange}
          canChangeProject={message.data.canChangeProject}
          onChangeProject={changeProject}
          onRefresh={refresh}
          actionsDisabled={actionsDisabled}
          cleanupFindings={cleanupFindings}
          cleanupAnalyzed={cleanupState.phase === 'done'}
          onOpenSmartCleanup={startSmartCleanup}
          onOpenBulkActions={() => setBulkActionsOpen(true)}
          onOpenManage={openManage}
        />
      ) : null}

      {manageRow !== null && data !== undefined
        ? (() => {
            const row = data.rows.find((candidate) => candidate.name === manageRow);
            if (row === undefined) return null;
            const upgradeActive = upgradeOrigin === 'manage-dependency' && activeUpgrade === row.name;
            const removeActive =
              (removeOrigin === 'manage-dependency' && activeRemove === row.name) || pendingManageRemoval === row.name;
            // Once an embedded removal analysis has finished, Upgrade review
            // becomes available again. Its Analyze action performs the lock
            // handoff above; genuinely active work remains disabled.
            const embeddedRemovalCanYield = removeActive && removeAnalysis !== null && !removeBusy;
            // `actionsDisabled` treats every retained removal review as active
            // because it is also shared with dashboard-level controls. Inside
            // this same Manage workspace, a completed read-only review may be
            // replaced deliberately; preserve every other global blocker and
            // keep actual removal/remediation work protected.
            const manageActionsDisabled =
              loading ||
              activeUpgrade !== null ||
              remediationBusy ||
              cleanupState.phase === 'analyzing' ||
              (activeRemove !== null && !embeddedRemovalCanYield);
            const manageUpgradeDisabled =
              coreDataIncomplete ||
              loading ||
              cleanupState.phase === 'analyzing' ||
              remediationBusy ||
              confirmBusy ||
              removeBusy ||
              removalImpact.phase === 'analyzing' ||
              (activeRemove !== null && !embeddedRemovalCanYield) ||
              (activeUpgrade !== null && !upgradeActive);
            return (
              <ManageDependencyModal
                row={row}
                allRows={data.rows}
                remediation={remediationByPackage.get(row.name)}
                removalImpact={removalImpact}
                usage={usageByPackage.get(row.name)}
                hygieneFindings={allHygieneFindings}
                activeTab={manageTab}
                onChangeTab={setManageTab}
                actionsDisabled={manageActionsDisabled}
                upgradeDisabled={manageUpgradeDisabled}
                updateResolutionAvailable={!data.availability.unavailableUpdatePackages.includes(row.name)}
                advisoriesAvailable={data.availability.advisories === 'complete'}
                blockClose={
                  removalImpact.phase === 'analyzing' ||
                  confirmBusy ||
                  removeBusy ||
                  remediationByPackage.get(row.name)?.phase === 'applying'
                }
                upgradeResult={upgradeResult?.package === row.name ? upgradeResult : null}
                upgradeEnrichment={upgradeResult?.package === row.name ? upgradeEnrichment : null}
                upgrade={{
                  targetVersion: selectedManageTarget,
                  targetState: upgradeTargetState,
                  active: upgradeActive,
                  analyzingPhase: upgradeActive ? analyzingPhase : null,
                  analysis: upgradeActive ? analysis : null,
                  sections: upgradeActive ? analysisSections : WAITING_UPGRADE_ANALYSIS_SECTIONS,
                  hardStale: upgradeActive && hardStaleAnalysisId !== null && hardStaleAnalysisId === analysis?.analysisId,
                  busy: confirmBusy,
                  error:
                    upgradeOrigin === 'manage-dependency' && upgradeError?.package === row.name
                      ? upgradeError.message
                      : null,
                  onAnalyze: (target) => requestUpgradeFromManage(row.name, target),
                  onTargetChange: (target) => changeManageUpgradeTarget(row.name, target),
                  onConfirm: requestConfirmUpgrade,
                  onUseSmartPlan: requestUseSmartPlan,
                  onCancel: requestCancelUpgrade,
                  onConfigureVerification: requestConfigureVerification,
                  onRefresh: () => {
                    if (selectedManageTarget !== null) {
                      requestRefreshUpgradeAnalysis(row.name, selectedManageTarget);
                    }
                  },
                }}
                removal={{
                  active: removeActive,
                  analysis: removeActive ? removeAnalysis : null,
                  busy: removeBusy,
                  error:
                    removeOrigin === 'manage-dependency' && removeError?.package === row.name
                      ? { code: removeError.code, message: removeError.message }
                      : null,
                  onAnalyze: () => requestRemoveFromManage(row.name),
                  onConfirm: requestConfirmRemove,
                  onConfigureVerification: requestConfigureVerification,
                }}
                onAnalyzeRemediation={requestAnalyzeRemediation}
                onReviewRemediation={reviewRemediation}
                onApplyRemediation={requestApplyRemediation}
                onCancelRemediation={requestCancelRemediation}
                onRetryRemediation={requestRetryRemediation}
                onOpenAdvisory={requestOpenAdvisory}
                onReanalyzeUsage={requestReanalyzeUsage}
                onOpenUsageReference={requestOpenUsageReference}
                onRetryUpgradeEnrichment={requestRetryUpgradeEnrichment}
                now={minuteClock}
                onClose={closeManage}
                closeLabel={smartCleanupDrilldownRef.current === null ? 'Close' : 'Back to Smart Cleanup'}
              />
            );
          })()
        : null}

      {bulkActionsOpen && data !== undefined ? (
        <ManageDependenciesModal
          rows={data.rows}
          hygieneFindings={allHygieneFindings}
          initialCriteria={criteriaFromDashboardFilters(hygieneFilter, dependencyType)}
          cleanupBusy={cleanupState.phase === 'analyzing'}
          onRecheckHealth={requestBulkAnalyzeCleanup}
          onBulkUpgrade={requestBulkUpgrade}
          onBulkRemove={requestBulkRemove}
          removalImpact={removalImpact}
          onAnalyzeRemovalImpact={requestAnalyzeRemovalImpact}
          onCancelRemovalImpact={requestCancelRemovalImpact}
          onClose={() => {
            if (removalImpact.phase === 'analyzing') requestCancelRemovalImpact();
            setBulkActionsOpen(false);
          }}
        />
      ) : null}

      {smartCleanupOpen ? (
        <SmartCleanupWorkspace
          state={smartCleanupState}
          dispatch={dispatchSmartCleanup}
          onClose={closeSmartCleanup}
          onAnalyze={startSmartCleanup}
          onCancelAnalysis={closeSmartCleanup}
          removalPreflight={removeOrigin === 'smart-cleanup' ? removeAnalysis : null}
          preflightBusy={removeOrigin === 'smart-cleanup' && removeBusy}
          onPrepareRemoval={prepareSmartCleanup}
          onConfirmRemoval={confirmSmartCleanup}
          onKeepDependency={keepDependencyFromSmartCleanupConfirmation}
          onBackToReview={backFromSmartCleanupConfirmation}
          onOpenDependencyReview={openDependencyReviewFromSmartCleanup}
          reviewEvidenceRefreshing={smartCleanupState.phase !== 'analyzing' && removalImpact.phase === 'analyzing'}
        />
      ) : null}

      {activeUpgrade !== null && activeTarget !== null && upgradeOrigin !== 'manage-dependency' ? (
        <UpgradeAnalysisModal
          packageName={activeUpgrade}
          targetVersion={activeTarget}
          analyzingPhase={analyzingPhase}
          analysis={analysis}
          pendingChanges={activeUpgradeChanges}
          busy={confirmBusy}
          hardStale={hardStaleAnalysisId !== null && hardStaleAnalysisId === analysis?.analysisId}
          now={minuteClock}
          onConfirm={requestConfirmUpgrade}
          onUseSmartPlan={requestUseSmartPlan}
          onCancel={requestCancelUpgrade}
          onRefresh={() => {
            const changes = [...activeUpgradeChanges];
            requestCancelUpgrade();
            requestBulkUpgrade(changes);
          }}
          onConfigureVerification={requestConfigureVerification}
          onOpenAdvisory={requestOpenAdvisory}
          onOpenUsageReference={requestOpenUsageReference}
        />
      ) : null}

      {activeRemove !== null && removeOrigin !== 'manage-dependency' && removeOrigin !== 'smart-cleanup' ? (
        <RemoveAnalysisModal
          packages={activeRemoveChanges}
          analysis={removeAnalysis}
          matchTags={removeMatchTags}
          busy={removeBusy}
          onConfirm={requestConfirmRemove}
          onCancel={requestCancelRemove}
          onConfigureVerification={requestConfigureVerification}
        />
      ) : null}
    </main>
  );
}

function Dashboard({
  status,
  data,
  activeRemove,
  onOpenAdvisory,
  search,
  onSearchChange,
  selectedFilter,
  onSelectFilter,
  dependencyType,
  onDependencyTypeChange,
  hygieneFilter,
  onHygieneFilterChange,
  sortState,
  onSort,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  canChangeProject,
  onChangeProject,
  onRefresh,
  actionsDisabled,
  cleanupFindings,
  cleanupAnalyzed,
  onOpenSmartCleanup,
  onOpenBulkActions,
  onOpenManage,
}: {
  status: 'empty' | 'ready' | 'stale' | 'partial-error';
  data: DashboardData;
  /** Non-null while a coordinated removal holds the panel-wide lock — disables the bulk "Manage dependencies" entry point the same way a stale scan does. */
  activeRemove: string | null;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[], reference?: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  selectedFilter: SummaryFilterId;
  onSelectFilter: (filter: SummaryFilterId) => void;
  dependencyType: DependencyTypeFilterValue;
  onDependencyTypeChange: (value: DependencyTypeFilterValue) => void;
  hygieneFilter: HygieneFilterId;
  onHygieneFilterChange: (value: HygieneFilterId) => void;
  sortState: TableSortState;
  onSort: (column: SortColumn) => void;
  page: number;
  pageSize: PageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
  canChangeProject: boolean;
  onChangeProject: () => void;
  onRefresh: () => void;
  actionsDisabled: boolean;
  /** Likely-unused findings from the last completed "Analyze cleanup" run this session — see App.tsx. */
  cleanupFindings: readonly DependencyFinding[];
  cleanupAnalyzed: boolean;
  onOpenSmartCleanup: () => void;
  onOpenBulkActions: () => void;
  onOpenManage: (packageName: string) => void;
}): ReactElement {
  // Availability is independent of freshness: a stale degraded snapshot must
  // say both "refreshing" and which facts are unavailable. Status precedence
  // on the wire must never hide the latter.
  const degraded = partialErrorText(data);
  // A UX nicety only — the host independently rejects any upgrade request
  // against stale/revalidating data regardless of what this webview shows
  // (DashboardController.isEligible/beginRevalidation); this just keeps a
  // button from inviting a click the host is about to refuse anyway.
  // Structural/manual revalidation announces `stale` with whatever was
  // already on screen, so this single check covers the interval in which
  // mutation authority has been revoked. Cache-age-only refreshes remain
  // `ready`; the post-upgrade targeted path sets `stale` once because its
  // local facts are fresh while registry/security fields are still being
  // enriched.
  // Also disabled while a removal holds the shared panel-wide lock — the
  // same "the host would refuse this anyway" reasoning as `stale` above.
  const upgradesDisabled =
    status === 'stale' ||
    activeRemove !== null ||
    data.availability.updates === 'partial' ||
    data.availability.advisories === 'unavailable';

  const metrics = useMemo(() => summaryMetrics(data.rows), [data.rows]);
  const unavailableUpdatePackages = useMemo(
    () => new Set(data.availability.unavailableUpdatePackages),
    [data.availability.unavailableUpdatePackages]
  );

  const hygieneFindings = useMemo(
    () => [...data.hygieneFindings, ...cleanupFindings],
    [data.hygieneFindings, cleanupFindings]
  );
  // Faceted against each other: the Type filter's own selection is
  // deliberately excluded when computing Finding's counts. Production and
  // Dev remain contextual to the active Finding filter, while All is the
  // stable project-wide dependency total: changing a hygiene filter must not
  // make the meaning of "All" shift underneath the user. The matching-results
  // status below communicates the narrowed table size instead. The summary-
  // card filter and search are deliberately left out of these counts: those
  // are global/transient, not part of this pair's own AND relationship.
  const findingCounts = useMemo(
    () => hygieneFilterCounts(data.rows.filter(dependencyTypeFilterPredicate(dependencyType)), hygieneFindings),
    [data.rows, dependencyType, hygieneFindings]
  );
  const typeCounts = useMemo(
    () => {
      const contextualCounts = dependencyTypeFilterCounts(
        data.rows.filter(hygieneFilterPredicate(hygieneFilter, hygieneFindings))
      );
      return { ...contextualCounts, all: data.rows.length };
    },
    [data.rows, hygieneFilter, hygieneFindings]
  );

  const query = search.trim().toLowerCase();
  const filteredRows = useMemo(() => {
    const matchesCard = summaryFilterPredicate(selectedFilter);
    const matchesType = dependencyTypeFilterPredicate(dependencyType);
    const matchesHygiene = hygieneFilterPredicate(hygieneFilter, hygieneFindings);
    const rows = data.rows.filter(
      (row) =>
        matchesCard(row) &&
        matchesType(row) &&
        matchesHygiene(row) &&
        dependencyRowMatchesSearch(row, query)
    );
    return sortRows(rows, sortState, selectedFilter);
  }, [data.rows, selectedFilter, dependencyType, hygieneFilter, hygieneFindings, query, sortState]);

  const pageResult = useMemo(
    () => paginate(filteredRows, page, pageSize),
    [filteredRows, page, pageSize]
  );

  return (
    <>
      {status === 'stale' ? (
        <p className="stale-status">
          <IconRefresh className="stale-status__icon" />
          Showing cached results from {formatTime(data.generatedAt)} · Refreshing…
        </p>
      ) : null}

      {/* A degraded slice of the data still renders the table — hiding every
          column because one is missing is worse than showing what we have. */}
      {degraded === null ? null : (
        <StatusBanner
          tone="warning"
          action={{ label: 'Refresh', onClick: onRefresh, disabled: actionsDisabled, icon: <IconRefresh /> }}
        >
          Showing partial results: {degraded}.
        </StatusBanner>
      )}

      {status === 'empty' ? (
        <DependencyEmptyState
          icon="package"
          title="No dependencies found"
          detail="This project doesn't declare any dependencies yet."
        />
      ) : (
        <>
          <SummaryCards
            metrics={metrics}
            availability={data.availability}
            selected={selectedFilter}
            onSelect={onSelectFilter}
          />

          <DashboardToolbar
            canChangeProject={canChangeProject}
            onChangeProject={onChangeProject}
            onRefresh={onRefresh}
            disabled={actionsDisabled}
            refreshing={status === 'stale'}
            trailingActions={
              <div className="toolbar__analysis-actions">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={onOpenSmartCleanup}
                  disabled={actionsDisabled || upgradesDisabled}
                  title="Find evidence-backed cleanup opportunities and remove approved unused dependencies"
                >
                  <IconBroom />
                  Smart Cleanup
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={onOpenBulkActions}
                  disabled={actionsDisabled || upgradesDisabled}
                  title="Upgrade, remove, or check multiple dependencies at once"
                >
                  <IconListChecks />
                  Manage dependencies
                </button>
              </div>
            }
          >
            <DependencyTypeFilter value={dependencyType} counts={typeCounts} onChange={onDependencyTypeChange} />
            <HygieneFilter
              value={hygieneFilter}
              likelyUnusedCount={findingCounts['likely-unused']}
              duplicateCount={findingCounts['duplicate-version']}
              onChange={onHygieneFilterChange}
            />
          </DashboardToolbar>

          {filteredRows.length === data.rows.length ? null : (
            <p className="dashboard__matching-results" aria-live="polite">
              Current filters match {filteredRows.length} of {dependencyCountLabel(data.rows.length)}.
            </p>
          )}

          {filteredRows.length === 0 ? (
            query !== '' ? (
              <DependencyEmptyState
                icon="search"
                title={`No dependencies match "${search.trim()}"`}
                detail="Try another package name, vulnerability ID, dependency path, or clear the search."
                onClearSearch={() => {
                  onSearchChange('');
                }}
              />
            ) : (
              <DependencyEmptyState
                icon="filter"
                title={filterEmptyStateTitle(
                  selectedFilter,
                  dependencyType,
                  hygieneFilter,
                  cleanupAnalyzed
                )}
                detail="Nothing matches this filter."
              />
            )
          ) : (
            <>
              <PackageTable
                rows={pageResult.pageRows}
                unavailableUpdatePackages={unavailableUpdatePackages}
                advisoriesAvailable={data.availability.advisories === 'complete'}
                searchQuery={search}
                onOpenAdvisory={onOpenAdvisory}
                sortState={sortState}
                onSort={onSort}
                hygieneFindings={hygieneFindings}
                onOpenManage={onOpenManage}
              />
              <Pagination
                currentPage={pageResult.currentPage}
                totalPages={pageResult.totalPages}
                totalRows={pageResult.totalRows}
                pageSize={pageSize}
                onPageChange={onPageChange}
                onPageSizeChange={onPageSizeChange}
              />
            </>
          )}
        </>
      )}

      <p className="dashboard__footer">
        {dependencyCountLabel(data.rows.length)} • Updated {formatTime(data.generatedAt)}
        <span className="dashboard__build-stamp" title="Confirms which build of the extension is currently loaded">
          {' '}• v{data.extensionVersion} · built {formatTime(data.builtAt)}
        </span>
      </p>
    </>
  );
}
