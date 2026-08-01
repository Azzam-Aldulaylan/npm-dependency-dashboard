/**
 * Finds the project the dashboard should render, using VS Code's workspace
 * search rather than a recursive filesystem walk.
 *
 * Every decision worth testing already lives in src/core/workspace/scan.ts —
 * this file is the adapter that feeds it raw paths and reads the chosen files
 * off disk. Multi-project selection is not implemented: the first candidate
 * wins, and toProjectCandidates already sorts root-first, so that is the
 * workspace root whenever one has a package.json.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { resolveRegistry } from '../core/registry/npmrc.js';
import {
  DEFAULT_EXCLUDED_DIRS,
  PACKAGE_LOCK,
  SHRINKWRAP,
  chooseLockfile,
  dirOf,
  nearestLockfileDir,
  toProjectCandidates,
} from '../core/workspace/scan.js';

export class NoProjectFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProjectFoundError';
  }
}

export interface ResolvedProject {
  /** Absolute path to the directory holding package.json. */
  root: string;
  manifestText: string;
  lockfileText: string | null;
  registry: string;
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

/** Workspace-relative, POSIX-separated — the shape src/core/workspace expects. */
function relativePosix(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
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
    const rel = relativePosix(uri);
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

export async function resolveProject(): Promise<ResolvedProject> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new NoProjectFoundError('Open a folder to see its dependencies.');
  }

  const manifestUris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/package.json'),
    EXCLUDE_GLOB
  );
  const project = toProjectCandidates(manifestUris.map(relativePosix))[0];
  if (project === undefined) {
    throw new NoProjectFoundError('No package.json was found in this workspace.');
  }

  const base = folder.uri.fsPath;
  const root = project.dir === '' ? base : path.join(base, project.dir);
  const manifestText = await readFile(path.join(base, project.manifestPath), 'utf8');

  const lockfile = await findLockfile(folder, project.dir);
  const lockfileText =
    lockfile === null
      ? null
      : ((await readIfExists(path.join(base, lockfile.dir, lockfile.name))) ?? null);

  return { root, manifestText, lockfileText, registry: await resolveRegistryUrl(root) };
}
