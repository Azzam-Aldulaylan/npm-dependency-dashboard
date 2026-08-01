/**
 * Workspace scanning — the pure half.
 *
 * Finding files needs vscode.workspace.findFiles, which cannot be imported
 * here. So the adapter supplies the raw path list and everything with a
 * decision in it lives in this file, where it is testable without an extension
 * host.
 *
 * All paths are workspace-relative and POSIX-separated. The adapter normalizes
 * at the boundary, which keeps the Windows path shape out of core entirely.
 */

export const SHRINKWRAP = 'npm-shrinkwrap.json';
export const PACKAGE_LOCK = 'package-lock.json';

/**
 * Directories never worth scanning. `node_modules` is the important one — a
 * raw recursive walk of a large repo is the difference between a scan that
 * takes milliseconds and one that takes minutes.
 */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'vendor',
  'tmp',
];

export interface ProjectCandidate {
  /** Workspace-relative POSIX path to package.json, e.g. "packages/app/package.json". */
  manifestPath: string;
  /** Directory holding it; "" for the workspace root. */
  dir: string;
}

export function isExcluded(
  relPath: string,
  excluded: readonly string[] = DEFAULT_EXCLUDED_DIRS
): boolean {
  const segments = relPath.split('/');
  // The final segment is the filename; only directory segments are tested.
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment !== undefined && excluded.includes(segment)) return true;
  }
  return false;
}

export function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/**
 * Turn raw findFiles output into the project list.
 *
 * Sorted root-first, then alphabetically, so the picker order is stable across
 * runs and the root project is the natural default.
 */
export function toProjectCandidates(
  manifestPaths: readonly string[],
  excluded: readonly string[] = DEFAULT_EXCLUDED_DIRS
): ProjectCandidate[] {
  const seen = new Set<string>();
  const out: ProjectCandidate[] = [];

  for (const raw of manifestPaths) {
    const relPath = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!relPath.endsWith('package.json')) continue;
    if (isExcluded(relPath, excluded)) continue;
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    out.push({ manifestPath: relPath, dir: dirOf(relPath) });
  }

  out.sort((a, b) => {
    if (a.dir === '' && b.dir !== '') return -1;
    if (b.dir === '' && a.dir !== '') return 1;
    return a.manifestPath.localeCompare(b.manifestPath);
  });

  return out;
}

/**
 * Pick the lockfile for a directory.
 *
 * npm-shrinkwrap.json wins when both are present — that is npm's own
 * precedence, and a project that ships a shrinkwrap is explicitly overriding
 * the lockfile.
 */
export function chooseLockfile(filenames: readonly string[]): string | null {
  if (filenames.includes(SHRINKWRAP)) return SHRINKWRAP;
  if (filenames.includes(PACKAGE_LOCK)) return PACKAGE_LOCK;
  return null;
}

/**
 * Find the nearest directory at or above `dir` that holds a lockfile.
 *
 * npm workspaces keep one lockfile at the repo root covering every member, so
 * a member's resolved versions are not in its own directory. Returns null when
 * nothing up the chain has one.
 */
export function nearestLockfileDir(
  dir: string,
  lockfileDirs: readonly string[]
): string | null {
  const available = new Set(lockfileDirs.map((d) => d.replace(/\\/g, '/')));
  let current = dir.replace(/\\/g, '/');

  for (;;) {
    if (available.has(current)) return current;
    if (current === '') return null;
    const idx = current.lastIndexOf('/');
    current = idx === -1 ? '' : current.slice(0, idx);
  }
}
