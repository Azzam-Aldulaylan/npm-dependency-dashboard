/**
 * Composition root. Keep this thin — wiring only, no logic.
 *
 * Anything with behavior worth testing belongs in src/core (pure, no vscode)
 * or src/host (vscode-facing adapters).
 */

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  // The manifest declares untrustedWorkspaces.supported = false, so VS Code
  // won't activate us in an untrusted workspace at all. This check is a
  // belt-and-braces guard in case that declaration is ever loosened: reading
  // .npmrc and running npm install are both unsafe against untrusted content.
  if (!vscode.workspace.isTrusted) {
    return;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dependencyDashboard.open', () => {
      // TODO(S4): create/reveal the panel.
      vscode.window.showInformationMessage('Dependency Dashboard: panel not built yet.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dependencyDashboard.refresh', () => {
      // TODO(S4): force a cache-bypassing refresh of the active project.
    })
  );
}

export function deactivate(): void {
  // Disposables are registered on context.subscriptions; nothing extra here.
}
