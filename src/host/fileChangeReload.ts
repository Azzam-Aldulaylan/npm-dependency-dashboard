/**
 * Re-reads a project from disk and replaces a live `DashboardController`'s
 * snapshot with it — the actual "reload" behind a file-watcher-triggered
 * invalidation (S7 requirement: never rescan the controller's old
 * construction-time strings).
 *
 * Generic over `TCandidate` and takes every disk/vscode-touching operation
 * as an injected `ReloadSource`, rather than importing `loadProject`/
 * `toProjectInfo` from projectResolution.ts directly — so this function
 * itself stays free of any vscode import and is fully exercisable with
 * node:test against a fake source and a real `DashboardController`, proving
 * actual snapshot replacement rather than only the surrounding coordination
 * logic (see fileChangeCoordinator.ts, which owns that half).
 */

import type { DashboardController, MessageSink } from './dashboardController.js';
import type { SelectedProjectInfo } from './webviewProtocol.js';

export interface ReloadedProject {
  root: string;
  manifestText: string;
  lockfileText: string | null;
  lockfilePath: string | null;
  registry: string;
}

export interface ReloadSource<TCandidate> {
  loadProject(candidate: TCandidate): Promise<ReloadedProject>;
  toProjectInfo(candidate: TCandidate): SelectedProjectInfo;
  cacheKeyFor(candidate: TCandidate, registry: string): string;
}

export interface ReloadControllerFromDiskParams<TCandidate> {
  candidate: TCandidate;
  controller: DashboardController;
  canChangeProject: boolean;
  sink: MessageSink;
  source: ReloadSource<TCandidate>;
  /**
   * The caller's own `controller.beginRevalidation()` return value, captured
   * *before* this function's own `loadProject` call — threaded straight
   * through to `updateProjectSnapshot` so it can tell whether anything else
   * (a watcher event, an independent reload) called `beginRevalidation()`
   * again while this disk read was in flight. See
   * `DashboardController.updateProjectSnapshot`'s own doc for why this
   * can't just be re-derived here after the fact.
   */
  generationAtReadStart: number;
  /**
   * Re-checked right after the disk read resolves, before anything about
   * `controller` is mutated — catches a project switch that started and
   * finished entirely during the `loadProject` await. Omit to skip the
   * check (the caller has nothing else to compare against).
   */
  isStillCurrent?: () => boolean;
}

export type ReloadOutcome = { applied: true; project: ReloadedProject } | { applied: false; reason: 'superseded' };

/**
 * Always re-reads from disk (never trusts `controller`'s existing options),
 * then — unless superseded while reading — invalidates the persisted entry,
 * replaces the controller's project snapshot with the fresh read, and runs
 * `refreshInBackground` so the previously-rendered table stays on screen
 * until (and unless) the new scan actually completes.
 */
export async function reloadControllerFromDisk<TCandidate>(
  params: ReloadControllerFromDiskParams<TCandidate>
): Promise<ReloadOutcome> {
  const project = await params.source.loadProject(params.candidate);

  if (params.isStillCurrent?.() === false) {
    return { applied: false, reason: 'superseded' };
  }

  const projectInfo = params.source.toProjectInfo(params.candidate);
  const cacheKey = params.source.cacheKeyFor(params.candidate, project.registry);

  params.controller.invalidateCache();
  params.controller.updateProjectSnapshot(
    {
      root: project.root,
      manifestText: project.manifestText,
      lockfileText: project.lockfileText,
      lockfilePath: project.lockfilePath,
      registry: project.registry,
      projectInfo,
      canChangeProject: params.canChangeProject,
      cacheKey,
    },
    params.generationAtReadStart
  );
  await params.controller.refreshInBackground(params.sink);

  return { applied: true, project };
}
