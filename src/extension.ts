/**
 * Composition root. Keep this thin — wiring only, no logic.
 *
 * Anything with behavior worth testing belongs in src/core (pure, no vscode)
 * or src/host (vscode-facing adapters).
 */

import * as vscode from 'vscode';

import { createPerformanceSession } from './core/performance/measurement.js';
import { DashboardPanel } from './host/dashboardPanel.js';
import type { DashboardPanelIntegrationTestSnapshot } from './host/dashboardPanel.js';

export interface DependencyDashboardIntegrationTestApi {
  dashboard: {
    snapshot(): DashboardPanelIntegrationTestSnapshot;
    dispatch(message: unknown): Promise<void>;
  };
}

export function activate(context: vscode.ExtensionContext): void | DependencyDashboardIntegrationTestApi {
  const performanceEnabled = vscode.workspace
    .getConfiguration('dependencyDashboard')
    .get<boolean>('debug.performance', false);
  const performance = createPerformanceSession('Dependency Dashboard activation', performanceEnabled);
  const endActivation = performance.start('command registration');
  // The manifest declares untrustedWorkspaces.supported = false, so VS Code
  // won't activate us in an untrusted workspace at all. This check is a
  // belt-and-braces guard in case that declaration is ever loosened: reading
  // .npmrc and running npm install are both unsafe against untrusted content.
  if (!vscode.workspace.isTrusted) {
    endActivation({ trusted: false });
    performance.finish({ trusted: false });
    return;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dependencyDashboard.open', () => {
      DashboardPanel.createOrShow(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dependencyDashboard.refresh', () => {
      void DashboardPanel.refresh();
    })
  );
  endActivation({ trusted: true });
  performance.finish({ trusted: true });

  if (
    context.extensionMode === vscode.ExtensionMode.Test ||
    process.env['DEPENDENCY_DASHBOARD_EXTENSION_TEST'] === '1'
  ) {
    return {
      dashboard: {
        snapshot: () => DashboardPanel.integrationTestSnapshot(),
        dispatch: (message) => DashboardPanel.dispatchIntegrationTestMessage(message),
      },
    };
  }
}

export function deactivate(): void {
  // Disposables are registered on context.subscriptions; nothing extra here.
}
