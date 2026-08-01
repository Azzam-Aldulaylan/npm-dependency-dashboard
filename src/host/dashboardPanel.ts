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
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { NodeAuditRunner } from '../core/audit/npmAudit.js';
import { describeRejection } from '../core/upgrade/validate.js';
import { NodeHttpClient } from '../core/registry/http.js';
import { MemoryEtagStore } from '../core/registry/versions.js';
import { DashboardController } from './dashboardController.js';
import type { MessageSink } from './dashboardController.js';
import type { ResolvedProject } from './projectResolution.js';
import { resolveProject } from './projectResolution.js';
import { confirmUpgrade, UpgradeExecutionSession } from './upgradeRunner.js';
import type { ProtocolError } from './webviewProtocol.js';
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
    if (message.type === 'refresh') {
      // Ignored, not queued, while an upgrade holds the panel's lock — this
      // covers both the webview's own Refresh button (also disabled client-
      // side while an upgrade is active, see App.tsx) and the Command
      // Palette's "Dependency Dashboard: Refresh", which bypasses the
      // webview entirely and would otherwise race a scan against a
      // package.json/lockfile an upgrade task is still writing to.
      if (this.upgradeSession.isBusy()) return;
      // Manual refresh always re-reads package.json/the lockfile from disk —
      // see reloadAndScan — so externally changed dependencies show up, not
      // just a re-run of the pipeline against whatever was read on open.
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
        // Exit 0: re-resolve the project (package.json/the lockfile the
        // upgrade task itself just rewrote) and force a fresh scan against
        // that, not the pre-upgrade snapshot — see reloadAndScan.
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
   * Re-reads package.json/the lockfile from disk and (re)builds the
   * controller's project snapshot before scanning — used by both manual
   * refresh and a successful upgrade, so neither ever scans against stale,
   * in-memory manifest/lockfile text. The fetch machinery (httpClient/
   * etagStore/auditRunner) is shared across every reload via panel-level
   * fields, so a reload does not lose ETag caching.
   */
  private async reloadAndScan(): Promise<void> {
    let project: ResolvedProject;
    try {
      project = await resolveProject();
    } catch (cause) {
      if (this.disposed) return;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return;
    }
    if (this.disposed) return;

    if (this.controller === undefined) {
      this.controller = this.buildController(project);
    } else {
      this.controller.updateProjectSnapshot(project);
    }
    await this.controller.handleRefresh(this.sink);
  }

  /**
   * Project resolution is async and can fail (no folder open, no package.json).
   * That is reported as fatal-error over the same channel rather than thrown
   * during construction, so the panel still opens and shows a retryable state.
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
      const project = await resolveProject();
      if (this.disposed) return undefined;
      this.controller = this.buildController(project);
      return this.controller;
    } catch (cause) {
      if (this.disposed) return undefined;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return undefined;
    }
  }

  private buildController(project: ResolvedProject): DashboardController {
    return new DashboardController({
      root: project.root,
      manifestText: project.manifestText,
      lockfileText: project.lockfileText,
      registry: project.registry,
      httpClient: this.httpClient,
      etagStore: this.etagStore,
      auditRunner: this.auditRunner,
    });
  }
}
