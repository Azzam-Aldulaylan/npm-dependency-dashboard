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
import { NodeHttpClient } from '../core/registry/http.js';
import { MemoryEtagStore } from '../core/registry/versions.js';
import { DashboardController } from './dashboardController.js';
import type { MessageSink } from './dashboardController.js';
import { resolveProject } from './projectResolution.js';
import type { ProtocolError } from './webviewProtocol.js';
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
        void this.handle(raw.type);
      },
      null,
      context.subscriptions
    );

    this.panel.onDidDispose(
      () => {
        // An in-flight pipeline run must not outlive the panel, nor try to
        // post into a webview that no longer exists.
        this.controller?.dispose();
        this.controller = undefined;
        this.pending = undefined;
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
    await DashboardPanel.current?.handle('refresh');
  }

  private async handle(type: 'ready' | 'refresh'): Promise<void> {
    const controller = await this.ensureController();
    if (controller === undefined) return; // ensureController already posted the failure.
    if (type === 'ready') await controller.handleReady(this.sink);
    else await controller.handleRefresh(this.sink);
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
      this.controller = new DashboardController({
        root: project.root,
        manifestText: project.manifestText,
        lockfileText: project.lockfileText,
        registry: project.registry,
        httpClient: new NodeHttpClient(),
        etagStore: new MemoryEtagStore(),
        auditRunner: new NodeAuditRunner(),
      });
      return this.controller;
    } catch (cause) {
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return undefined;
    }
  }
}
