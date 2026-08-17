import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { DependencyFinding } from '../../src/core/hygiene/types.js';
import type { DependencyTypeFilter as DependencyTypeFilterValue } from '../../src/host/dependencyTypeFilter.js';
import { dependencyTypeFilterPredicate } from '../../src/host/dependencyTypeFilter.js';
import { dependencyCountLabel } from '../../src/host/dependencySummary.js';
import { filterEmptyStateTitle } from '../../src/host/emptyStateCopy.js';
import type { PageSize } from '../../src/host/pagination.js';
import { DEFAULT_PAGE_SIZE, paginate } from '../../src/host/pagination.js';
import type { SummaryFilterId } from '../../src/host/summaryMetrics.js';
import { summaryFilterPredicate, summaryMetrics } from '../../src/host/summaryMetrics.js';
import type { SortColumn, TableSortState } from '../../src/host/tableSort.js';
import { nextColumnSortState, sortRows } from '../../src/host/tableSort.js';
import type { TransitiveRemediationUiState } from '../../src/host/upgradeAction.js';
import { upgradeErrorClearsActiveState, upgradeErrorIsUserVisible } from '../../src/host/upgradeUiState.js';
import type { DashboardData, HostToWebviewMessage, ScanProgressStage, UpgradeAnalysisPresentation } from '../../src/host/webviewProtocol.js';
import { isHostToWebviewMessage } from '../../src/host/webviewProtocol.js';
import { DashboardToolbar } from './components/DashboardToolbar.js';
import { DependencyDetailsModal } from './components/DependencyDetailsModal.js';
import type { UsageRequestState } from './components/DependencyDetailsModal.js';
import { DependencyEmptyState } from './components/DependencyEmptyState.js';
import { DependencyLoadingState } from './components/DependencyLoadingState.js';
import { DependencySearch } from './components/DependencySearch.js';
import { DependencyTypeFilter } from './components/DependencyTypeFilter.js';
import { Pagination } from './components/Pagination.js';
import { PackageTable } from './components/PackageTable.js';
import { SummaryCards } from './components/SummaryCards.js';
import { UpgradeAnalysisModal } from './components/UpgradeAnalysisModal.js';
import { IconAlertTriangle, IconBroom, IconRefresh } from './icons.js';
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
  // The one package this webview itself most recently asked to upgrade, or
  // null. The host allows only one upgrade at a time for the whole panel —
  // see UpgradeLock — so this mirrors that as a single value, not a set, and
  // disables every Upgrade button (not just the one clicked) while set.
  const [activeUpgrade, setActiveUpgrade] = useState<string | null>(null);
  // The target version of `activeUpgrade` — kept alongside it purely so the
  // Upgrade Analysis modal has something to show ("Analyzing X 11.1.0…")
  // before the host's `upgrade-analysis` reply carries the real analysis.
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
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

  // The row this webview session currently has "Dependency details" open
  // for, and its own on-demand usage-analysis state per package — see
  // DependencyDetailsModal.tsx. Never a fact from the host's own scan.
  const [detailsPackage, setDetailsPackage] = useState<string | null>(null);
  const [usageByPackage, setUsageByPackage] = useState<ReadonlyMap<string, UsageRequestState>>(() => new Map());
  const [cleanupState, setCleanupState] = useState<
    | { phase: 'idle' }
    | { phase: 'analyzing'; scanned: number; total: number }
    | { phase: 'done'; analyzedAt: string; cacheExpiresAt: string }
  >({ phase: 'idle' });
  const [cleanupFindings, setCleanupFindings] = useState<DependencyFinding[]>([]);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
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
          setActiveUpgrade(null);
          setActiveTarget(null);
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
        return;
      }

      if (incoming.status === 'cleanup-error') {
        setCleanupState({ phase: 'idle' });
        setCleanupError(incoming.error.message);
        return;
      }

      // Any other message is a fresh snapshot that supersedes whatever
      // optimistic upgrade state was showing.
      setActiveUpgrade(null);
      setActiveTarget(null);
      setAnalysis(null);
      setAnalyzingPhase(null);
      setConfirmBusy(false);
      setUpgradeError(null);
      setRemediationByPackage(new Map());
      setRemediationError(null);
      // Usage-analysis results and unused findings are relative to the rows
      // a scan just replaced — never carried forward as if they still
      // describe the current dependency set. `cleanupState` itself is left
      // alone: a running "Analyze cleanup" scan is independent host-side
      // work this message doesn't affect.
      setUsageByPackage(new Map());
      setCleanupFindings([]);
      setCleanupError(null);
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

  const requestUpgrade = useCallback((packageName: string, target: string) => {
    setActiveUpgrade(packageName);
    setActiveTarget(target);
    setAnalysis(null);
    setAnalyzingPhase(null);
    setConfirmBusy(false);
    vscode.postMessage({ type: 'upgrade', package: packageName, target });
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
    setActiveTarget(null);
    setAnalysis(null);
    setAnalyzingPhase(null);
    setConfirmBusy(false);
  }, [analysis]);

  const requestConfigureVerification = useCallback(() => {
    vscode.postMessage({ type: 'configure-verification' });
  }, []);

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

  const openDetails = useCallback((packageName: string) => {
    setDetailsPackage(packageName);
  }, []);

  const closeDetails = useCallback(() => {
    setDetailsPackage(null);
  }, []);

  // Shared by the row menu's "Where is this used?" and the details modal's
  // own "Scan workspace" button — both send the identical, package-name-only
  // request (see webviewProtocol.ts's own doc on 'where-used'). Never
  // re-requested once a result already exists for this package this session.
  const requestWhereUsed = useCallback(
    (packageName: string) => {
      setDetailsPackage(packageName);
      if (usageByPackage.get(packageName)?.phase === 'done') return;
      vscode.postMessage({ type: 'where-used', package: packageName });
    },
    [usageByPackage]
  );

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

  const requestAnalyzeCleanup = useCallback(() => {
    setCleanupError(null);
    vscode.postMessage({ type: 'analyze-cleanup' });
  }, []);

  const requestCancelCleanup = useCallback(() => {
    vscode.postMessage({ type: 'cancel-usage-analysis' });
  }, []);

  // No message yet is the same user-visible state as an explicit loading one.
  const loading = message === undefined || message.status === 'loading';
  const data = message !== undefined && 'data' in message ? message.data : undefined;
  // Disabled while an upgrade is active — a manual refresh or project switch
  // mid-upgrade would race the scan (and, for a project switch, a controller
  // replacement) against a package.json/lockfile the task is still writing
  // to; the host rejects both too (see DashboardPanel.handle), this just
  // keeps the buttons from inviting a click that can't do anything anyway.
  const actionsDisabled = loading || activeUpgrade !== null;

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
        </div>
      ) : null}

      {remediationError !== null ? (
        <div className="banner banner--error" role="alert">
          <IconAlertTriangle className="banner__icon" />
          <p className="banner__text">
            Couldn't analyze remediation for {remediationError.package}: {remediationError.message}
          </p>
        </div>
      ) : null}

      {cleanupError !== null ? (
        <div className="banner banner--error" role="alert">
          <IconAlertTriangle className="banner__icon" />
          <p className="banner__text">Couldn't analyze dependency usage: {cleanupError}</p>
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

      {message !== undefined && 'data' in message ? (
        <Dashboard
          status={message.status}
          data={message.data}
          activeUpgrade={activeUpgrade}
          onUpgrade={requestUpgrade}
          onOpenAdvisory={requestOpenAdvisory}
          remediationByPackage={remediationByPackage}
          onAnalyzeRemediation={requestAnalyzeRemediation}
          search={search}
          onSearchChange={handleSearchChange}
          selectedFilter={selectedFilter}
          onSelectFilter={handleSelectFilter}
          dependencyType={dependencyType}
          onDependencyTypeChange={handleDependencyTypeChange}
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
          cleanupBusy={cleanupState.phase === 'analyzing'}
          cleanupAnalysis={cleanupState.phase === 'done' ? cleanupState : null}
          now={minuteClock}
          onAnalyzeCleanup={requestAnalyzeCleanup}
          onOpenDetails={openDetails}
          onWhereUsed={requestWhereUsed}
        />
      ) : null}

      {activeUpgrade !== null && activeTarget !== null ? (
        <UpgradeAnalysisModal
          packageName={activeUpgrade}
          targetVersion={activeTarget}
          analyzingPhase={analyzingPhase}
          analysis={analysis}
          busy={confirmBusy}
          onConfirm={requestConfirmUpgrade}
          onUseSmartPlan={requestUseSmartPlan}
          onCancel={requestCancelUpgrade}
          onConfigureVerification={requestConfigureVerification}
          onOpenAdvisory={requestOpenAdvisory}
        />
      ) : null}

      {detailsPackage !== null && data !== undefined ? (
        (() => {
          const row = data.rows.find((candidate) => candidate.name === detailsPackage);
          if (row === undefined) return null;
          return (
            <DependencyDetailsModal
              row={row}
              hygieneFindings={[...data.hygieneFindings, ...cleanupFindings]}
              usage={usageByPackage.get(detailsPackage)}
              onRequestUsage={requestWhereUsed}
              onReanalyzeUsage={requestReanalyzeUsage}
              onOpenUsageReference={requestOpenUsageReference}
              now={minuteClock}
              onClose={closeDetails}
            />
          );
        })()
      ) : null}
    </main>
  );
}

function Dashboard({
  status,
  data,
  activeUpgrade,
  onUpgrade,
  onOpenAdvisory,
  remediationByPackage,
  onAnalyzeRemediation,
  search,
  onSearchChange,
  selectedFilter,
  onSelectFilter,
  dependencyType,
  onDependencyTypeChange,
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
  cleanupBusy,
  cleanupAnalysis,
  now,
  onAnalyzeCleanup,
  onOpenDetails,
  onWhereUsed,
}: {
  status: 'empty' | 'ready' | 'stale' | 'partial-error';
  data: DashboardData;
  activeUpgrade: string | null;
  onUpgrade: (packageName: string, target: string) => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
  remediationByPackage: ReadonlyMap<string, TransitiveRemediationUiState>;
  onAnalyzeRemediation: (packageName: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  selectedFilter: SummaryFilterId;
  onSelectFilter: (filter: SummaryFilterId) => void;
  dependencyType: DependencyTypeFilterValue;
  onDependencyTypeChange: (value: DependencyTypeFilterValue) => void;
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
  cleanupBusy: boolean;
  cleanupAnalysis: { analyzedAt: string; cacheExpiresAt: string } | null;
  now: number;
  onAnalyzeCleanup: () => void;
  onOpenDetails: (packageName: string) => void;
  onWhereUsed: (packageName: string) => void;
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
  const upgradesDisabled = status === 'stale';

  const metrics = useMemo(() => summaryMetrics(data.rows), [data.rows]);

  const query = search.trim().toLowerCase();
  const filteredRows = useMemo(() => {
    const matchesCard = summaryFilterPredicate(selectedFilter);
    const matchesType = dependencyTypeFilterPredicate(dependencyType);
    const rows = data.rows.filter(
      (row) => matchesCard(row) && matchesType(row) && (query === '' || row.name.toLowerCase().includes(query))
    );
    return sortRows(rows, sortState, selectedFilter);
  }, [data.rows, selectedFilter, dependencyType, query, sortState]);

  const pageResult = useMemo(
    () => paginate(filteredRows, page, pageSize),
    [filteredRows, page, pageSize]
  );

  const hygieneFindings = useMemo(
    () => [...data.hygieneFindings, ...cleanupFindings],
    [data.hygieneFindings, cleanupFindings]
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
            visibleCount={filteredRows.length}
            totalCount={data.rows.length}
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
                  onClick={onAnalyzeCleanup}
                  disabled={actionsDisabled || cleanupBusy}
                  title="Scan the workspace for likely-unused direct dependencies"
                >
                  <IconBroom />
                  {cleanupBusy ? 'Analyzing…' : cleanupAnalysis === null ? 'Analyze cleanup' : 'Re-analyze'}
                </button>
              </div>
            }
          >
            <DependencyTypeFilter value={dependencyType} onChange={onDependencyTypeChange} />
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
                title={filterEmptyStateTitle(selectedFilter, dependencyType)}
                detail="Nothing matches this filter."
              />
            )
          ) : (
            <>
              <PackageTable
                rows={pageResult.pageRows}
                activeUpgrade={activeUpgrade}
                onUpgrade={onUpgrade}
                onOpenAdvisory={onOpenAdvisory}
                remediationByPackage={remediationByPackage}
                onAnalyzeRemediation={onAnalyzeRemediation}
                upgradesDisabled={upgradesDisabled}
                sortState={sortState}
                onSort={onSort}
                hygieneFindings={hygieneFindings}
                onOpenDetails={onOpenDetails}
                onWhereUsed={onWhereUsed}
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
      </p>
    </>
  );
}
