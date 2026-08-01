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
import { buildNpmInstallArgs, isMajorUpgrade } from '../core/upgrade/plan.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import { PendingUpgradeRuns, UpgradeLock, isSuccessfulExitCode } from './upgradeTracker.js';

export interface UpgradeRunParams {
  packageName: string;
  currentVersion: string;
  target: string;
  classification: DependencyClassification;
  cwd: string;
  ignoreScripts: boolean;
}

export type UpgradeRunOutcome = { ok: true } | { ok: false; code: string; message: string };

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
    const resolution = resolveNpmInvocation(createNodeNpmResolverDeps(params.cwd));
    if (!resolution.ok) {
      void vscode.window.showErrorMessage(
        'Dependency Dashboard could not locate a working npm installation. Make sure Node.js/npm is installed and on your PATH, then try again.'
      );
      return {
        ok: false,
        code: 'NPM_NOT_FOUND',
        message: 'A working npm installation could not be located.',
      };
    }

    return await this.executeTask(resolution.invocation, params);
  }

  private async executeTask(
    invocation: { node: string; npmCliJs: string },
    params: UpgradeRunParams
  ): Promise<UpgradeRunOutcome> {
    const args = buildNpmInstallArgs({
      packageName: params.packageName,
      target: params.target,
      classification: params.classification,
      ignoreScripts: params.ignoreScripts,
    });

    // An argument array, never a shell string: `invocation.node` and every
    // element of `[invocation.npmCliJs, ...args]` reach the process as
    // literal argv entries, with no shell parsing step in between for a
    // hostile character to exploit, and no npm/npm.cmd shim layer either.
    // `params.cwd` here is the same single-read value passed to
    // `createNodeNpmResolverDeps` in `run` above — resolution and execution
    // never see different working directories.
    const execution = new vscode.ProcessExecution(invocation.node, [invocation.npmCliJs, ...args], {
      cwd: params.cwd,
    });
    const task = new vscode.Task(
      { type: 'dependencyDashboard.upgrade', package: params.packageName },
      vscode.TaskScope.Workspace,
      `Dependency Dashboard: Upgrade ${params.packageName}`,
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
                    message: `npm install exited with code ${event.exitCode ?? 'unknown'}.`,
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
