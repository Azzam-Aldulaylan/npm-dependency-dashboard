/**
 * Finds the project(s) the dashboard can render, using VS Code's workspace
 * search rather than a recursive filesystem walk.
 *
 * Every decision worth testing already lives in src/core/workspace/scan.ts —
 * this file is the adapter that feeds it raw paths and reads the chosen
 * files off disk. Split in two (S6):
 *   - `discoverProjects` scans every open WorkspaceFolder and returns the
 *     full, host-owned candidate list — cheap, no file content read yet.
 *   - `loadProject` reads one specific candidate's manifest/lockfile and
 *     resolves its registry, given a candidate `discoverProjects` (or a
 *     picker built from it) produced. It never reads anything the caller
 *     didn't already discover.
 * DashboardPanel decides which candidate to load (auto-selected when there's
 * exactly one, chosen via QuickPick when there's more than one) — this file
 * has no opinion on selection, only discovery and loading.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { resolveRegistry } from '../core/registry/npmrc.js';
import type { DiscoveredProjectCandidate, ProjectCandidateSource } from '../core/workspace/scan.js';
import {
  DEFAULT_EXCLUDED_DIRS,
  PACKAGE_LOCK,
  SHRINKWRAP,
  chooseLockfile,
  discoverProjectCandidates,
  dirOf,
  nearestLockfileDir,
} from '../core/workspace/scan.js';

export class NoProjectFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProjectFoundError';
  }
}

/** The picker was shown and the user dismissed it without choosing — distinct from zero candidates existing at all. */
export class NoProjectSelectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProjectSelectedError';
  }
}

export interface ResolvedProject {
  /** Absolute path to the directory holding package.json. */
  root: string;
  manifestText: string;
  lockfileText: string | null;
  registry: string;
}

/**
 * A host-owned project candidate — everything needed to load or label it,
 * plus the real `vscode.WorkspaceFolder` (never serialized to the webview;
 * `SelectedProjectInfo` in webviewProtocol.ts is the webview-safe subset).
 */
export interface DiscoveredProject extends DiscoveredProjectCandidate {
  folder: vscode.WorkspaceFolder;
}

const EXCLUDE_GLOB = `**/{${DEFAULT_EXCLUDED_DIRS.join(',')}}/**`;
const LOCKFILE_GLOB = `**/{${PACKAGE_LOCK},${SHRINKWRAP}}`;

async function readIfExists(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Workspace-folder-relative, POSIX-separated — the shape src/core/workspace
 * expects. Unlike `vscode.workspace.asRelativePath` (which resolves against
 * *whichever* workspace folder contains the URI, an ambiguous choice when
 * folders overlap), this is computed against the *specific* `folder` being
 * scanned, and returns null if the URI turns out not to actually be inside
 * it — `findFiles` with a `RelativePattern` is scoped to one folder by
 * contract, but this is a cheap, explicit belt-and-braces check for exactly
 * the security property S6 calls for: a candidate can never end up
 * attributed to a folder it doesn't actually live in.
 */
function relativeToFolder(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string | null {
  const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * npm workspaces keep a single lockfile at the repo root covering every
 * member, so a member's lockfile is not in its own directory — hence the walk
 * up via nearestLockfileDir rather than a lookup at `dir`.
 */
async function findLockfile(
  folder: vscode.WorkspaceFolder,
  projectDir: string
): Promise<{ dir: string; name: string } | null> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, LOCKFILE_GLOB),
    EXCLUDE_GLOB
  );

  const namesByDir = new Map<string, string[]>();
  for (const uri of uris) {
    const rel = relativeToFolder(folder, uri);
    if (rel === null) continue;
    const dir = dirOf(rel);
    const name = dir === '' ? rel : rel.slice(dir.length + 1);
    namesByDir.set(dir, [...(namesByDir.get(dir) ?? []), name]);
  }

  const dir = nearestLockfileDir(projectDir, [...namesByDir.keys()]);
  if (dir === null) return null;

  const name = chooseLockfile(namesByDir.get(dir) ?? []);
  return name === null ? null : { dir, name };
}

async function resolveRegistryUrl(projectRoot: string): Promise<string> {
  // Project .npmrc is attacker-controlled content in a cloned repo. Trust is
  // checked here as well as at activation because this is the read that
  // actually consumes it — see the SECURITY block in core/registry/npmrc.ts.
  const configured = vscode.workspace
    .getConfiguration('dependencyDashboard')
    .get<boolean>('registry.useProjectNpmrc', true);
  const allowProjectNpmrc = configured && vscode.workspace.isTrusted;

  const projectNpmrc = allowProjectNpmrc
    ? await readIfExists(path.join(projectRoot, '.npmrc'))
    : undefined;
  const userNpmrc = await readIfExists(path.join(homedir(), '.npmrc'));

  const { registry } = resolveRegistry({
    allowProjectNpmrc,
    ...(projectNpmrc === undefined ? {} : { projectNpmrc }),
    ...(userNpmrc === undefined ? {} : { userNpmrc }),
  });
  return registry.url;
}

/**
 * Scans every open WorkspaceFolder for package.json candidates — cheap, no
 * file content read. `vscode.workspace.findFiles` is scoped per folder via
 * `RelativePattern`, never a raw recursive walk. Returns [] when no folder
 * is open or none contain a package.json; the caller decides what that
 * means (DashboardPanel reports it as the existing "no project" error).
 */
export async function discoverProjects(): Promise<DiscoveredProject[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const foldersById = new Map<string, vscode.WorkspaceFolder>();
  const sources: ProjectCandidateSource[] = [];

  for (const folder of folders) {
    const folderId = folder.uri.toString();
    foldersById.set(folderId, folder);
    const manifestUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/package.json'),
      EXCLUDE_GLOB
    );
    const manifestPaths = manifestUris
      .map((uri) => relativeToFolder(folder, uri))
      .filter((rel): rel is string => rel !== null);
    sources.push({ folderId, folderName: folder.name, manifestPaths });
  }

  return discoverProjectCandidates(sources).map((candidate) => {
    const folder = foldersById.get(candidate.folderId);
    // Every id here was derived from a folderId this same loop just put in
    // the map, so this is always found — the assertion documents that
    // invariant rather than papering over a real possibility of failure.
    if (folder === undefined) throw new Error('unreachable: candidate references an unknown workspace folder');
    return { ...candidate, folder };
  });
}

/** Reads one specific, already-discovered candidate's manifest/lockfile and resolves its registry. Never reads anything not already produced by `discoverProjects`. */
export async function loadProject(candidate: DiscoveredProject): Promise<ResolvedProject> {
  const base = candidate.folder.uri.fsPath;
  const root = candidate.dir === '' ? base : path.join(base, candidate.dir);
  const manifestText = await readFile(path.join(base, candidate.manifestPath), 'utf8');

  const lockfile = await findLockfile(candidate.folder, candidate.dir);
  const lockfileText =
    lockfile === null
      ? null
      : ((await readIfExists(path.join(base, lockfile.dir, lockfile.name))) ?? null);

  return { root, manifestText, lockfileText, registry: await resolveRegistryUrl(root) };
}
