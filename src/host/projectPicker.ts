/**
 * The native VS Code QuickPick for choosing among multiple discovered
 * projects. Deliberately not a webview concern: the webview can only ask the
 * host to open this (see the `change-project` message), never see or choose
 * from the candidate list itself — this file owns the entire selection UI.
 *
 * Each item carries the real `DiscoveredProject` object as data (VS Code's
 * QuickPick API returns the exact item the user picked), so there is no
 * ID-based lookup step that a forged value could target — the result is
 * always a reference into the same host-owned list `pickProject` was given.
 */

import * as vscode from 'vscode';

import { projectCandidateLabel } from '../core/workspace/scan.js';
import type { DiscoveredProject } from './projectResolution.js';

interface ProjectQuickPickItem extends vscode.QuickPickItem {
  candidate: DiscoveredProject;
}

function toQuickPickItem(candidate: DiscoveredProject): ProjectQuickPickItem {
  return {
    label: projectCandidateLabel(candidate),
    description: candidate.manifestPath,
    detail: candidate.folder.uri.fsPath,
    candidate,
  };
}

/**
 * Shows the picker and resolves to the chosen candidate, or undefined if the
 * user cancelled (Escape, clicking away) — callers are responsible for
 * deciding what cancellation means (leave the current selection alone for a
 * later change; report a retryable "no project selected" state for the
 * first-ever selection).
 */
export async function pickProject(
  candidates: readonly DiscoveredProject[]
): Promise<DiscoveredProject | undefined> {
  const picked = await vscode.window.showQuickPick(candidates.map(toQuickPickItem), {
    title: 'Dependency Dashboard: Select a Project',
    placeHolder: 'Choose which package.json to view',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.candidate;
}
