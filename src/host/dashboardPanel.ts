/**
 * The webview panel: lifecycle, CSP, and the message boundary.
 *
 * One panel at a time, following the create-or-reveal pattern from VS Code's
 * own webview sample. Scan decisions live in DashboardController and upgrade
 * lifecycle decisions live in UpgradeAssistantCoordinator; this file owns
 * the parts that need a real `vscode.WebviewPanel` plus watcher/reload wiring.
 *
 * SECURITY — the four rules enforced here:
 *   1. A fresh cryptographically-random nonce per HTML load, and no
 *      `unsafe-inline`/`unsafe-eval` anywhere in the policy. `default-src
 *      'none'` means anything not explicitly allowed below is blocked,
 *      including every network destination — the webview cannot phone home.
 *   2. `localResourceRoots` is exactly `dist/`, so nothing else in the
 *      extension directory or the user's workspace is loadable.
 *   3. No inline <script>. The only script is the nonce-tagged bundle.
 *   4. Every inbound message goes through isWebviewToHostMessage before it is
 *      acted on. A webview is a separate security context; a message arriving
 *      on this channel is not proof that we sent it.
 *
 * S6 adds a fifth rule of the same shape: the webview can only ever *ask* to
 * open the project picker (`change-project`, no payload) — it never names or
 * chooses a project. Discovery, labelling, and selection are entirely
 * host-owned (projectResolution.ts / projectPicker.ts); nothing the webview
 * sends can select a candidate outside what this panel itself discovered.
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { NodeAuditRunner } from '../core/audit/npmAudit.js';
import { realTimerScheduler, BackgroundRefreshTimer } from '../core/cache/backgroundRefreshTimer.js';
import type { FileChangeKind } from '../core/cache/fileChangeCoordinator.js';
import { FileChangeCoordinator } from '../core/cache/fileChangeCoordinator.js';
import { DEFAULT_TTL_MINUTES, effectiveTtlMinutes } from '../core/cache/freshness.js';
import { deriveProjectCacheKey } from '../core/cache/keys.js';
import { PersistentEtagStore } from '../core/cache/persistentEtagStore.js';
import { PersistentProjectCacheStore } from '../core/cache/projectCacheStore.js';
import { isSameProjectReload, lockfileWatchDirs, projectCandidateLabel } from '../core/workspace/scan.js';
import { NodeHttpClient } from '../core/registry/http.js';
import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { createPerformanceSession } from '../core/performance/measurement.js';
import { DashboardController } from './dashboardController.js';
import type { MessageSink } from './dashboardController.js';
import type { BuildInfo } from './dashboardData.js';
import type { ReloadSource } from './fileChangeReload.js';
import { reloadControllerFromDisk } from './fileChangeReload.js';
import { pickProject } from './projectPicker.js';
import type { DiscoveredProject, ResolvedProject } from './projectResolution.js';
import { discoverProjects, loadProject } from './projectResolution.js';
import { UpgradeAssistantCoordinator } from './upgradeAssistantCoordinator.js';
import { UsageAnalysisCoordinator } from './usage/usageCoordinator.js';
import type { ProtocolError, SelectedProjectInfo } from './webviewProtocol.js';
import type { WebviewToHostMessage } from './webviewProtocol.js';
import { isWebviewToHostMessage } from './webviewProtocol.js';

const VIEW_TYPE = 'dependencyDashboard';
const TITLE = 'Dependency Dashboard';
/** Spec's fixed background-refresh cadence — independent of the configurable `cacheTtlMinutes`, which only decides whether a given tick actually needs to do anything (see DashboardController.needsBackgroundRefresh). */
const BACKGROUND_REFRESH_INTERVAL_MS = 30 * 60_000;
/** Coalesces a burst of filesystem events (e.g. an editor's atomic save, which can fire delete+create in quick succession) into a single invalidation + rescan. */
const FILE_EVENT_DEBOUNCE_MS = 300;

/**
 * `cacheBust` is appended as a query string on both asset URLs so that
 * re-assigning `panel.webview.html` (the dev-mode auto-reload watcher below)
 * is guaranteed to fetch the just-rebuilt `webview.js`/`webview.css` bytes
 * rather than whatever Chromium's resource cache already has for that exact
 * URL — the nonce changes the inline `<script>` tag itself, but does nothing
 * about the cached response behind an unchanged `src`. Callers pass
 * `Date.now()`; this is purely a cache key; the real timestamp shown in the
 * UI is `buildInfo.builtAt` (`__BUILD_TIME__`, fixed for this extension host
 * process's whole lifetime — see that field's own doc).
 */
function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri, performanceEnabled: boolean, cacheBust: number): string {
  const nonce = randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleUri.toString()}?v=${cacheBust}" />
    <title>${TITLE}</title>
  </head>
  <body data-performance-debug="${performanceEnabled ? 'true' : 'false'}">
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}?v=${cacheBust}"></script>
  </body>
</html>`;
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

function toProjectInfo(candidate: DiscoveredProject): SelectedProjectInfo {
  return { label: projectCandidateLabel(candidate), manifestPath: candidate.manifestPath };
}

export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly sink: MessageSink;
  private controller: DashboardController | undefined;
  /** In-flight or completed project resolution, dropped on failure so a retry re-runs it. */
  private pending: Promise<DashboardController | undefined> | undefined;
  /** Owns preflight, confirmation, transaction, verification, and completion. */
  private readonly upgradeCoordinator: UpgradeAssistantCoordinator;
  /** Owns on-demand "Where is this used?" / "Analyze cleanup" usage analysis — see src/host/usage/usageCoordinator.ts. */
  private readonly usageCoordinator: UsageAnalysisCoordinator;
  /**
   * Shared across every controller this panel ever builds (initial open and
   * every reload) so ETag caching survives a reload — only the project
   * snapshot (root/manifestText/lockfileText/lockfilePath/registry/cacheKey)
   * is per-controller. `etagStore`/`projectCacheStore` are S7's persisted
   * stores — globalState/workspaceState respectively (see the file header on
   * the split) — constructed once per panel and disposed once in
   * onDidDispose, exactly like `httpClient`/`auditRunner` already were.
   */
  private readonly httpClient = new NodeHttpClient();
  private readonly etagStore: PersistentEtagStore;
  private readonly projectCacheStore: PersistentProjectCacheStore;
  private readonly auditRunner = new NodeAuditRunner();
  private readonly backgroundTimer: BackgroundRefreshTimer;
  /** Computed once at construction — the same value for every controller/reload this panel session ever builds. See DashboardData's own doc for why this exists (confirming a dev's rebuild actually loaded). */
  private readonly buildInfo: BuildInfo;
  /** Set once onDidDispose fires, so an async continuation mid-flight can bail before posting into a gone webview. */
  private disposed = false;
  /** The candidate a plain refresh (or a post-upgrade reload) re-reads — set on selection, untouched by refresh itself. */
  private selectedProject: DiscoveredProject | undefined;
  /**
   * How many candidates the most recent discovery found — drives
   * `canChangeProject`. Only re-discovery (initial load, or an explicit
   * "change project") updates this; a plain refresh reuses it, since
   * refresh's job is re-reading the *selected* project, not re-scanning the
   * whole workspace for new ones.
   */
  private candidateCount = 0;
  /** Incremented at the start of every `reloadAndScan` call — see that method's doc comment for the race it closes. */
  private reloadGeneration = 0;

  /** S7 — file watchers for the currently selected project's manifest/lockfile topology, recreated on every project switch. */
  private manifestWatcher: vscode.FileSystemWatcher | undefined;
  /** One watcher per ancestor directory (see setupFileWatchers) — never a single glob built by interpolating directory names, which real directory content could break out of. */
  private lockfileWatchers: vscode.FileSystemWatcher[] = [];
  private configurationWatchers: vscode.FileSystemWatcher[] = [];
  /** The absolute lockfile path the current persisted entry was built against — needed to purge every npm-workspace sibling sharing it once a reload has just replaced it. Null means the selected project has no lockfile. */
  private selectedLockfilePath: string | null = null;
  private invalidationTimer: NodeJS.Timeout | undefined;
  /**
   * Dev-mode-only ("F5" Extension Development Host) auto-reload: watches this
   * extension's own `dist/webview.{js,css}` and re-assigns `panel.webview.html`
   * shortly after `npm run watch` finishes a rebuild, so the panel picks up
   * UI changes without a manual "close tab and reopen" or a full window
   * reload. Never created for a real installed extension — `extensionMode`
   * is `Development` only under `--extensionDevelopmentPath`. This is a full
   * webview reload, not state-preserving React Fast Refresh: the in-progress
   * scan/manage-modal state resets, same as any other panel re-creation.
   */
  private readonly devWebviewWatcher: vscode.FileSystemWatcher | undefined;
  private devReloadTimer: NodeJS.Timeout | undefined;
  /** Owns coalescing, upgrade-busy deferral, and serialized generation-checked reloads for watcher events — see fileChangeCoordinator.ts. This panel only owns the actual watcher subscriptions and debounce timing. */
  private readonly fileChangeCoordinator = new FileChangeCoordinator({
    isBusy: () => this.upgradeCoordinator.isBusy(),
    currentGeneration: () => this.reloadGeneration,
    reload: (kinds, generation) => this.reloadAfterFileChange(kinds, generation),
  });
  private readonly reloadSource: ReloadSource<DiscoveredProject> = {
    loadProject: (candidate) => this.loadProjectMeasured(candidate, 'Dependency Dashboard project reload'),
    toProjectInfo,
    cacheKeyFor: (candidate, registry, packageManager) =>
      deriveProjectCacheKey(candidate.id, registry, packageManager ?? 'npm'),
  };

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.buildInfo = {
      extensionVersion: String(context.extension.packageJSON['version'] ?? 'unknown'),
      builtAt: __BUILD_TIME__,
    };
    this.sink = {
      postMessage: (message) => {
        if (this.performanceEnabled()) {
          const performance = createPerformanceSession('Dependency Dashboard webview message', true);
          const endSerialization = performance.start('webview message serialization');
          const serialized = JSON.stringify(message);
          endSerialization({ status: message.status, bytes: Buffer.byteLength(serialized) });
          performance.finish({ status: message.status });
        }
        void this.panel.webview.postMessage(message);
      },
    };
    this.etagStore = new PersistentEtagStore(context.globalState);
    this.projectCacheStore = new PersistentProjectCacheStore(context.workspaceState);
    this.upgradeCoordinator = new UpgradeAssistantCoordinator({
      sink: this.sink,
      httpClient: this.httpClient,
      etagStore: this.etagStore,
      ensureController: () => this.ensureController(),
      getSelectedProject: () => this.selectedProject,
      isDisposed: () => this.disposed,
      reloadFinalState: () => this.reloadAndScan(undefined, { forceUsageRecheck: true }),
      flushDeferredChanges: () => this.fileChangeCoordinator.flushDeferred(),
      onMutationLockReleased: () => {
        void this.usageCoordinator.runPendingBackgroundRefresh();
      },
      performanceEnabled: this.performanceEnabled,
    });
    this.usageCoordinator = new UsageAnalysisCoordinator({
      sink: this.sink,
      ensureController: () => this.ensureController(),
      getSelectedProject: () => this.selectedProject,
      isDisposed: () => this.disposed,
      isUpgradeBusy: () => this.upgradeCoordinator.isBusy(),
      performanceEnabled: this.performanceEnabled,
    });
    this.backgroundTimer = new BackgroundRefreshTimer(realTimerScheduler, BACKGROUND_REFRESH_INTERVAL_MS, () => {
      this.onBackgroundTick();
    });

    this.panel.webview.html = buildHtml(this.panel.webview, context.extensionUri, this.performanceEnabled(), Date.now());

    this.devWebviewWatcher =
      context.extensionMode === vscode.ExtensionMode.Development
        ? vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.joinPath(context.extensionUri, 'dist'), 'webview.{js,css}')
          )
        : undefined;
    if (this.devWebviewWatcher !== undefined) {
      const scheduleReload = (): void => {
        if (this.devReloadTimer !== undefined) clearTimeout(this.devReloadTimer);
        this.devReloadTimer = setTimeout(() => {
          this.devReloadTimer = undefined;
          if (this.disposed) return;
          this.panel.webview.html = buildHtml(this.panel.webview, context.extensionUri, this.performanceEnabled(), Date.now());
        }, FILE_EVENT_DEBOUNCE_MS);
      };
      this.devWebviewWatcher.onDidChange(scheduleReload);
      this.devWebviewWatcher.onDidCreate(scheduleReload);
    }

    this.panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        if (!isWebviewToHostMessage(raw)) return; // Rule 4.
        void this.handle(raw);
      },
      null,
      context.subscriptions
    );

    this.panel.onDidDispose(
      () => {
        // An in-flight pipeline run must not outlive the panel, nor try to
        // post into a webview that no longer exists.
        this.disposed = true;
        this.controller?.dispose();
        this.controller = undefined;
        this.pending = undefined;
        // A mutating task is deliberately allowed to reach a stable boundary
        // even after its panel closes. The transaction's async owner keeps the
        // session alive until install/verification/rollback completes.
        this.upgradeCoordinator.disposeWhenIdle();
        this.usageCoordinator.dispose();
        this.disposeWatchers();
        this.fileChangeCoordinator.dispose();
        this.backgroundTimer.dispose();
        this.etagStore.dispose();
        this.projectCacheStore.dispose();
        this.devWebviewWatcher?.dispose();
        if (this.devReloadTimer !== undefined) clearTimeout(this.devReloadTimer);
        DashboardPanel.current = undefined;
      },
      null,
      context.subscriptions
    );

    // Only while the panel is open — disposed above the moment it closes.
    this.backgroundTimer.start();
  }

  static createOrShow(context: vscode.ExtensionContext): void {
    const existing = DashboardPanel.current;
    if (existing !== undefined) {
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')], // Rule 2.
      retainContextWhenHidden: true,
    });

    DashboardPanel.current = new DashboardPanel(panel, context);
  }

  /** The refresh command only refreshes what is already open; it never opens a panel. */
  static async refresh(): Promise<void> {
    await DashboardPanel.current?.handle({ type: 'refresh' });
  }

  private async handle(message: WebviewToHostMessage): Promise<void> {
    if (message.type === 'load-upgrade-targets') {
      await this.upgradeCoordinator.handleLoadUpgradeTargets(message);
      return;
    }
    if (message.type === 'upgrade') {
      await this.upgradeCoordinator.handleAnalyzeUpgrade(message);
      return;
    }
    if (message.type === 'bulk-upgrade') {
      await this.upgradeCoordinator.handleAnalyzeBulkUpgrade(message);
      return;
    }
    if (message.type === 'confirm-upgrade') {
      await this.upgradeCoordinator.handleConfirmUpgrade(message);
      return;
    }
    if (message.type === 'use-smart-plan') {
      await this.upgradeCoordinator.handleUseSmartPlan(message);
      return;
    }
    if (message.type === 'cancel-upgrade') {
      this.upgradeCoordinator.handleCancelUpgrade(message);
      return;
    }
    if (message.type === 'bulk-remove') {
      await this.upgradeCoordinator.handleAnalyzeBulkRemove(message);
      return;
    }
    if (message.type === 'confirm-remove') {
      await this.upgradeCoordinator.handleConfirmRemove(message);
      return;
    }
    if (message.type === 'cancel-remove') {
      this.upgradeCoordinator.handleCancelRemove(message);
      return;
    }
    if (message.type === 'configure-verification') {
      this.upgradeCoordinator.handleConfigureVerification();
      return;
    }
    if (message.type === 'analyze-remediation') {
      // Read-only, but a concurrent disk read could still race an in-flight
      // upgrade's file writes — same rule refresh/change-project already
      // follow below, not a new one invented for this message.
      if (this.upgradeCoordinator.isBusy()) {
        this.sink.postMessage({
          status: 'remediation-error',
          package: message.package,
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
        });
        return;
      }
      await this.upgradeCoordinator.handleAnalyzeRemediation(message);
      return;
    }
    if (message.type === 'analyze-remediations') {
      if (this.upgradeCoordinator.isBusy()) {
        this.sink.postMessage({
          status: 'remediation-batch-error',
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
        });
        return;
      }
      await this.upgradeCoordinator.handleAnalyzeRemediations(message);
      return;
    }
    if (message.type === 'cancel-remediation-analysis') {
      this.upgradeCoordinator.handleCancelRemediation();
      return;
    }
    if (message.type === 'where-used') {
      // Same rule as analyze-remediation: read-only, but a concurrent read
      // could still race an in-flight upgrade's file writes.
      if (this.upgradeCoordinator.isBusy()) {
        this.sink.postMessage({
          status: 'usage-error',
          package: message.package,
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
        });
        return;
      }
      await this.usageCoordinator.handleWhereUsed(message);
      return;
    }
    if (message.type === 'reanalyze-usage') {
      if (this.upgradeCoordinator.isBusy()) {
        this.sink.postMessage({
          status: 'usage-error',
          package: message.package,
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
        });
        return;
      }
      await this.usageCoordinator.handleWhereUsed(message, true);
      return;
    }
    if (message.type === 'analyze-cleanup') {
      if (this.upgradeCoordinator.isBusy()) {
        this.sink.postMessage({
          status: 'cleanup-error',
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
        });
        return;
      }
      await this.usageCoordinator.handleAnalyzeCleanup();
      return;
    }
    if (message.type === 'cancel-usage-analysis') {
      this.usageCoordinator.handleCancel();
      return;
    }
    if (message.type === 'analyze-removal-impact') {
      // Same rule as where-used/analyze-cleanup: read-only, but a concurrent
      // read could still race an in-flight upgrade's file writes.
      if (this.upgradeCoordinator.isBusy()) {
        this.sink.postMessage({
          status: 'removal-impact-error',
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
        });
        return;
      }
      await this.usageCoordinator.handleAnalyzeRemovalImpact(message);
      return;
    }
    if (message.type === 'open-usage-reference') {
      this.usageCoordinator.handleOpenReference(message);
      return;
    }
    if (message.type === 'change-project') {
      // Same rule as refresh below: a project switch mid-upgrade would race
      // a scan (and a controller replacement) against a package.json/
      // lockfile an upgrade task is still writing to.
      if (this.upgradeCoordinator.isBusy() || this.upgradeCoordinator.isRemediationBusy()) return;
      await this.changeProject();
      return;
    }
    if (message.type === 'refresh') {
      // Ignored, not queued, while an upgrade holds the panel's lock — this
      // covers both the webview's own Refresh button (also disabled client-
      // side while an upgrade is active, see App.tsx) and the Command
      // Palette's "Dependency Dashboard: Refresh", which bypasses the
      // webview entirely and would otherwise race a scan against a
      // package.json/lockfile an upgrade task is still writing to.
      if (this.upgradeCoordinator.isBusy() || this.upgradeCoordinator.isRemediationBusy()) return;
      // Manual refresh always re-reads the *currently selected* project's
      // package.json/lockfile from disk — see reloadAndScan — so externally
      // changed dependencies show up, without silently reverting to
      // whichever candidate discovery happened to find first.
      // `forceUsageRecheck: true` — an explicit Refresh click guarantees one
      // fresh usage/cleanup background pass the same way a first-ever open
      // does, bypassing the fingerprint gate other reload paths respect. See
      // UsageAnalysisCoordinator.requestBackgroundUsageRefresh's own doc for
      // why forcing is safe here.
      await this.reloadAndScan(this.selectedProject, { forceUsageRecheck: true });
      return;
    }
    if (message.type === 'open-advisory') {
      this.openAdvisory(message);
      return;
    }
    const controller = await this.ensureController();
    if (controller === undefined) return; // ensureController already posted the failure.
    await controller.handleReady(this.sink);
    void this.usageCoordinator.requestBackgroundUsageRefresh();
  }

  /**
   * The webview names an advisory, never a URL — see
   * webviewProtocol.ts's own doc on `open-advisory` and
   * DashboardController.resolveAdvisoryUrl for the actual trust boundary.
   * A miss (unknown package/advisory, or a URL that failed the `https:`
   * check) is silently a no-op: there is nothing unsafe about it, so there
   * is nothing worth surfacing as an error either.
   */
  private openAdvisory(message: { package: string; advisoryId: string | number; path: string[] }): void {
    const url = this.controller?.resolveAdvisoryUrl(message);
    if (url === null || url === undefined) return;
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Re-discovers every candidate and shows the picker, regardless of how
   * many candidates existed the last time discovery ran — so a project
   * added or removed since then is reflected, same as manual refresh
   * re-reads the selected project's files fresh rather than trusting a
   * cached copy. Cancelling leaves `this.selectedProject` untouched: the
   * currently selected project stays selected, nothing is posted.
   */
  private async changeProject(): Promise<void> {
    const performance = createPerformanceSession('Dependency Dashboard project discovery', this.performanceEnabled());
    let candidates: DiscoveredProject[];
    try {
      candidates = await discoverProjects(performance);
    } catch (cause) {
      performance.finish({ failed: true });
      if (this.disposed) return;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return;
    }
    performance.finish({ candidates: candidates.length });
    if (this.disposed) return;
    this.candidateCount = candidates.length;

    if (candidates.length === 0) {
      // Extremely unlikely (a project is already selected), but handled the
      // same way a fresh zero-candidate discovery always is.
      this.sink.postMessage({
        status: 'fatal-error',
        error: { code: 'NoProjectFoundError', message: 'No package.json was found in this workspace.' },
      });
      return;
    }

    // Same rule as the initial selection: exactly one candidate needs no
    // prompt. Only reachable if every other candidate disappeared between
    // "Change project" becoming visible (canChangeProject was true then)
    // and this re-discovery — re-select the sole remaining one directly.
    if (candidates.length === 1) {
      // An upgrade could have started while discoverProjects() was pending
      // (it isn't itself lock-holding) — re-check right before applying,
      // the same "closest to the effect" placement the multi-candidate
      // branch below already uses for its own picker.
      if (this.upgradeCoordinator.isBusy()) return;
      await this.reloadAndScan(candidates[0]);
      return;
    }

    const picked = await pickProject(candidates);
    if (this.disposed) return;
    if (picked === undefined) return; // cancelled — current selection is preserved, nothing to do
    // An upgrade could have started while the picker was open (it isn't
    // itself lock-holding); re-check right before applying the pick, the
    // same "closest to the effect" placement the upgrade flow's own
    // Workspace Trust re-check uses.
    if (this.upgradeCoordinator.isBusy()) return;

    await this.reloadAndScan(picked);
  }

  /**
   * Re-reads a candidate's package.json/the lockfile from disk and
   * (re)builds the controller's project snapshot before scanning — used by
   * manual refresh, a successful upgrade, and picking a new project via
   * `changeProject`, so none of them ever scan against stale, in-memory
   * manifest/lockfile text. The fetch machinery (httpClient/etagStore/
   * auditRunner) is shared across every reload via panel-level fields, so a
   * reload does not lose ETag caching.
   *
   * Defaults to `this.selectedProject` — refresh and the post-upgrade
   * reload both call this with no argument, so they always re-read the
   * *currently selected* project, never silently reverting to whichever
   * candidate discovery happened to find first.
   *
   * `reloadGeneration` guards against a subtler race than the upgrade lock
   * covers: `onDidReceiveMessage` dispatches each message via `void
   * this.handle(raw)`, unawaited, so nothing stops two `reloadAndScan` calls
   * from being in flight together (e.g. a slow Refresh on project A racing a
   * fast "change project" pick of B). Without a generation check, whichever
   * call's `loadProject` (disk I/O) happens to resolve *last* wins and
   * overwrites `this.selectedProject` — which could silently revert an
   * explicit, later project switch back to an earlier, slower request. This
   * mirrors the identical "a newer run supersedes an older one outright"
   * rule `DashboardController.run()` already applies one layer down for
   * racing scans of the *same* project; this is the same rule for racing
   * calls that can now target *different* projects.
   *
   * A watcher event can also arrive *during* this method's own `loadProject`
   * await — queued in `fileChangeCoordinator` and scheduled behind its own
   * debounce timer. `setupFileWatchers` below tears down and rebuilds the
   * watchers once this reload has its own fresh data, which cancels that
   * timer — and since this method never runs through the coordinator's own
   * `runAndDrain` self-draining loop (that only fires for watcher-triggered
   * reloads), nothing else would ever flush the queued event. Handled in two
   * places, not one, because *which* project a pending event is about
   * changes partway through this method, right at `setupFileWatchers`:
   *   - Immediately after `setupFileWatchers` installs the new watchers (for
   *     a *switch*), before the next `await`: anything pending right then can
   *     only be a leftover from the *old* watchers (nothing has had a chance
   *     to fire on the brand new ones yet, since no await has happened in
   *     between) — discarded outright, since it was never about the newly
   *     selected project. Skipped for a same-project reload: there is no
   *     "old" vs "new" selection to disambiguate, so nothing here would ever
   *     be anything but relevant.
   *   - After the forced scan completes, unconditionally: by then
   *     any old-project leftover has already been cleared (the step above),
   *     so whatever is pending is guaranteed to be a *genuine* event from the
   *     currently active watchers — for the project this method just
   *     finished reloading, switch or not — always drained, never discarded.
   *
   * One more supersession point sits right before that final flush: this
   * call's own `generation` is re-checked against `this.reloadGeneration`
   * one last time, after the network scan has had the whole
   * length of that scan to be overtaken by an entirely newer, faster
   * reloadAndScan call. Superseded here, this call must flush nothing at
   * all — the newer call already owns (or is about to own) that job for
   * whatever project is now actually selected.
   */
  private async reloadAndScan(
    candidate: DiscoveredProject | undefined = this.selectedProject,
    options: { forceUsageRecheck?: boolean } = {}
  ): Promise<void> {
    if (candidate === undefined) return; // nothing selected yet; only reachable before init ever completes

    const sameProjectReload = isSameProjectReload(this.selectedProject?.id, candidate.id);

    // Captured before the disk read even starts, not after — the moment this
    // reload begins, whatever the existing controller currently considers
    // eligible must stop being trusted for Upgrade until a matching
    // revalidation actually completes, and the panel announces that
    // immediately too (not only once a scan actually starts), so Upgrade
    // buttons visibly disable for the whole debounce-plus-disk-read window,
    // not just the network round trip. `revalidation` stays undefined when
    // there's no existing controller yet (unreachable in practice — see the
    // method doc — this mirrors the same defensive style as
    // `this.controller?.dispose()` elsewhere); `generationAtReadStart` is
    // threaded through to `updateProjectSnapshot` below so it can tell
    // whether anything *else* called `beginRevalidation()` while this
    // specific disk read was in flight — see that method's own doc for why
    // a project reload must never silently claim a later, unrelated event's
    // generation as its own.
    const controllerBeforeReload = this.controller;
    const revalidation =
      controllerBeforeReload === undefined
        ? undefined
        : { controller: controllerBeforeReload, generationAtReadStart: controllerBeforeReload.beginRevalidation() };
    revalidation?.controller.announceRevalidating(this.sink);

    this.reloadGeneration += 1;
    const generation = this.reloadGeneration;
    // This reload is authoritative and about to fully replace the current
    // snapshot itself — anything a watcher had queued (pending or already
    // deferred behind an upgrade) *before* this reload began is superseded
    // outright, never applied on top of what this call is about to write.
    // (A burst that arrives *during* this reload's own disk read is handled
    // separately, below — see the method doc.)
    this.fileChangeCoordinator.discardPending();

    let project: ResolvedProject;
    try {
      project = await this.loadProjectMeasured(candidate, 'Dependency Dashboard project reload');
    } catch (cause) {
      if (this.disposed || generation !== this.reloadGeneration) return;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return;
    }
    if (this.disposed || generation !== this.reloadGeneration) return;
    this.selectedProject = candidate;

    const projectInfo = toProjectInfo(candidate);
    const canChangeProject = this.candidateCount > 1;
    const cacheKey = this.cacheKeyFor(candidate, project);
    this.setupFileWatchers(candidate, path.join(project.root, 'package.json'));
    this.selectedLockfilePath = project.lockfilePath;

    if (!sameProjectReload) {
      // The watchers installed just above are now live for `candidate` — but
      // anything pending *right now*, before any further await, can only be
      // a leftover from the *old* (pre-switch) watchers: nothing has had a
      // chance to fire on the new ones yet. Discard it here, synchronously,
      // rather than at the end of this method — waiting would let it also
      // catch a *genuine* new-project event that the new watchers queue
      // while the scan below is in flight, discarding a legitimate
      // reload instead of applying it.
      this.fileChangeCoordinator.discardPending();
    }

    let controller: DashboardController;
    if (revalidation === undefined) {
      controller = this.buildController(project, projectInfo, canChangeProject, cacheKey);
      this.controller = controller;
    } else {
      controller = revalidation.controller;
      controller.updateProjectSnapshot(
        { ...project, projectInfo, canChangeProject, cacheKey },
        revalidation.generationAtReadStart
      );
    }
    // A same-project manual/post-action refresh already has useful rows on
    // screen. Keep them visible (marked stale by the revalidation announcement
    // above) while the forced scan runs. A genuine project switch must still
    // clear the old project's rows so they are never presented under the new
    // project identity.
    if (sameProjectReload) {
      await controller.refreshInBackground(this.sink);
    } else {
      await controller.handleRefresh(this.sink);
    }

    // The network scan can take long enough for an
    // entirely separate, newer reloadAndScan call (a faster project switch,
    // or another refresh) to start AND finish while this one was still
    // awaiting it — that newer call already ran (or is about to run) its
    // own end-of-method flush, for its own, now-current project. This one is
    // superseded outright: touching the coordinator here at all would either
    // duplicate that newer flush or, worse, act on pending state that
    // belongs to whatever project is now actually selected, not the one this
    // call was for. Bail without flushing anything.
    if (this.disposed || generation !== this.reloadGeneration) return;

    // Queued, not awaited: dependency data is already published to the
    // webview above, so usage/cleanup analysis must never block on it — it
    // runs quietly in the background, or is deferred if something (another
    // usage analysis, or the mutation lock this call may itself still be
    // running under, e.g. an upgrade's `reloadFinalState`) is still busy.
    // See UsageAnalysisCoordinator.requestBackgroundUsageRefresh's own doc.
    void this.usageCoordinator.requestBackgroundUsageRefresh({ force: options.forceUsageRecheck === true });

    // Whatever is pending now is guaranteed to be from the *currently
    // active* watchers — any old-project leftover was already cleared above
    // for a switch, and a same-project reload never had an old/new
    // distinction to begin with. Always drain, never discard: a no-op if
    // nothing arrived, otherwise a fresh, mandatory second disk read through
    // the normal `reloadAfterFileChange` path.
    await this.fileChangeCoordinator.flush();
  }

  /**
   * Project resolution is async and can fail (no folder open, no package.json,
   * or the user cancels the initial picker). That is reported as fatal-error
   * over the same channel rather than thrown during construction, so the
   * panel still opens and shows a retryable state — clicking Retry re-sends
   * `ready`, which runs this whole selection flow again from scratch.
   */
  private async ensureController(): Promise<DashboardController | undefined> {
    if (this.controller !== undefined) return this.controller;
    this.pending ??= this.createController();
    const controller = await this.pending;
    if (controller === undefined) this.pending = undefined;
    return controller;
  }

  private async createController(): Promise<DashboardController | undefined> {
    const performance = createPerformanceSession('Dependency Dashboard project load', this.performanceEnabled());
    try {
      const candidate = await this.selectInitialProject(performance);
      if (this.disposed || candidate === undefined) return undefined; // already posted (or torn down)

      this.selectedProject = candidate;
      const project = await loadProject(candidate, performance);
      if (this.disposed) return undefined;

      this.setupFileWatchers(candidate, path.join(project.root, 'package.json'));
      this.selectedLockfilePath = project.lockfilePath;
      this.controller = this.buildController(
        project,
        toProjectInfo(candidate),
        this.candidateCount > 1,
        this.cacheKeyFor(candidate, project)
      );
      return this.controller;
    } catch (cause) {
      if (this.disposed) return undefined;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return undefined;
    } finally {
      performance.finish();
    }
  }

  /**
   * Zero candidates: the existing "no project" error. One: silently
   * auto-selected, no prompt. Two or more: a QuickPick — cancelling it
   * leaves the panel in the same retryable fatal-error state as zero
   * candidates, distinguished only by the message, since there is no
   * "currently selected project" yet to fall back to on a first-ever open.
   */
  private async selectInitialProject(performance: PerformanceRecorder): Promise<DiscoveredProject | undefined> {
    const candidates = await discoverProjects(performance);
    if (this.disposed) return undefined;
    this.candidateCount = candidates.length;

    if (candidates.length === 0) {
      this.sink.postMessage({
        status: 'fatal-error',
        error: { code: 'NoProjectFoundError', message: 'No package.json was found in this workspace.' },
      });
      return undefined;
    }
    if (candidates.length === 1) return candidates[0];

    const picked = await pickProject(candidates);
    if (this.disposed) return undefined;
    if (picked === undefined) {
      this.sink.postMessage({
        status: 'fatal-error',
        error: { code: 'NoProjectSelectedError', message: 'Select a project to see its dependencies.' },
      });
      return undefined;
    }
    return picked;
  }

  private buildController(
    project: ResolvedProject,
    projectInfo: SelectedProjectInfo,
    canChangeProject: boolean,
    cacheKey: string
  ): DashboardController {
    return new DashboardController({
      root: project.root,
      manifestText: project.manifestText,
      lockfileText: project.lockfileText,
      lockfilePath: project.lockfilePath,
      packageManager: project.packageManager,
      importerId: project.importerId,
      lockfileName: project.lockfileName,
      registry: project.registry,
      resolvedRegistry: project.resolvedRegistry,
      httpClient: this.httpClient,
      etagStore: this.etagStore,
      auditRunner: this.auditRunner,
      projectInfo,
      canChangeProject,
      buildInfo: this.buildInfo,
      projectCacheStore: this.projectCacheStore,
      cacheKey,
      ttlMinutesProvider: this.ttlMinutesProvider,
      performanceEnabled: this.performanceEnabled,
      progressEnabled: true,
    });
  }

  private readonly performanceEnabled = (): boolean =>
    vscode.workspace
      .getConfiguration('dependencyDashboard')
      .get<boolean>('debug.performance', false);

  private async loadProjectMeasured(candidate: DiscoveredProject, operation: string): Promise<ResolvedProject> {
    const performance = createPerformanceSession(operation, this.performanceEnabled());
    try {
      return await loadProject(candidate, performance);
    } finally {
      performance.finish();
    }
  }

  /** S6 project identity (stable across scans) plus registry — see deriveProjectCacheKey for why both are needed to avoid cross-registry contamination within the same project. */
  private cacheKeyFor(candidate: DiscoveredProject, project: ResolvedProject): string {
    return deriveProjectCacheKey(candidate.id, project.registry, project.packageManager);
  }

  private readonly ttlMinutesProvider = (): number => {
    const raw = vscode.workspace
      .getConfiguration('dependencyDashboard')
      .get<number>('cacheTtlMinutes', DEFAULT_TTL_MINUTES);
    return effectiveTtlMinutes(raw);
  };

  private onBackgroundTick(): void {
    if (this.disposed || this.controller === undefined || this.upgradeCoordinator.isBusy()) return;
    if (!this.controller.needsBackgroundRefresh()) return;
    const controller = this.controller;
    void controller.refreshInBackground(this.sink).then(() => {
      if (this.disposed || this.controller !== controller) return;
      void this.usageCoordinator.requestBackgroundUsageRefresh();
    });
  }

  private disposeWatchers(): void {
    this.manifestWatcher?.dispose();
    this.manifestWatcher = undefined;
    for (const watcher of this.lockfileWatchers) watcher.dispose();
    this.lockfileWatchers = [];
    for (const watcher of this.configurationWatchers) watcher.dispose();
    this.configurationWatchers = [];
    if (this.invalidationTimer !== undefined) {
      clearTimeout(this.invalidationTimer);
      this.invalidationTimer = undefined;
    }
  }

  /**
   * Recreated on every project switch/reload so watchers always track the
   * currently selected project's actual files.
   *
   * One watcher per ancestor directory `lockfileWatchDirs` returns — every
   * directory `nearestLockfileDir` could ever resolve to for this project,
   * up to the workspace folder root — each watching only the fixed pattern
   * `{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml}`. Deliberately NOT a single
   * watcher built by interpolating every ancestor directory *name* into one
   * glob string: a directory name is real filesystem content the workspace
   * happens to contain, and a legal one containing `*`, `?`, `[`, `]`, `{`,
   * `}`, or `,` would be reinterpreted as glob syntax instead of matched
   * literally — see lockfileWatchDirs's own doc. Each directory here is used
   * only as `RelativePattern`'s literal URI base, exactly like the manifest
   * watcher below already does; only the hardcoded filenames, which this
   * codebase controls, ever appear in the glob pattern itself.
   */
  private setupFileWatchers(candidate: DiscoveredProject, manifestPath: string): void {
    this.disposeWatchers();

    this.manifestWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(manifestPath)), path.basename(manifestPath))
    );
    const onManifestEvent = (): void => this.onWatchedFileEvent('manifest');
    this.manifestWatcher.onDidChange(onManifestEvent);
    this.manifestWatcher.onDidCreate(onManifestEvent);
    this.manifestWatcher.onDidDelete(onManifestEvent);

    const onConfigurationEvent = (): void => this.onWatchedFileEvent('configuration');
    const npmrcWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(manifestPath)), '.npmrc')
    );
    npmrcWatcher.onDidChange(onConfigurationEvent);
    npmrcWatcher.onDidCreate(onConfigurationEvent);
    npmrcWatcher.onDidDelete(onConfigurationEvent);
    this.configurationWatchers.push(npmrcWatcher);

    const onLockfileEvent = (): void => this.onWatchedFileEvent('lockfile');
    for (const dir of lockfileWatchDirs(candidate.dir)) {
      const dirUri = vscode.Uri.joinPath(candidate.folder.uri, dir);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dirUri, '{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml}')
      );
      watcher.onDidChange(onLockfileEvent);
      watcher.onDidCreate(onLockfileEvent);
      watcher.onDidDelete(onLockfileEvent);
      this.lockfileWatchers.push(watcher);

      const workspaceConfigWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dirUri, 'pnpm-workspace.yaml')
      );
      workspaceConfigWatcher.onDidChange(onConfigurationEvent);
      workspaceConfigWatcher.onDidCreate(onConfigurationEvent);
      workspaceConfigWatcher.onDidDelete(onConfigurationEvent);
      this.configurationWatchers.push(workspaceConfigWatcher);
    }
  }

  /**
   * Host-owned debounce timing for the actual reload — but eligibility is
   * invalidated synchronously, right here, before any of that: a stale-or-
   * revalidating source must never authorize an Upgrade, and waiting for the
   * debounce would leave that gap open for the whole ~300ms window (or
   * longer, coalesced across a burst) between the file actually changing and
   * the reload it schedules actually running. `announceRevalidating` is
   * called synchronously in the same breath, not deferred until `run()`
   * eventually starts — this is the actual source of "revalidating" the
   * webview needs to see immediately: without it, the table would still show
   * `ready` (Upgrade buttons enabled) for the whole debounce window even
   * though the host has already revoked eligibility for it.
   */
  private onWatchedFileEvent(kind: FileChangeKind): void {
    if (this.disposed) return;
    this.controller?.beginRevalidation();
    this.controller?.announceRevalidating(this.sink);
    this.fileChangeCoordinator.notify(kind);
    if (this.invalidationTimer !== undefined) clearTimeout(this.invalidationTimer);
    this.invalidationTimer = setTimeout(() => {
      this.invalidationTimer = undefined;
      void this.fileChangeCoordinator.flush();
      // FileChangeCoordinator's own flush() above is deferred while an
      // upgrade analysis is open (isBusy() stays true for the whole review
      // lifetime) — checkOpenAnalysisFreshness is the one place that still
      // re-reads disk during that window, so an open Upgrade review panel
      // learns its analysis is structurally stale instead of only finding
      // out at confirm time. See its own doc for why this reuses the same
      // debounce rather than a new timer.
      void this.upgradeCoordinator.checkOpenAnalysisFreshness();
    }, FILE_EVENT_DEBOUNCE_MS);
  }

  /**
   * The actual reload behind a watcher-triggered invalidation — called by
   * `fileChangeCoordinator` only once it has decided this burst is current
   * and not superseded. Always re-reads the selected project from disk
   * (never rescans the controller's old construction-time strings), and
   * never posts `loading` — `reloadControllerFromDisk`'s `refreshInBackground`
   * call leaves whatever is already rendered on screen exactly as it is
   * until (and unless) the new scan actually completes.
   *
   * `generation` alone is not enough to decide "is this still about the
   * right project," even though `this.reloadGeneration` is what
   * `reloadAndScan` bumps on every switch: it bumps that counter *before*
   * awaiting its own `loadProject` call, but only assigns `this.selectedProject`
   * *after* that await resolves and its own generation check passes. In the
   * gap between those two points, `this.reloadGeneration` already reflects
   * the switch-in-progress while `this.selectedProject` still reads as the
   * *old* project — so a watcher event for the old project, coalesced via
   * `fileChangeCoordinator` with that same new generation number (read live
   * off `this.reloadGeneration` at notify/drain time), would pass a
   * generation-only check despite genuinely being about the wrong project.
   * `candidate` is captured once, below, at the very start of this method —
   * every place this method re-checks "is this still current" compares
   * against that same captured reference, not just the generation number.
   */
  private async reloadAfterFileChange(kinds: ReadonlySet<FileChangeKind>, generation: number): Promise<void> {
    const candidate = this.selectedProject;
    const controller = this.controller;
    if (candidate === undefined || controller === undefined) return;
    // Every drained coordinator iteration is its own revalidation attempt —
    // called again here even though `onWatchedFileEvent` already called it
    // for the raw event that led here, so that a burst drained automatically
    // after a held-open reload (see FileChangeCoordinator's self-draining)
    // is *also* covered, not just the first event of a burst. Captured (not
    // discarded) so `updateProjectSnapshot` (inside `reloadControllerFromDisk`
    // below) can tell whether anything *else* called `beginRevalidation()`
    // while this disk read was in flight — see that method's own doc.
    const generationAtReadStart = controller.beginRevalidation();
    controller.announceRevalidating(this.sink);
    const previousLockfilePath = this.selectedLockfilePath;

    // A shared npm-workspace root lockfile affects every member project, not
    // just this one — purge by the *previous* resolved path (what every
    // currently-persisted entry, including sibling members with no live
    // controller right now, was actually keyed against) BEFORE reloading,
    // not after. `reloadControllerFromDisk` below ends by persisting a fresh
    // entry for THIS project's own cacheKey under its (possibly identical —
    // a lockfile content edit with no topology change is the common case)
    // resolved lockfile path; purging afterward by that same path would
    // immediately delete the entry this very reload just wrote.
    if (kinds.has('lockfile') && previousLockfilePath !== null) {
      this.projectCacheStore.deleteByLockfilePath(previousLockfilePath);
    }

    let outcome;
    try {
      outcome = await reloadControllerFromDisk({
        candidate,
        controller,
        canChangeProject: this.candidateCount > 1,
        sink: this.sink,
        source: this.reloadSource,
        generationAtReadStart,
        isStillCurrent: () => !this.disposed && generation === this.reloadGeneration && candidate === this.selectedProject,
      });
    } catch {
      // Can't re-read the project right now (e.g. its manifest was deleted
      // mid-edit) — leave the last good render as-is; a later event (the
      // file reappearing, or the user picking a different project) recovers.
      return;
    }
    if (this.disposed || !outcome.applied) return;

    // `reloadControllerFromDisk`'s own `isStillCurrent` check above only runs
    // once, right after its `loadProject` disk read resolves — before the
    // network scan (`refreshInBackground`) it awaits next. A switch can
    // start and fully complete during that scan, same as the disk-read gap
    // this method's own doc explains: re-check both generation and candidate
    // identity again here, right before mutating panel-level state, so a
    // stale `outcome` from an old project can never install its watchers or
    // lockfile path over whatever project is now actually selected.
    if (generation !== this.reloadGeneration || candidate !== this.selectedProject) return;

    this.setupFileWatchers(candidate, path.join(outcome.project.root, 'package.json'));
    this.selectedLockfilePath = outcome.project.lockfilePath;
  }
}
