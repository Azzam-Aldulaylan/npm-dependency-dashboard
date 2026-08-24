import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { DependencyFinding } from '../../src/core/hygiene/types.js';
import type { DependencyTypeFilter as DependencyTypeFilterValue } from '../../src/host/dependencyTypeFilter.js';
import { dependencyTypeFilterCounts, dependencyTypeFilterPredicate } from '../../src/host/dependencyTypeFilter.js';
import { dependencyCountLabel } from '../../src/host/dependencySummary.js';
import { filterEmptyStateTitle } from '../../src/host/emptyStateCopy.js';
import type { HygieneFilterId } from '../../src/host/hygieneFilter.js';
import { hygieneFilterCounts, hygieneFilterPredicate } from '../../src/host/hygieneFilter.js';
import { manageRemovalReadyPackage } from '../../src/host/manageRemovalFlow.js';
import type { PageSize } from '../../src/host/pagination.js';
import { DEFAULT_PAGE_SIZE, paginate } from '../../src/host/pagination.js';
import type { SummaryFilterId } from '../../src/host/summaryMetrics.js';
import { summaryFilterPredicate, summaryMetrics } from '../../src/host/summaryMetrics.js';
import type { SortColumn, TableSortState } from '../../src/host/tableSort.js';
import { nextColumnSortState, sortRows } from '../../src/host/tableSort.js';
import type { TransitiveRemediationUiState } from '../../src/host/upgradeAction.js';
import { resolveActionState } from '../../src/host/upgradeAction.js';
import {
  manageRemovalReplacesUpgradeReview,
  upgradeAnalysisRequestIsAllowed,
  upgradeErrorClearsActiveState,
  upgradeErrorIsUserVisible,
} from '../../src/host/upgradeUiState.js';
import type {
  DashboardData,
  HostToWebviewMessage,
  RemoveAnalysisPresentation,
  ScanProgressStage,
  UpgradeAnalysisPresentation,
} from '../../src/host/webviewProtocol.js';
import { isHostToWebviewMessage } from '../../src/host/webviewProtocol.js';
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
import { UpgradeAnalysisModal } from './components/UpgradeAnalysisModal.js';
import type { UsageRequestState } from './components/UsageReferencesPanel.js';
import { IconAlertTriangle, IconListChecks, IconRefresh } from './icons.js';
import type { RemovalImpactState } from './removalImpactState.js';
import { vscode } from './vscodeApi.js';

function formatTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

function formatAnalysisAge(analyzedAt: string, cacheExpiresAt: string, now: number): string {
  const timestamp = Date.parse(analyzedAt);
  const expiresAt = Date.parse(cacheExpiresAt);
  const stale = Number.isFinite(expiresAt) && now >= expiresAt;
  if (!Number.isFinite(timestamp)) return stale ? 'Previous analysis · stale' : 'Previous analysis';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  const age = minutes === 0 ? 'Analyzed just now' : `Analyzed ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return stale ? `${age} · stale` : age;
}

function partialErrorText(data: DashboardData): string | null {
  const reasons: string[] = [];
  if (data.advisoriesError !== undefined) {
    reasons.push(`vulnerability data is unavailable (${data.advisoriesError.code})`);
  }
  if (data.auditUnavailable === true) {
    reasons.push('npm audit could not run, so upgrade targets are self-computed');
  }
  return reasons.length === 0 ? null : reasons.join('; ');
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
  const [analyzingPhase, setAnalyzingPhase] = useState<'compatibility' | 'smart-plan' | null>(null);
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
  const [removeOrigin, setRemoveOrigin] = useState<'dashboard' | 'manage-dependency' | null>(null);
  const activeRemoveRef = useRef<string | null>(null);
  useEffect(() => {
    activeRemoveRef.current = activeRemove;
  }, [activeRemove]);

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
  // though the default "all" card's own implied order is alphabetical (see
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
  const [remediationByPackage, setRemediationByPackage] = useState<ReadonlyMap<string, TransitiveRemediationUiState>>(
    () => new Map()
  );
  const [remediationError, setRemediationError] = useState<{ package: string; message: string } | null>(null);
  const [remediationBatch, setRemediationBatch] = useState<
    | { phase: 'idle' }
    | { phase: 'running'; completed: number; total: number; current: string | null }
  >({ phase: 'idle' });
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
  // Which surface started the currently-active upgrade — 'manage-dependency'
  // (Manage's Upgrade review tab, reviewed inline, never a second dialog) or
  // 'dashboard' (the bulk "Manage dependencies" flow, which still opens the
  // standalone UpgradeAnalysisModal). Same split removeOrigin already uses
  // for removal below.
  const [upgradeOrigin, setUpgradeOrigin] = useState<'dashboard' | 'manage-dependency' | null>(null);
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
  // The one shared removal-impact preview state — see removalImpactState.ts's
  // own doc for why the bulk Review step and the single-package "Analyze
  // removal" card share it rather than each keeping their own copy.
  const [removalImpact, setRemovalImpact] = useState<RemovalImpactState>({ phase: 'idle' });
  // A Manage-tab removal first runs this read-only impact scan. Only its
  // matching result starts the existing removal preflight; posting both at
  // once would reserve the coordinator and make the host reject the scan.
  const [pendingManageRemoval, setPendingManageRemoval] = useState<string | null>(null);
  const cleanupShouldSelectFilter = useRef(false);
  const [minuteClock, setMinuteClock] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setMinuteClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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

      if (incoming.status === 'upgrade-error') {
        // Never touches `message` — the rendered table/banners are exactly
        // what they were before this arrived.
        if (upgradeErrorClearsActiveState(incoming.error.code)) {
          activeUpgradeRef.current = null;
          setActiveUpgrade(null);
          setActiveTarget(null);
          setActiveUpgradeChanges([]);
          setAnalysis(null);
          setAnalyzingPhase(null);
          setConfirmBusy(false);
        }
        if (upgradeErrorIsUserVisible(incoming.error.code)) {
          setUpgradeError({ package: incoming.package, code: incoming.error.code, message: incoming.error.message });
        }
        return;
      }

      if (incoming.status === 'upgrade-analyzing') {
        if (incoming.package === activeUpgradeRef.current) setAnalyzingPhase(incoming.phase);
        return;
      }

      if (incoming.status === 'upgrade-analysis') {
        // Ignored if it's not about the flow this webview is still tracking
        // (e.g. a result that arrived just after a client-side cancel) — see
        // requestCancelUpgrade below for why this can still legitimately
        // happen even though the host is also told to drop it.
        if (incoming.analysis.package === activeUpgradeRef.current) {
          setAnalysis(incoming.analysis);
          setAnalyzingPhase(null);
        }
        return;
      }

      if (incoming.status === 'remove-error') {
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
        if (upgradeErrorIsUserVisible(incoming.error.code)) {
          setRemoveError({ package: incoming.package, code: incoming.error.code, message: incoming.error.message });
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
        if (incoming.analysis.package === activeRemoveRef.current) {
          setRemoveAnalysis(incoming.analysis);
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
          next.set(incoming.package, { phase: 'done', status: incoming.result.status });
          return next;
        });
        return;
      }

      if (incoming.status === 'remediation-error') {
        // Reverts to "Analyze remediation" rather than getting stuck showing
        // "Analyzing…" forever — an ineligible/stale/forged request or a
        // resolver failure is not a result worth remembering as this row's
        // remediation state.
        setRemediationByPackage((previous) => {
          if (!previous.has(incoming.package)) return previous;
          const next = new Map(previous);
          next.delete(incoming.package);
          return next;
        });
        setRemediationError({ package: incoming.package, message: incoming.error.message });
        return;
      }

      if (incoming.status === 'remediation-batch-progress') {
        setRemediationBatch({
          phase: 'running',
          completed: incoming.completed,
          total: incoming.total,
          current: incoming.current,
        });
        return;
      }

      if (incoming.status === 'remediation-batch-complete') {
        setRemediationBatch({ phase: 'idle' });
        return;
      }

      if (incoming.status === 'remediation-batch-error') {
        setRemediationBatch({ phase: 'idle' });
        setRemediationError({ package: 'selected dependencies', message: incoming.error.message });
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
        setCleanupState({ phase: 'analyzing', scanned: incoming.scanned, total: incoming.total });
        return;
      }

      if (incoming.status === 'cleanup-result') {
        setCleanupState({
          phase: 'done',
          analyzedAt: incoming.analyzedAt,
          cacheExpiresAt: incoming.cacheExpiresAt,
        });
        setCleanupFindings(incoming.findings);
        if (cleanupShouldSelectFilter.current) {
          cleanupShouldSelectFilter.current = false;
          setHygieneFilter('likely-unused');
          setPage(1);
        }
        return;
      }

      if (incoming.status === 'cleanup-error') {
        cleanupShouldSelectFilter.current = false;
        setCleanupState({ phase: 'idle' });
        setCleanupError(incoming.error.message);
        return;
      }

      if (incoming.status === 'removal-impact-analyzing') {
        setRemovalImpact({ phase: 'analyzing', scanned: incoming.scanned, total: incoming.total });
        return;
      }

      if (incoming.status === 'removal-impact-result') {
        setRemovalImpact({
          phase: 'done',
          assessments: new Map(
            incoming.assessments.map((entry) => [entry.packageName, { assessment: entry.assessment, usageId: entry.usageId }])
          ),
          generatedAt: incoming.generatedAt,
        });
        return;
      }

      if (incoming.status === 'removal-impact-error') {
        setRemovalImpact({ phase: 'error', message: incoming.error.message });
        return;
      }

      // Any other message is a fresh snapshot that supersedes whatever
      // optimistic upgrade state was showing.
      activeUpgradeRef.current = null;
      setActiveUpgrade(null);
      setActiveTarget(null);
      setActiveUpgradeChanges([]);
      setAnalysis(null);
      setAnalyzingPhase(null);
      setConfirmBusy(false);
      setUpgradeError(null);
      setUpgradeOrigin(null);
      activeRemoveRef.current = null;
      setActiveRemove(null);
      setActiveRemoveChanges([]);
      setRemoveMatchTags(new Map());
      setRemoveAnalysis(null);
      setRemoveBusy(false);
      setRemoveError(null);
      setRemoveOrigin(null);
      setRemediationByPackage(new Map());
      setRemediationError(null);
      setRemediationBatch({ phase: 'idle' });
      setBulkActionsOpen(false);
      setManageRow(null);
      setManageTab('overview');
      // Usage-analysis results and unused findings are relative to the rows
      // a scan just replaced — never carried forward as if they still
      // describe the current dependency set. `cleanupState` itself is left
      // alone: a running "Analyze cleanup" scan is independent host-side
      // work this message doesn't affect.
      setUsageByPackage(new Map());
      setCleanupFindings([]);
      setCleanupError(null);
      cleanupShouldSelectFilter.current = false;
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
      setMessage(incoming);
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
    activeUpgradeRef.current = packageName;
    setActiveUpgrade(packageName);
    setActiveTarget(target);
    setActiveUpgradeChanges([{ packageName, currentVersion: '', targetVersion: target, major: false }]);
    setAnalysis(null);
    setAnalyzingPhase(null);
    setConfirmBusy(false);
    setUpgradeOrigin('manage-dependency');
    vscode.postMessage({ type: 'upgrade', package: packageName, target });
  }, []);

  const requestBulkUpgrade = useCallback((changes: readonly BulkUpgradeCandidate[]) => {
    const first = changes[0];
    if (first === undefined) return;
    activeUpgradeRef.current = first.packageName;
    setActiveUpgrade(first.packageName);
    setActiveTarget(first.targetVersion);
    setActiveUpgradeChanges(changes);
    setAnalysis(null);
    setAnalyzingPhase(null);
    setConfirmBusy(false);
    setUpgradeOrigin('dashboard');
    vscode.postMessage({
      type: 'bulk-upgrade',
      changes: changes.map((change) => ({ package: change.packageName, target: change.targetVersion })),
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
    setActiveTarget(null);
    setActiveUpgradeChanges([]);
    setAnalysis(null);
    setAnalyzingPhase(null);
    setConfirmBusy(false);
    setUpgradeOrigin(null);
  }, [analysis]);

  const requestConfigureVerification = useCallback(() => {
    vscode.postMessage({ type: 'configure-verification' });
  }, []);

  const requestBulkRemove = useCallback(
    (
      packageNames: readonly string[],
      matchTags: ReadonlyMap<string, readonly string[]>,
      origin: 'dashboard' | 'manage-dependency' = 'dashboard'
    ) => {
      const first = packageNames[0];
      if (first === undefined) return;
      activeRemoveRef.current = first;
      setActiveRemove(first);
      setActiveRemoveChanges(packageNames);
      setRemoveMatchTags(matchTags);
      setRemoveAnalysis(null);
      setRemoveBusy(false);
      setRemoveOrigin(origin);
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
    setActiveRemove(null);
    activeRemoveRef.current = null;
    setActiveRemoveChanges([]);
    setRemoveMatchTags(new Map());
    setRemoveAnalysis(null);
    setRemoveBusy(false);
    setRemoveOrigin(null);
  }, [removeAnalysis]);

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
  const requestOpenAdvisory = useCallback((packageName: string, advisoryId: string | number, path: string[]) => {
    vscode.postMessage({ type: 'open-advisory', package: packageName, advisoryId, path });
  }, []);

  // Only ever a package name — see analyze-remediation's own doc in
  // webviewProtocol.ts. The host re-derives everything else from its own
  // last-trusted scan.
  const requestAnalyzeRemediation = useCallback((packageName: string) => {
    setRemediationError(null);
    vscode.postMessage({ type: 'analyze-remediation', package: packageName });
  }, []);

  const requestAnalyzeRemediations = useCallback((packages: readonly string[]) => {
    if (packages.length === 0) return;
    setRemediationError(null);
    setRemediationBatch({ phase: 'running', completed: 0, total: packages.length, current: null });
    vscode.postMessage({ type: 'analyze-remediations', packages: [...packages] });
  }, []);

  const requestCancelRemediationBatch = useCallback(() => {
    vscode.postMessage({ type: 'cancel-remediation-analysis' });
  }, []);

  const openManage = useCallback((packageName: string) => {
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
    cleanupShouldSelectFilter.current = true;
    setCleanupError(null);
    vscode.postMessage({ type: 'analyze-cleanup' });
  }, []);

  const requestCancelCleanup = useCallback(() => {
    vscode.postMessage({ type: 'cancel-usage-analysis' });
  }, []);

  // Read-only removal-impact preview — shared by the bulk Review step and
  // the single-package "Analyze removal" card (see removalImpactState.ts).
  // Never gates the actual removal transaction; bulk-remove/confirm-remove
  // still re-validates everything fresh regardless of what this shows.
  const requestAnalyzeRemovalImpact = useCallback((packageNames: readonly string[]) => {
    if (packageNames.length === 0) return;
    setRemovalImpact({ phase: 'analyzing', scanned: 0, total: 0 });
    vscode.postMessage({ type: 'analyze-removal-impact', packages: [...packageNames] });
  }, []);

  const requestCancelRemovalImpact = useCallback(() => {
    vscode.postMessage({ type: 'cancel-usage-analysis' });
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
    setManageTab('overview');
    setPendingManageRemoval(null);
  }, [
    removalImpact,
    requestCancelRemovalImpact,
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
  const allHygieneFindings = useMemo(
    () => [...(data?.hygieneFindings ?? []), ...cleanupFindings],
    [data?.hygieneFindings, cleanupFindings]
  );
  // Which rows currently offer "Check transitive fix" — the one legal
  // action ManageDependenciesModal can't derive from `rows` alone, since it
  // depends on this session's own remediationByPackage state.
  const remediationEligibleNames = useMemo(
    () =>
      new Set(
        (data?.rows ?? []).flatMap((row) => {
          const action = resolveActionState(row, remediationByPackage.get(row.name));
          return action.kind === 'transitive-remediation' || action.kind === 'remediation-unknown' ? [row.name] : [];
        })
      ),
    [data?.rows, remediationByPackage]
  );
  // Disabled while an upgrade or removal is active — a manual refresh or
  // project switch mid-operation would race the scan (and, for a project
  // switch, a controller replacement) against a package.json/lockfile the
  // task is still writing to; the host rejects both too (see
  // DashboardPanel.handle), this just keeps the buttons from inviting a
  // click that can't do anything anyway.
  const actionsDisabled =
    loading ||
    activeUpgrade !== null ||
    activeRemove !== null ||
    cleanupState.phase === 'analyzing' ||
    remediationBatch.phase === 'running';

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
        <div className="banner banner--error" role="alert">
          <IconAlertTriangle className="banner__icon" />
          <p className="banner__text">{message.error.message}</p>
          <button className="button" type="button" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {/* upgradeError is only ever set for a user-visible code (see
          upgradeErrorIsUserVisible) — CANCELLED and UPGRADE_IN_PROGRESS never
          reach this state at all, so there is nothing to filter here. */}
      {upgradeError !== null ? (
        <div className="banner banner--error" role="alert">
          <IconAlertTriangle className="banner__icon" />
          <p className="banner__text">
            Couldn't upgrade {upgradeError.package}: {upgradeError.message}
          </p>
          <button className="button button--secondary" type="button" onClick={refresh} disabled={actionsDisabled}>
            Refresh
          </button>
        </div>
      ) : null}

      {removeError !== null ? (
        <div className="banner banner--error" role="alert">
          <IconAlertTriangle className="banner__icon" />
          <p className="banner__text">
            Couldn't remove {removeError.package}: {removeError.message}
          </p>
          <button className="button button--secondary" type="button" onClick={refresh} disabled={actionsDisabled}>
            Refresh
          </button>
        </div>
      ) : null}

      {remediationError !== null ? (
        <div className="banner banner--error" role="alert">
          <IconAlertTriangle className="banner__icon" />
          <p className="banner__text">
            Couldn't analyze remediation for {remediationError.package}: {remediationError.message}
          </p>
          <button className="button button--secondary" type="button" onClick={refresh} disabled={actionsDisabled}>
            Refresh
          </button>
        </div>
      ) : null}

      {cleanupError !== null ? (
        <div className="banner banner--error" role="alert">
          <IconAlertTriangle className="banner__icon" />
          <p className="banner__text">Couldn't analyze dependency usage: {cleanupError}</p>
          <button className="button button--secondary" type="button" onClick={refresh} disabled={actionsDisabled}>
            Refresh
          </button>
        </div>
      ) : null}

      {cleanupState.phase === 'analyzing' ? (
        <div className="banner banner--info">
          <IconRefresh className="banner__icon banner__icon--spin" />
          <p className="banner__text">
            Analyzing dependency usage
            {cleanupState.total > 0 ? ` — ${cleanupState.scanned} of ${cleanupState.total} files checked` : '…'}
          </p>
          <button className="button button--secondary" type="button" onClick={requestCancelCleanup}>
            Cancel
          </button>
        </div>
      ) : null}

      {remediationBatch.phase === 'running' ? (
        <div className="banner banner--info">
          <IconRefresh className="banner__icon banner__icon--spin" />
          <p className="banner__text">
            Checking transitive fixes — {remediationBatch.completed} of {remediationBatch.total} analyzed
            {remediationBatch.current === null ? '' : ` · ${remediationBatch.current}`}
          </p>
          <button className="button button--secondary" type="button" onClick={requestCancelRemediationBatch}>
            Cancel
          </button>
        </div>
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
          cleanupAnalysis={cleanupState.phase === 'done' ? cleanupState : null}
          now={minuteClock}
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
            return (
              <ManageDependencyModal
                row={row}
                remediation={remediationByPackage.get(row.name)}
                removalImpact={removalImpact}
                usage={usageByPackage.get(row.name)}
                hygieneFindings={allHygieneFindings}
                activeTab={manageTab}
                onChangeTab={setManageTab}
                actionsDisabled={actionsDisabled}
                blockClose={removalImpact.phase === 'analyzing' || confirmBusy || removeBusy}
                upgrade={{
                  targetVersion: row.upgradeTo,
                  active: upgradeActive,
                  analyzingPhase: upgradeActive ? analyzingPhase : null,
                  analysis: upgradeActive ? analysis : null,
                  busy: confirmBusy,
                  onAnalyze: (target) => requestUpgrade(row.name, target),
                  onConfirm: requestConfirmUpgrade,
                  onUseSmartPlan: requestUseSmartPlan,
                  onCancel: requestCancelUpgrade,
                  onConfigureVerification: requestConfigureVerification,
                }}
                removal={{
                  active: removeActive,
                  analysis: removeActive ? removeAnalysis : null,
                  busy: removeBusy,
                  onAnalyze: () => requestRemoveFromManage(row.name),
                  onConfirm: requestConfirmRemove,
                  onConfigureVerification: requestConfigureVerification,
                }}
                onAnalyzeRemediation={requestAnalyzeRemediation}
                onOpenAdvisory={requestOpenAdvisory}
                onReanalyzeUsage={requestReanalyzeUsage}
                onOpenUsageReference={requestOpenUsageReference}
                now={minuteClock}
                onClose={closeManage}
              />
            );
          })()
        : null}

      {bulkActionsOpen && data !== undefined ? (
        <ManageDependenciesModal
          rows={data.rows}
          hygieneFindings={allHygieneFindings}
          remediationEligibleNames={remediationEligibleNames}
          cleanupBusy={cleanupState.phase === 'analyzing'}
          onRecheckHealth={requestBulkAnalyzeCleanup}
          onBulkUpgrade={requestBulkUpgrade}
          onBulkRemove={requestBulkRemove}
          onAnalyzeRemediations={requestAnalyzeRemediations}
          removalImpact={removalImpact}
          onAnalyzeRemovalImpact={requestAnalyzeRemovalImpact}
          onCancelRemovalImpact={requestCancelRemovalImpact}
          onClose={() => {
            if (removalImpact.phase === 'analyzing') requestCancelRemovalImpact();
            setBulkActionsOpen(false);
          }}
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
          onConfirm={requestConfirmUpgrade}
          onUseSmartPlan={requestUseSmartPlan}
          onCancel={requestCancelUpgrade}
          onConfigureVerification={requestConfigureVerification}
          onOpenAdvisory={requestOpenAdvisory}
        />
      ) : null}

      {activeRemove !== null && removeOrigin !== 'manage-dependency' ? (
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
  cleanupAnalysis,
  now,
  onOpenBulkActions,
  onOpenManage,
}: {
  status: 'empty' | 'ready' | 'stale' | 'partial-error';
  data: DashboardData;
  /** Non-null while a coordinated removal holds the panel-wide lock — disables the bulk "Manage dependencies" entry point the same way a stale scan does. */
  activeRemove: string | null;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
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
  cleanupAnalysis: { analyzedAt: string; cacheExpiresAt: string } | null;
  now: number;
  onOpenBulkActions: () => void;
  onOpenManage: (packageName: string) => void;
}): ReactElement {
  const degraded = status === 'partial-error' ? partialErrorText(data) : null;
  // A UX nicety only — the host independently rejects any upgrade request
  // against stale/revalidating data regardless of what this webview shows
  // (DashboardController.isEligible/beginRevalidation); this just keeps a
  // button from inviting a click the host is about to refuse anyway.
  // `run()` announces every revalidation attempt — manual-refresh-follow-up,
  // file-change-triggered, and plain background-timer ticks alike — as a
  // `stale` message carrying whatever was already on screen before it does
  // anything else, so this single check covers all of them: `stale` is up
  // for the entire duration a revalidation is in flight, and a failed one
  // (which posts nothing further) leaves it up until the next attempt.
  // Also disabled while a removal holds the shared panel-wide lock — the
  // same "the host would refuse this anyway" reasoning as `stale` above.
  const upgradesDisabled = status === 'stale' || activeRemove !== null;

  const metrics = useMemo(() => summaryMetrics(data.rows), [data.rows]);

  const hygieneFindings = useMemo(
    () => [...data.hygieneFindings, ...cleanupFindings],
    [data.hygieneFindings, cleanupFindings]
  );
  // Faceted against each other: the Type filter's own selection is
  // deliberately excluded when computing Finding's counts (and vice versa)
  // so picking "Production" immediately lowers what Likely unused/Duplicate
  // versions show, reflecting the actual combined match — not a count
  // frozen against the whole table. The summary-card filter and search are
  // deliberately left out of this narrowing: those are global/transient,
  // not part of this pair's own AND relationship.
  const findingCounts = useMemo(
    () => hygieneFilterCounts(data.rows.filter(dependencyTypeFilterPredicate(dependencyType)), hygieneFindings),
    [data.rows, dependencyType, hygieneFindings]
  );
  const typeCounts = useMemo(
    () => dependencyTypeFilterCounts(data.rows.filter(hygieneFilterPredicate(hygieneFilter, hygieneFindings))),
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
        (query === '' || row.name.toLowerCase().includes(query))
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
        <p className="banner banner--warning">
          <IconAlertTriangle className="banner__icon" />
          Showing partial results: {degraded}.
        </p>
      )}

      {status === 'empty' ? (
        <DependencyEmptyState
          icon="package"
          title="No dependencies found"
          detail="This project doesn't declare any dependencies yet."
        />
      ) : (
        <>
          <SummaryCards metrics={metrics} selected={selectedFilter} onSelect={onSelectFilter} />

          <DashboardToolbar
            canChangeProject={canChangeProject}
            onChangeProject={onChangeProject}
            onRefresh={onRefresh}
            disabled={actionsDisabled}
            trailingActions={
              <div className="toolbar__analysis-actions">
                {cleanupAnalysis !== null ? (
                  <span className="toolbar__analysis-age">
                    {formatAnalysisAge(cleanupAnalysis.analyzedAt, cleanupAnalysis.cacheExpiresAt, now)}
                  </span>
                ) : null}
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

          {filteredRows.length === 0 ? (
            query !== '' ? (
              <DependencyEmptyState
                icon="search"
                title={`No dependencies match "${search.trim()}"`}
                detail="Try another package name or clear the search."
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
                  cleanupAnalysis !== null
                )}
                detail="Nothing matches this filter."
              />
            )
          ) : (
            <>
              <PackageTable
                rows={pageResult.pageRows}
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
