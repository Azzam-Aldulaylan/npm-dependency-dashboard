/**
 * The vscode-facing half of the Upgrade action: modal confirmation, the
 * Workspace Trust re-check, npm resolution, and running `npm install` as a
 * visible vscode.Task. Everything decidable without `vscode` (argv
 * construction, save-flag/ignore-scripts logic, major-version detection)
 * lives in src/core/upgrade/plan.ts instead — this file only wires that
 * output into real VS Code APIs.
 *
 * SECURITY: ProcessExecution is given the resolved `node` executable and an
 * argument array starting with `npm-cli.js` — never a shell command string,
 * never `npm`/`npm.cmd` directly — so nothing here ever concatenates a
 * package name, version, path, or setting into text a shell would parse, and
 * nothing here relies on a shebang or a Windows batch-file layer. See
 * npmResolver.ts for why.
 */

import * as vscode from 'vscode';

import type { DependencyClassification } from '../core/upgrade/plan.js';
import {
  buildCoordinatedInstallArgs,
  buildInstallArgs,
  buildManifestReconciliationArgs,
  isMajorUpgrade,
} from '../core/upgrade/plan.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import { resolveInstalledPnpmInvocation } from './pnpmResolver.js';
import type { PackageManagerInvocation } from './resolverVerifier.js';
import { PendingUpgradeRuns, UpgradeLock, isSuccessfulExitCode } from './upgradeTracker.js';
import type { VerificationExecutionResult } from './upgradeTransaction.js';
import { buildVerificationScriptArgs } from './verificationPolicy.js';
import type { VerificationScript } from './verificationPolicy.js';

export interface UpgradeRunParams {
  packageName: string;
  currentVersion: string;
  target: string;
  classification: DependencyClassification;
  cwd: string;
  ignoreScripts: boolean;
  packageManager: 'npm' | 'pnpm';
  verificationScriptNames?: readonly string[];
  compatibilitySummary?: readonly string[];
  coordinatedChanges?: readonly {
    packageName: string;
    target: string;
    classification: DependencyClassification;
  }[];
}

export type UpgradeRunOutcome = { ok: true } | { ok: false; code: string; message: string };

/**
 * Host-owned inputs for reconciling an already-staged package.json. No
 * package/version/classification input is accepted because those values must
 * be validated and written by the host before the returned execution runs.
 */
export interface UpgradeManifestReconciliationParams {
  cwd: string;
  ignoreScripts: boolean;
  packageManager: 'npm' | 'pnpm';
}

export type PreparedManifestReconciliation =
  | { ok: false; code: string; message: string }
  | { ok: true; execute(): Promise<UpgradeRunOutcome> };

export interface UpgradeVerificationParams {
  packageName: string;
  cwd: string;
  packageManager: 'npm' | 'pnpm';
  scripts: readonly VerificationScript[];
}

const DISPOSED_OUTCOME: UpgradeRunOutcome = {
  ok: false,
  code: 'DISPOSED',
  message: 'The dashboard panel was closed.',
};

/**
 * Modal, so the user cannot lose it behind other panels — this is the one
 * gate standing between a click and package.json/the lockfile changing.
 * Returns false for every dismissal path (Escape, clicking outside, the
 * explicit Cancel), not just an explicit "Cancel" click.
 */
export async function confirmUpgrade(params: UpgradeRunParams): Promise<boolean> {
  const major = isMajorUpgrade(params.currentVersion, params.target);
  const detail = [
    `Package: ${params.packageName}`,
    `Current version: ${params.currentVersion}`,
    `Target version: ${params.target}${major ? ' (major upgrade)' : ''}`,
    '',
    'This will modify package.json and the lockfile.',
    params.ignoreScripts
      ? 'Lifecycle scripts are disabled for this upgrade (--ignore-scripts).'
      : 'Lifecycle scripts will run as part of this upgrade.',
    params.verificationScriptNames !== undefined && params.verificationScriptNames.length > 0
      ? `Post-upgrade verification: ${params.verificationScriptNames.join(', ')}.`
      : 'No application verification scripts are configured; install success will remain unverified.',
    ...(params.compatibilitySummary === undefined
      ? []
      : ['', 'Preflight compatibility:', ...params.compatibilitySummary]),
    ...(params.coordinatedChanges === undefined || params.coordinatedChanges.length <= 1
      ? []
      : [
          '',
          'Coordinated changes:',
          ...params.coordinatedChanges.map((change) => `• ${change.packageName} → ${change.target}`),
        ]),
  ].join('\n');

  const choice = await vscode.window.showWarningMessage(
    `Upgrade ${params.packageName} to ${params.target}?`,
    { modal: true, detail },
    'Upgrade'
  );
  return choice === 'Upgrade';
}

/**
 * Tracks the panel-wide upgrade lock and in-flight task-completion listeners
 * for one panel. One instance per DashboardPanel; `dispose()` from the
 * panel's onDidDispose so neither a stray listener, a held lock, nor a
 * permanently-pending `run()` Promise outlives the panel.
 */
export class UpgradeExecutionSession {
  private readonly lock = new UpgradeLock();
  private readonly listeners = new Set<vscode.Disposable>();
  private readonly pendingRuns = new PendingUpgradeRuns();

  /**
   * Reserves the panel's single upgrade slot for `packageName` for the whole
   * confirm-then-run flow — called by DashboardPanel before showing the
   * confirmation dialog, not just before running the task. Reserving only
   * inside `run()` would still guarantee at most one *running task*, but
   * would let a flood of forged requests each independently reach (and
   * stack) their own confirmation dialog. One upgrade at a time for the
   * whole panel, not one per package — two `npm install`s racing to write
   * the same package.json/lockfile is unsafe regardless of which packages
   * they target. Returns false if a reservation is already held, for any
   * package. The caller must call `release` exactly once for every
   * reservation that succeeds, whichever way the flow ends (cancelled,
   * rejected, or run).
   */
  reserve(packageName: string): boolean {
    return this.lock.tryAcquire(packageName);
  }

  release(packageName: string): void {
    this.lock.release(packageName);
  }

  /** Whether the panel's single upgrade slot is currently held, by anyone — gates manual refresh from starting during an active upgrade. */
  isBusy(): boolean {
    return this.lock.isHeld();
  }

  /**
   * Re-checks Workspace Trust as the very first thing this method does —
   * called immediately after confirmation resolves true, so this is the
   * last gate before anything executes, closest to execution time. Assumes
   * the caller already holds a reservation via `reserve` — this method does
   * not itself track or release one.
   */
  async run(params: UpgradeRunParams): Promise<UpgradeRunOutcome> {
    if (!vscode.workspace.isTrusted) {
      return {
        ok: false,
        code: 'UNTRUSTED_WORKSPACE',
        message: 'Upgrades are disabled in untrusted workspaces.',
      };
    }

    // params.cwd is also the eventual task's cwd (see executeTask below) —
    // the identical, single-read value, so a Volta pin (which depends on the
    // working directory) resolves the same way during this validation as it
    // will during the actual visible task.
    const invocation = this.resolveInvocation(params.cwd, params.packageManager);
    if (invocation === null) {
      void vscode.window.showErrorMessage(
        `Dependency Dashboard could not locate a working ${params.packageManager} installation.`
      );
      return {
        ok: false,
        code: 'PACKAGE_MANAGER_NOT_FOUND',
        message: `A working ${params.packageManager} installation could not be located.`,
      };
    }

    const args =
      params.coordinatedChanges !== undefined && params.coordinatedChanges.length > 1
        ? buildCoordinatedInstallArgs(params.packageManager, {
            changes: params.coordinatedChanges,
            ignoreScripts: params.ignoreScripts,
          })
        : buildInstallArgs(params.packageManager, {
            packageName: params.packageName,
            target: params.target,
            classification: params.classification,
            ignoreScripts: params.ignoreScripts,
          });
    return await this.executeTask(
      invocation,
      params.cwd,
      params.packageName,
      args,
      `Dependency Dashboard: Upgrade ${params.packageName}`,
      `${params.packageManager} ${args[0]}`
    );
  }

  /**
   * Authorize and resolve a manifest reconciliation before package.json is
   * staged. The returned execution captures the trusted JS entrypoint and
   * literal argv, and may be invoked exactly once after staging. This split
   * prevents an untrusted workspace or missing package manager from causing
   * even a transient manifest mutation.
   */
  prepareManifestReconciliation(
    params: UpgradeManifestReconciliationParams
  ): PreparedManifestReconciliation {
    if (!vscode.workspace.isTrusted) {
      return {
        ok: false,
        code: 'UNTRUSTED_WORKSPACE',
        message: 'Upgrades are disabled in untrusted workspaces.',
      };
    }

    const { cwd, packageManager, ignoreScripts } = params;
    const invocation = this.resolveInvocation(cwd, packageManager);
    if (invocation === null) {
      void vscode.window.showErrorMessage(
        `Dependency Dashboard could not locate a working ${packageManager} installation.`
      );
      return {
        ok: false,
        code: 'PACKAGE_MANAGER_NOT_FOUND',
        message: `A working ${packageManager} installation could not be located.`,
      };
    }

    const args = buildManifestReconciliationArgs(packageManager, { ignoreScripts });
    let executed = false;
    return {
      ok: true,
      execute: async (): Promise<UpgradeRunOutcome> => {
        if (executed) {
          return {
            ok: false,
            code: 'RECONCILIATION_ALREADY_EXECUTED',
            message: 'The prepared manifest reconciliation has already been executed.',
          };
        }
        executed = true;
        if (!vscode.workspace.isTrusted) {
          return {
            ok: false,
            code: 'UNTRUSTED_WORKSPACE',
            message: 'Upgrades are disabled in untrusted workspaces.',
          };
        }
        return await this.executeTask(
          invocation,
          cwd,
          'coordinated-upgrade',
          args,
          'Dependency Dashboard: Reconcile coordinated dependencies',
          `${packageManager} ${args[0]}`
        );
      },
    };
  }

  /** Runs only host-selected package.json script names, one visible task at a time. */
  async verify(params: UpgradeVerificationParams): Promise<VerificationExecutionResult> {
    if (!vscode.workspace.isTrusted) {
      return { status: 'failed', checks: [], message: 'Verification is disabled in untrusted workspaces.' };
    }
    const invocation = this.resolveInvocation(params.cwd, params.packageManager);
    if (invocation === null) {
      return { status: 'failed', checks: [], message: `A working ${params.packageManager} installation could not be located.` };
    }

    const checks: Array<{ id: string; status: 'passed' | 'failed'; message?: string }> = [];
    for (const script of params.scripts) {
      const outcome = await this.executeTask(
        invocation,
        params.cwd,
        params.packageName,
        buildVerificationScriptArgs(params.packageManager, script.scriptName),
        `Dependency Dashboard: Verify ${script.scriptName}`,
        `${params.packageManager} run ${script.scriptName}`
      );
      if (!outcome.ok) {
        checks.push({ id: script.id, status: 'failed', message: outcome.message });
        return { status: 'failed', checks, message: `Verification script ${script.scriptName} failed.` };
      }
      checks.push({ id: script.id, status: 'passed' });
    }
    return { status: 'passed', checks };
  }

  private resolveInvocation(cwd: string, packageManager: 'npm' | 'pnpm'): PackageManagerInvocation | null {
    const npm = resolveNpmInvocation(createNodeNpmResolverDeps(cwd));
    if (!npm.ok) return null;
    if (packageManager === 'npm') {
      return { executable: npm.invocation.node, prefixArgs: [npm.invocation.npmCliJs] };
    }
    return resolveInstalledPnpmInvocation(npm.invocation, cwd);
  }

  private async executeTask(
    invocation: PackageManagerInvocation,
    cwd: string,
    packageName: string,
    args: readonly string[],
    taskName: string,
    failureCommand: string
  ): Promise<UpgradeRunOutcome> {
    // An argument array, never a shell string: `invocation.node` and every
    // element of `[invocation.npmCliJs, ...args]` reach the process as
    // literal argv entries, with no shell parsing step in between for a
    // hostile character to exploit, and no npm/npm.cmd shim layer either.
    // `params.cwd` here is the same single-read value passed to
    // `createNodeNpmResolverDeps` in `run` above — resolution and execution
    // never see different working directories.
    const execution = new vscode.ProcessExecution(invocation.executable, [...invocation.prefixArgs, ...args], {
      cwd,
    });
    const task = new vscode.Task(
      { type: 'dependencyDashboard.upgrade', package: packageName },
      vscode.TaskScope.Workspace,
      taskName,
      'Dependency Dashboard',
      execution
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    };

    return await new Promise<UpgradeRunOutcome>((resolve) => {
      let settled = false;
      // A vscode.Disposable only stops *future* events — disposing the
      // onDidEndTaskProcess listener below does not, by itself, resolve this
      // Promise. `untrack` (called on the normal completion path) removes
      // this callback so `dispose()` doesn't double-settle an already-
      // finished run; if `dispose()` fires first, it calls this and the
      // pending run resolves with DISPOSED instead of hanging forever.
      const untrack = this.pendingRuns.track(() => {
        if (settled) return;
        settled = true;
        resolve(DISPOSED_OUTCOME);
      });
      const finish = (outcome: UpgradeRunOutcome): void => {
        if (settled) return;
        settled = true;
        untrack();
        resolve(outcome);
      };

      vscode.tasks.executeTask(task).then(
        (started) => {
          // dispose() already settled this run (DISPOSED) while executeTask
          // was still pending — don't register a listener for a session that
          // is already torn down; the task itself keeps running regardless,
          // we simply stop caring about its outcome from here.
          if (settled) return;
          const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
            // Filtered to this exact execution — onDidEndTaskProcess fires
            // for every task in the workspace, not just ours.
            if (event.execution !== started) return;
            disposable.dispose();
            this.listeners.delete(disposable);
            finish(
              isSuccessfulExitCode(event.exitCode)
                ? { ok: true }
                : {
                    ok: false,
                    code: 'TASK_FAILED',
                    message: `${failureCommand} exited with code ${event.exitCode ?? 'unknown'}.`,
                  }
            );
          });
          this.listeners.add(disposable);
        },
        (error: unknown) => {
          finish({
            ok: false,
            code: 'TASK_START_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      );
    });
  }

  dispose(): void {
    for (const disposable of this.listeners) disposable.dispose();
    this.listeners.clear();
    // Settle every still-pending run (DISPOSED) so nothing awaits forever —
    // a running npm install itself is deliberately left to finish on its own
    // in its VS Code task terminal rather than being killed: aborting a
    // package.json/lockfile write mid-flight would be worse than letting it
    // complete after the dashboard closed.
    this.pendingRuns.settleAll();
    this.lock.clear();
  }
}
