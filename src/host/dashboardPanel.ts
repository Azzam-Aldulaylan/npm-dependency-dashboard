/**
 * The webview panel: lifecycle, CSP, and the message boundary.
 *
 * One panel at a time, following the create-or-reveal pattern from VS Code's
 * own webview sample. All decision-making lives in DashboardController; this
 * file only owns the parts that need a real `vscode.WebviewPanel`.
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

import * as vscode from 'vscode';

import { NodeAuditRunner } from '../core/audit/npmAudit.js';
import { describeRejection } from '../core/upgrade/validate.js';
import { projectCandidateLabel } from '../core/workspace/scan.js';
import { NodeHttpClient } from '../core/registry/http.js';
import { MemoryEtagStore } from '../core/registry/versions.js';
import { DashboardController } from './dashboardController.js';
import type { MessageSink } from './dashboardController.js';
import { pickProject } from './projectPicker.js';
import type { DiscoveredProject, ResolvedProject } from './projectResolution.js';
import { discoverProjects, loadProject } from './projectResolution.js';
import { confirmUpgrade, UpgradeExecutionSession } from './upgradeRunner.js';
import type { ProtocolError, SelectedProjectInfo } from './webviewProtocol.js';
import type { WebviewToHostMessage } from './webviewProtocol.js';
import { isWebviewToHostMessage } from './webviewProtocol.js';

const VIEW_TYPE = 'dependencyDashboard';
const TITLE = 'Dependency Dashboard';

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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
    <link rel="stylesheet" href="${styleUri.toString()}" />
    <title>${TITLE}</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
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
  /** One session per panel: tracks the panel-wide upgrade lock and task listeners. */
  private readonly upgradeSession = new UpgradeExecutionSession();
  /**
   * Shared across every controller this panel ever builds (initial open and
   * every reload) so ETag caching survives a reload — only the project
   * snapshot (root/manifestText/lockfileText/registry) is per-controller.
   */
  private readonly httpClient = new NodeHttpClient();
  private readonly etagStore = new MemoryEtagStore();
  private readonly auditRunner = new NodeAuditRunner();
  /** Set once onDidDispose fires, so an async continuation mid-flight can bail before posting into a gone webview. */
  private disposed = false;
  /** The candidate a plain refresh (or a post-upgrade reload) re-reads — set on selection, untouched by refresh itself. */
  private selectedProject: DiscoveredProject | undefined;
  /**
   * How many candidates the most recent discovery found — drives
   * `canChangeProject`. Only re-discovery (initial load, or an explicit
   * "change project") updates this; a plain refresh reuses it, since
   * refresh's job is re-reading the *selected* project, not re-scanning the
   * whole workspace for new ones (no file watchers in S6).
   */
  private candidateCount = 0;
  /** Incremented at the start of every `reloadAndScan` call — see that method's doc comment for the race it closes. */
  private reloadGeneration = 0;

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.sink = {
      postMessage: (message) => {
        void this.panel.webview.postMessage(message);
      },
    };

    this.panel.webview.html = buildHtml(this.panel.webview, context.extensionUri);

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
        this.upgradeSession.dispose();
        DashboardPanel.current = undefined;
      },
      null,
      context.subscriptions
    );
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
    if (message.type === 'upgrade') {
      await this.handleUpgrade(message);
      return;
    }
    if (message.type === 'change-project') {
      // Same rule as refresh below: a project switch mid-upgrade would race
      // a scan (and a controller replacement) against a package.json/
      // lockfile an upgrade task is still writing to.
      if (this.upgradeSession.isBusy()) return;
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
      if (this.upgradeSession.isBusy()) return;
      // Manual refresh always re-reads the *currently selected* project's
      // package.json/lockfile from disk — see reloadAndScan — so externally
      // changed dependencies show up, without silently reverting to
      // whichever candidate discovery happened to find first.
      await this.reloadAndScan();
      return;
    }
    const controller = await this.ensureController();
    if (controller === undefined) return; // ensureController already posted the failure.
    await controller.handleReady(this.sink);
  }

  /**
   * The full Upgrade flow: host-side eligibility check against the
   * controller's last scan, modal confirmation, then UpgradeExecutionSession
   * (which re-checks Workspace Trust immediately before running the task).
   * Every early-exit path posts an `upgrade-error` so the webview can clear
   * its optimistic "running" state for this package — the existing table is
   * never touched by any of them.
   */
  private async handleUpgrade(message: { package: string; target: string }): Promise<void> {
    const controller = await this.ensureController();
    if (controller === undefined) return;

    const eligibility = controller.validateUpgradeRequest({
      package: message.package,
      target: message.target,
    });
    if (!eligibility.ok) {
      this.sink.postMessage({
        status: 'upgrade-error',
        package: message.package,
        error: describeRejection(eligibility.reason),
      });
      return;
    }

    // One upgrade at a time for the whole panel/project, not one per
    // package — reserved for the whole confirm-then-run flow, not just the
    // run, so a flood of forged requests (same package or a different one)
    // can't each reach (and stack) their own confirmation dialog, and two
    // npm installs can never race to write the same package.json/lockfile.
    if (!this.upgradeSession.reserve(eligibility.packageName)) {
      this.sink.postMessage({
        status: 'upgrade-error',
        package: eligibility.packageName,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
      });
      return;
    }

    try {
      const ignoreScripts = vscode.workspace
        .getConfiguration('dependencyDashboard')
        .get<boolean>('upgrade.ignoreScripts', true);

      const runParams = {
        packageName: eligibility.packageName,
        currentVersion: eligibility.currentVersion,
        target: eligibility.target,
        classification: eligibility.classification,
        cwd: controller.root,
        ignoreScripts,
      };

      const confirmed = await confirmUpgrade(runParams);
      if (this.disposed) return; // the confirmation dialog can outlive the panel
      if (!confirmed) {
        this.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: { code: 'CANCELLED', message: 'Upgrade cancelled.' },
        });
        return;
      }

      const outcome = await this.upgradeSession.run(runParams);
      if (this.disposed) return; // dispose() already settled this run; nothing left to post into
      if (outcome.ok) {
        // Exit 0: re-resolve the *same selected* project (package.json/the
        // lockfile the upgrade task itself just rewrote) and force a fresh
        // scan against that, not the pre-upgrade snapshot — see
        // reloadAndScan, which defaults to `this.selectedProject`.
        await this.reloadAndScan();
      } else {
        this.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: { code: outcome.code, message: outcome.message },
        });
      }
    } finally {
      this.upgradeSession.release(eligibility.packageName);
    }
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
    let candidates: DiscoveredProject[];
    try {
      candidates = await discoverProjects();
    } catch (cause) {
      if (this.disposed) return;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return;
    }
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
    if (this.upgradeSession.isBusy()) return;

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
   */
  private async reloadAndScan(candidate: DiscoveredProject | undefined = this.selectedProject): Promise<void> {
    if (candidate === undefined) return; // nothing selected yet; only reachable before init ever completes

    this.reloadGeneration += 1;
    const generation = this.reloadGeneration;

    let project: ResolvedProject;
    try {
      project = await loadProject(candidate);
    } catch (cause) {
      if (this.disposed || generation !== this.reloadGeneration) return;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return;
    }
    if (this.disposed || generation !== this.reloadGeneration) return;
    this.selectedProject = candidate;

    const projectInfo = toProjectInfo(candidate);
    const canChangeProject = this.candidateCount > 1;

    if (this.controller === undefined) {
      this.controller = this.buildController(project, projectInfo, canChangeProject);
    } else {
      this.controller.updateProjectSnapshot({ ...project, projectInfo, canChangeProject });
    }
    await this.controller.handleRefresh(this.sink);
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
    try {
      const candidate = await this.selectInitialProject();
      if (this.disposed || candidate === undefined) return undefined; // already posted (or torn down)

      this.selectedProject = candidate;
      const project = await loadProject(candidate);
      if (this.disposed) return undefined;

      this.controller = this.buildController(project, toProjectInfo(candidate), this.candidateCount > 1);
      return this.controller;
    } catch (cause) {
      if (this.disposed) return undefined;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return undefined;
    }
  }

  /**
   * Zero candidates: the existing "no project" error. One: silently
   * auto-selected, no prompt. Two or more: a QuickPick — cancelling it
   * leaves the panel in the same retryable fatal-error state as zero
   * candidates, distinguished only by the message, since there is no
   * "currently selected project" yet to fall back to on a first-ever open.
   */
  private async selectInitialProject(): Promise<DiscoveredProject | undefined> {
    const candidates = await discoverProjects();
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
    canChangeProject: boolean
  ): DashboardController {
    return new DashboardController({
      root: project.root,
      manifestText: project.manifestText,
      lockfileText: project.lockfileText,
      registry: project.registry,
      httpClient: this.httpClient,
      etagStore: this.etagStore,
      auditRunner: this.auditRunner,
      projectInfo,
      canChangeProject,
    });
  }
}
