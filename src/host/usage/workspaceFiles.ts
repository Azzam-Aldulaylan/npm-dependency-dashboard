/**
 * VS Code workspace-search adapter for usage analysis — the one place this
 * feature touches `vscode.workspace.findFiles`. Scoped to the specific
 * project directory (a monorepo member's own subtree, not its siblings) via
 * `RelativePattern`, exactly like `discoverProjects`/`loadProject`
 * (projectResolution.ts) already scope manifest/lockfile discovery — never a
 * raw recursive filesystem walk, and never a workspace-relative glob string
 * built by interpolating a real directory name (which could contain glob
 * metacharacters) into a pattern.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { DEFAULT_EXCLUDED_DIRS } from '../../core/workspace/scan.js';
import { CONFIG_FILE_GLOBS } from '../../core/usage/configHeuristics.js';
import { planWorkspaceAnalysisFiles } from '../../core/usage/workspaceAnalysisPlan.js';

export interface WorkspaceFileReadMetrics {
  onStat?(): void;
  onRead?(bytes: number): void;
}

export interface PlannedWorkspaceFile {
  uri: vscode.Uri;
  filePath: string;
  source: boolean;
  config: boolean;
}

/**
 * Workspace-folder-relative, POSIX-separated, and belt-and-braces verified
 * to actually be inside `folder` — the same computation
 * projectResolution.ts's own `relativeToFolder` uses, duplicated here rather
 * than exported across module boundaries for a single small, security-
 * relevant path computation. Used for every reference this feature ever
 * sends to the webview, so a path can never read as "inside" a folder it
 * isn't.
 */
export function relativeToFolder(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string | null {
  const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

export const USAGE_SOURCE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'] as const;
export const USAGE_SOURCE_FILE_GLOB = `**/*.{${USAGE_SOURCE_EXTENSIONS.join(',')}}`;
export const USAGE_CONFIG_FILE_GLOB = `{${CONFIG_FILE_GLOBS.join(',')}}`;
/**
 * Exact watcher authority for usage-analysis identity. Config entries are
 * deliberately shared with discovery, including extensionless `.eslintrc`
 * and `.babelrc`, so a cached result cannot outlive an input change.
 */
export const USAGE_FILE_WATCH_GLOB = `{${USAGE_SOURCE_FILE_GLOB},${CONFIG_FILE_GLOBS.join(',')}}`;
const EXCLUDE_GLOB = `**/{${DEFAULT_EXCLUDED_DIRS.join(',')}}/**`;

/** `dir` is the project's own workspace-folder-relative directory ("" for the folder root — see DiscoveredProject.dir). */
function scopedPattern(folder: vscode.WorkspaceFolder, dir: string, glob: string): vscode.RelativePattern {
  const base = dir === '' ? folder : vscode.Uri.joinPath(folder.uri, dir);
  return new vscode.RelativePattern(base, glob);
}

export async function findSourceFiles(
  folder: vscode.WorkspaceFolder,
  dir: string,
  maxFiles: number,
  token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  const pattern = scopedPattern(folder, dir, USAGE_SOURCE_FILE_GLOB);
  return vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, maxFiles, token);
}

export async function findConfigFiles(
  folder: vscode.WorkspaceFolder,
  dir: string,
  token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  const pattern = scopedPattern(folder, dir, USAGE_CONFIG_FILE_GLOB);
  // Config files are always few — no cap needed beyond the exclude glob.
  return vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, undefined, token);
}

/** Merge source/config discoveries into one stable, de-duplicated read plan. */
export function planWorkspaceFiles(
  folder: vscode.WorkspaceFolder,
  sourceUris: readonly vscode.Uri[],
  configUris: readonly vscode.Uri[]
): PlannedWorkspaceFile[] {
  const uriByPath = new Map<string, vscode.Uri>();
  const sourcePaths: string[] = [];
  const configPaths: string[] = [];
  for (const uri of sourceUris) {
    const filePath = relativeToFolder(folder, uri);
    if (filePath === null) continue;
    uriByPath.set(filePath, uri);
    sourcePaths.push(filePath);
  }
  for (const uri of configUris) {
    const filePath = relativeToFolder(folder, uri);
    if (filePath === null) continue;
    uriByPath.set(filePath, uri);
    configPaths.push(filePath);
  }
  return planWorkspaceAnalysisFiles(sourcePaths, configPaths).flatMap((entry) => {
    const uri = uriByPath.get(entry.key);
    return uri === undefined ? [] : [{
      uri,
      filePath: entry.key,
      source: entry.source,
      config: entry.config,
    }];
  });
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Reads a file's UTF-8 text, or null when it's missing, unreadable, or too large to be worth scanning. */
export async function readTextFileCapped(
  uri: vscode.Uri,
  metrics: WorkspaceFileReadMetrics = {}
): Promise<string | null> {
  try {
    metrics.onStat?.();
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_FILE_BYTES) return null;
    const bytes = await vscode.workspace.fs.readFile(uri);
    metrics.onRead?.(bytes.byteLength);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}
