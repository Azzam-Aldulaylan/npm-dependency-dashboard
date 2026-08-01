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
 * Every ancestor directory a lockfile topology change could affect this
 * project's resolved lockfile from: `dir` itself and every directory above
 * it, up to the workspace folder root (`''`) — exactly the directories
 * `nearestLockfileDir` would ever check for `dir`.
 *
 * Deliberately returns directories only, not filenames or a glob string — a
 * directory name is real filesystem content (attacker- or at least
 * environment-controlled: it comes from whatever the workspace actually
 * contains) and must never be interpolated into a glob pattern, where a
 * literal `*`, `?`, `[`, `]`, `{`, `}`, or `,` in the name would be
 * reinterpreted as glob syntax instead of matched literally. Callers building
 * a watcher must use each directory as a literal URI/path base (as
 * `vscode.RelativePattern`'s first argument already is, never as part of its
 * glob `pattern` argument) and combine it only with `PACKAGE_LOCK`/
 * `SHRINKWRAP` — both fixed, developer-controlled constants — for the actual
 * glob, e.g. `{package-lock.json,npm-shrinkwrap.json}`.
 */
export function lockfileWatchDirs(dir: string): string[] {
  const dirs: string[] = [];
  let current = dir.replace(/\\/g, '/');
  for (;;) {
    dirs.push(current);
    if (current === '') break;
    const idx = current.lastIndexOf('/');
    current = idx === -1 ? '' : current.slice(0, idx);
  }
  return dirs;
}

/**
 * Every workspace-folder-relative path a lockfile topology change could
 * affect this project's resolved lockfile from — `lockfileWatchDirs(dir)`
 * crossed with both lockfile filenames. Useful for tests and for any caller
 * that just wants the full path list as data (never as a glob to build a
 * watcher from directly — see `lockfileWatchDirs`'s own doc for why).
 */
export function lockfileWatchPaths(dir: string): string[] {
  const paths: string[] = [];
  for (const candidateDir of lockfileWatchDirs(dir)) {
    const prefix = candidateDir === '' ? '' : `${candidateDir}/`;
    paths.push(`${prefix}${PACKAGE_LOCK}`, `${prefix}${SHRINKWRAP}`);
  }
  return paths;
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

/**
 * S6 — multi-root/monorepo project discovery, still the pure half.
 *
 * `vscode.workspace.findFiles` runs per WorkspaceFolder (a `RelativePattern`
 * is always scoped to exactly one), so the adapter supplies one raw manifest-
 * path list per folder; everything about combining them into a stable,
 * labelled, identifiable candidate list lives here.
 */

/** One WorkspaceFolder's raw findFiles output, plus enough to label and identify it. */
export interface ProjectCandidateSource {
  /** A stable string identity for the owning workspace folder — its URI string, not its display name (names are not guaranteed unique). */
  folderId: string;
  /** Display name of the workspace folder, for labels. */
  folderName: string;
  /** Raw manifest paths as returned by findFiles for this one folder, workspace-folder-relative. */
  manifestPaths: readonly string[];
}

export interface DiscoveredProjectCandidate {
  /** Deterministic identity — see deriveProjectId. Stable across scans as long as the folder and manifest path don't change. */
  id: string;
  folderId: string;
  folderName: string;
  /** Workspace-folder-relative POSIX path to package.json, e.g. "packages/app/package.json". */
  manifestPath: string;
  /** Directory holding it, relative to the workspace folder; "" for the folder root. */
  dir: string;
}

/**
 * Deterministic identity for a candidate, derived only from its owning
 * folder's identity and its manifest path — never from anything the webview
 * could influence, and stable across process restarts (unlike, say, an
 * array index). Two candidates with the same `dir`/`manifestPath` in
 * different workspace folders get different ids because `folderId` differs.
 *
 * Encoded as `JSON.stringify([folderId, manifestPath])` rather than a
 * delimiter-joined string: a plain `${folderId}::${manifestPath}` join is
 * ambiguous whenever either input can itself contain the delimiter —
 * `folderId = "file:///a::b"` + `manifestPath = "package.json"` and
 * `folderId = "file:///a"` + `manifestPath = "b::package.json"` would
 * otherwise collide on the identical string `"file:///a::b::package.json"`.
 * JSON-encoding the pair as a tuple keeps each element's own boundary
 * (quoting/escaping) with it, so no choice of delimiter can be defeated by
 * an input that happens to contain it.
 */
export function deriveProjectId(folderId: string, manifestPath: string): string {
  return JSON.stringify([folderId, manifestPath]);
}

/**
 * Whether a reload targeting `candidateId` is for the *same* project as
 * `previousSelectedId` — the deciding factor for whether a watcher event
 * queued during that reload's own disk read belongs to the project it just
 * finished reloading (drain it) or to whatever was selected *before* this
 * reload started (discard it, since it was never about the newly selected
 * project). `previousSelectedId` is `undefined` before any project has ever
 * been selected (a first-ever load), which is never "the same project" as
 * anything, by construction — there is nothing yet for a queued event to be
 * relevant to.
 *
 * Pulled out as its own pure function specifically so this one comparison —
 * the crux of dashboardPanel.ts's reloadAndScan() drain-vs-discard decision
 * — is unit-testable without a vscode host, the same way every other S6/S7
 * project-identity decision in this file already is.
 */
export function isSameProjectReload(previousSelectedId: string | undefined, candidateId: string): boolean {
  return previousSelectedId !== undefined && previousSelectedId === candidateId;
}

/**
 * A candidate's picker/header label. The workspace folder's name is always
 * included — not just the directory — because two different workspace
 * folders can easily contain the same relative path (e.g. both have
 * `packages/api/package.json`); the directory alone would be ambiguous.
 */
export function projectCandidateLabel(candidate: Pick<DiscoveredProjectCandidate, 'folderName' | 'dir'>): string {
  return candidate.dir === '' ? candidate.folderName : `${candidate.folderName} — ${candidate.dir}`;
}

/**
 * Combine every workspace folder's raw findFiles results into one ordered,
 * deduplicated, labelled candidate list — root-first then alphabetical
 * *within* each folder (via toProjectCandidates), folders themselves kept in
 * the order they were given (VS Code's own multi-root order).
 */
export function discoverProjectCandidates(
  sources: readonly ProjectCandidateSource[],
  excluded: readonly string[] = DEFAULT_EXCLUDED_DIRS
): DiscoveredProjectCandidate[] {
  const out: DiscoveredProjectCandidate[] = [];
  for (const source of sources) {
    for (const candidate of toProjectCandidates(source.manifestPaths, excluded)) {
      out.push({
        id: deriveProjectId(source.folderId, candidate.manifestPath),
        folderId: source.folderId,
        folderName: source.folderName,
        manifestPath: candidate.manifestPath,
        dir: candidate.dir,
      });
    }
  }
  return out;
}
