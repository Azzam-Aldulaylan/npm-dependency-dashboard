/**
 * npm invocation resolution for GUI-launched VS Code — see the spec's "npm
 * Binary Resolution" section. A GUI-launched process on macOS does not
 * inherit the interactive login shell's PATH, so nvm/fnm/Volta's shell-rc
 * PATH edits are invisible to the extension host even though `npm` works
 * fine in a terminal.
 *
 * This resolves a `node` executable + `npm-cli.js` PAIR, not a bare `npm`/
 * `npm.cmd` binary, and runs it as `<node> <npm-cli.js> install ...`:
 *   - On POSIX, `npm` is normally a `#!/usr/bin/env node` script — executing
 *     it directly relies on the OS resolving that shebang's `node` via PATH
 *     at run time, which is exactly the environment this resolver exists
 *     because it can't be trusted (see above). Resolving `node` ourselves and
 *     invoking `npm-cli.js` with it removes that indirection entirely.
 *   - On Windows, `npm.cmd` is a batch script; running a `.cmd` file as a
 *     child process (even via an argv-based API, not a shell string) still
 *     goes through `cmd.exe`'s own argument handling, which has its own
 *     escaping quirks and history of subtle argument-injection issues (e.g.
 *     CVE-2024-27980). `npm.cmd` is therefore never executed anywhere in
 *     this file, not even as a validation probe — see `validatePair`.
 *     `node.exe <npm-cli.js>` is a plain PE process — no batch/cmd layer.
 * `npm-cli.js` is npm's real entry point — `npm`/`npm.cmd` are themselves
 * thin wrappers that just do this same `node npm-cli.js` invocation.
 *
 * FINDING NPM-CLI.JS — NOT BY GUESSING A RELATIVE PATH FROM THE CANDIDATE:
 * A fixed relative path from the *candidate* `node`'s own directory
 * (`../lib/node_modules/npm/...` on POSIX) is wrong whenever the candidate
 * is a shim rather than a real install — Volta's `~/.volta/bin/node` (and
 * `~/.volta/bin/npm`) are shims with no `lib/node_modules` of their own;
 * they forward to whichever real Node install is pinned for the current
 * project. This resolver *asks* each candidate what it actually is, via
 * fixed, non-interpolated, non-shell probes (see `validatePair`), and the
 * derivation differs by platform because the only POSIX-safe technique
 * (asking a co-located `npm` wrapper) would mean executing `npm.cmd` on
 * Windows:
 *   - `<node> -p process.execPath` (both platforms) resolves through any
 *     shim/dispatch layer to node's real underlying executable. This is
 *     always required to succeed — a functional-health check — but its
 *     *result* is used differently:
 *       - Windows: the real path IS the derivation basis. Every official
 *         Windows Node.js distribution uses a flat layout — `node.exe` and
 *         `node_modules/npm/` are siblings — so `npm-cli.js` is derived as
 *         `<dirname(realNode)>/node_modules/npm/bin/npm-cli.js`, with no
 *         npm/npm.cmd execution anywhere in the process.
 *       - POSIX: the real path is only a validity check; the derivation
 *         itself asks npm's own wrapper (see next point), because the flat-
 *         relative-path assumption doesn't hold universally on POSIX (custom
 *         builds, some Linux packaging) the way it reliably does on Windows.
 *   - POSIX only: `<npm co-located with node> root -g` — every real Node.js
 *     layout (official tarballs, nvm, fnm, Homebrew, and Volta's own shim
 *     pair) puts an `npm` wrapper right beside `node` in the same directory,
 *     real or shimmed; running it is npm's own authoritative answer for
 *     where its global-package tree lives — `npm-cli.js` is that tree's own
 *     `npm` package: `<npm-root>/npm/bin/npm-cli.js`. This wrapper has a
 *     `#!/usr/bin/env node` shebang, resolved by searching the *child
 *     process's* PATH — left alone, that inherits the extension host's own
 *     PATH, which could put an unrelated (possibly broken) `node` ahead of
 *     the one this specific wrapper is meant to pair with (e.g. a broken
 *     Homebrew `node` earlier in PATH than the nvm install being validated).
 *     This probe therefore runs with the candidate's own directory prepended
 *     to `PATH` — an environment-variable override on a direct, non-shell
 *     `execFileSync` call, not a shell command, so nothing here is
 *     interpolated into text a shell would parse.
 * In every case the *candidate* path — not the resolved real path — is what
 * ends up in the returned `invocation.node`: a shim is deliberately kept as
 * the invocation target so Volta's own per-project version pinning, which
 * depends on the task's `cwd` at actual run time, keeps working.
 *
 * PROJECT-AWARE (cwd): every probe here runs with `cwd` set to the resolved
 * project root — the same value the eventual `vscode.Task`'s
 * `ProcessExecution` uses (see `createNodeNpmResolverDeps`'s call site in
 * upgradeRunner.ts) — so a Volta pin (which depends on the working
 * directory) resolves identically during validation and during the actual
 * task; validating against the extension host's own cwd could silently pick
 * a different pinned version than the one the task itself would run.
 *
 * Split for testability: `candidateNodePaths`, `resolveNpmInvocation`, and
 * `prependDirToPath` are pure — platform, PATH, home directory, directory
 * listing, existence/executability, both resolution probes, the version
 * probe, and the login-shell probe are all injected — so every platform/
 * version-manager/missing-npm/broken-install/shim scenario is covered by
 * offline tests with no real filesystem or process access.
 * `createNodeNpmResolverDeps` is the one impure adapter, wiring real fs/os/
 * child_process calls; it is intentionally thin and not itself unit-tested,
 * matching this repo's src/core (pure) vs src/host (adapter) split for
 * everything else.
 *
 * Node's path.win32/path.posix namespaces work on any host OS, so candidate
 * generation for a platform can be tested regardless of which OS the test
 * suite actually runs on.
 */

import { accessSync, constants as fsConstants, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import semver from 'semver';

function pathModuleFor(platform: NodeJS.Platform): typeof posixPath {
  return platform === 'win32' ? (win32Path as unknown as typeof posixPath) : posixPath;
}

function pathListDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function nodeBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/** Highest-semver-first version directory names, tolerant of an optional leading "v". */
function sortVersionDirsDescending(names: readonly string[]): string[] {
  return [...names]
    .filter((name) => semver.valid(name.replace(/^v/, '')) !== null)
    .sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')));
}

/**
 * Prepends `dir` to a PATH string for one specific child-process env, ahead
 * of whatever was already there — pure string math, no process involved.
 * Used to make the POSIX npm-wrapper probe's `env node` shebang resolve to
 * the candidate's own co-located node rather than an unrelated one earlier
 * in the extension host's inherited PATH.
 */
export function prependDirToPath(
  dir: string,
  platform: NodeJS.Platform,
  existingPath: string | undefined
): string {
  if (existingPath === undefined || existingPath.length === 0) return dir;
  return `${dir}${pathListDelimiter(platform)}${existingPath}`;
}

export interface CandidateEnv {
  platform: NodeJS.Platform;
  /** `process.env.PATH` — may be undefined in a stripped GUI-launch environment. */
  pathEnv: string | undefined;
  homeDir: string;
  /** `process.env.FNM_DIR`, when fnm's install location was customized. */
  fnmDirEnv: string | undefined;
  /** Returns entry names, or [] if the directory doesn't exist / isn't readable. */
  listDir: (dirPath: string) => string[];
}

function fnmBaseDirs(env: Pick<CandidateEnv, 'homeDir' | 'fnmDirEnv'>): string[] {
  const dirs: string[] = [];
  if (env.fnmDirEnv !== undefined && env.fnmDirEnv.length > 0) dirs.push(env.fnmDirEnv);
  // The three locations fnm has used as its own default across versions/
  // install methods: Homebrew's formula, the XDG-style Linux/newer-macOS
  // default, and the legacy dotfile default.
  dirs.push(`${env.homeDir}/Library/Application Support/fnm`);
  dirs.push(`${env.homeDir}/.local/share/fnm`);
  dirs.push(`${env.homeDir}/.fnm`);
  return [...new Set(dirs)];
}

function fnmCandidates(env: CandidateEnv, p: typeof posixPath, binName: string): string[] {
  const candidates: string[] = [];
  for (const base of fnmBaseDirs(env)) {
    // A default set via `fnm default <version>` — a symlink, present or not.
    candidates.push(p.join(base, 'aliases', 'default', 'bin', binName));
    // Modern fnm's actual install layout: node-versions/v<version>/installation/.
    // No default alias needed — every installed version is a candidate,
    // highest semver first, same tie-break as nvm below.
    const versionsDir = p.join(base, 'node-versions');
    for (const version of sortVersionDirsDescending(env.listDir(versionsDir))) {
      candidates.push(p.join(versionsDir, version, 'installation', 'bin', binName));
    }
  }
  return candidates;
}

/**
 * Ordered candidate absolute paths to a `node` executable. PATH is checked
 * first (already the common case when it works). Version-manager locations
 * follow, most specific/deterministic first — Volta has one stable shim
 * path; nvm and fnm require enumerating installed versions, broken ties by
 * highest semver so a multi-version install doesn't pick an arbitrary one;
 * Homebrew's two default prefixes are last, since an install not on PATH is
 * already an unusual setup. Every candidate here may turn out to be a shim
 * (Volta always is) — see `validatePair` for how that's handled safely.
 */
export function candidateNodePaths(env: CandidateEnv): string[] {
  const { platform, pathEnv, homeDir, listDir } = env;
  const p = pathModuleFor(platform);
  const binName = nodeBinaryName(platform);
  const candidates: string[] = [];

  const pathDirs = (pathEnv ?? '').split(pathListDelimiter(platform)).filter((d) => d.length > 0);
  for (const dir of pathDirs) candidates.push(p.join(dir, binName));

  if (platform === 'win32') {
    candidates.push(p.join('C:\\Program Files', 'nodejs', binName));
    candidates.push(p.join(homeDir, 'AppData', 'Roaming', 'npm', binName));
    return candidates;
  }

  // Volta: a shim lives directly here, no per-version subdirectory — see the
  // file header for why a shim is fine to include as a candidate.
  candidates.push(p.join(homeDir, '.volta', 'bin', binName));

  // nvm: enumerate ~/.nvm/versions/node/v*, highest semver wins the tie.
  const nvmVersionsDir = p.join(homeDir, '.nvm', 'versions', 'node');
  for (const version of sortVersionDirsDescending(listDir(nvmVersionsDir))) {
    candidates.push(p.join(nvmVersionsDir, version, 'bin', binName));
  }

  candidates.push(...fnmCandidates(env, p, binName));

  // Homebrew: Apple Silicon and Intel default prefixes.
  candidates.push(p.join('/opt/homebrew/bin', binName));
  candidates.push(p.join('/usr/local/bin', binName));

  return candidates;
}

/**
 * The login-shell probe's command is this fixed literal, always — no package
 * name, version, path, or setting is ever interpolated into it. `-l` makes it
 * a login shell (sources the rc files that set nvm/fnm/Volta's PATH), `-i`
 * makes it interactive (nvm's own PATH setup is often gated on interactivity),
 * `-c` runs the one fixed command. Probes for `node`, not `npm` — the actual
 * npm-cli.js location is then resolved the same way as every other
 * candidate, via `validatePair`, not by re-deriving anything from this
 * shell's own output.
 */
export const LOGIN_SHELL_PROBE_ARGS: readonly string[] = ['-lic', 'command -v node'];

/** The fixed, non-shell probe used to resolve a candidate's real underlying node executable. */
export const REAL_NODE_PATH_PROBE_ARGS: readonly string[] = ['-p', 'process.execPath'];

/** The fixed, non-shell probe used to resolve npm's own global-package root — POSIX only, run on the npm co-located with a node candidate, never on Windows. */
export const NPM_ROOT_PROBE_ARGS: readonly string[] = ['root', '-g'];

/** The fixed, non-shell probe used to validate a resolved (node, npm-cli.js) pair actually runs. */
export const NPM_VERSION_PROBE_ARG = '--version';

export interface NpmInvocation {
  node: string;
  npmCliJs: string;
}

export interface NpmResolverDeps extends CandidateEnv {
  /** The resolved project root — every probe below runs with this as its cwd. */
  cwd: string;
  exists: (path: string) => boolean;
  isExecutable: (path: string) => boolean;
  /**
   * Runs `<node> -p process.execPath` (fixed args, no shell, a timeout,
   * `cwd`) and returns the real path it printed, or undefined on failure/
   * empty output. Resolves through Volta's (or any) dispatch layer; a
   * plain, non-shimmed `node` just returns its own path. Required to
   * succeed on every platform; on Windows its result is also the basis for
   * deriving `npm-cli.js` (see the file header).
   */
  resolveRealNodePath: (node: string) => string | undefined;
  /**
   * POSIX only — never called for a Windows candidate (see `validatePair`).
   * Runs `<npm co-located with node> root -g` (fixed args, no shell, a
   * timeout, `cwd`, with `node`'s own directory prepended to `PATH` — see
   * `prependDirToPath`) and returns the printed global-modules directory, or
   * undefined if there's no co-located npm binary or the probe fails.
   * `npm-cli.js` lives at `<result>/npm/bin/npm-cli.js`.
   */
  resolveGlobalNpmRoot: (node: string) => string | undefined;
  /**
   * Runs `<node> <npmCliJs> --version` (argv array, no shell, a timeout,
   * `cwd`) and reports whether it succeeded. Existence and the executable
   * bit are necessary but not sufficient — a `node` that can't run this
   * specific `npm-cli.js` (version mismatch, a partially-removed install, a
   * stub) must be rejected, not accepted just because the files are
   * present.
   */
  probeVersion: (node: string, npmCliJs: string) => boolean;
  /** Absolute `node` path from the login-shell probe, or undefined if it found nothing. */
  probeLoginShellNode: () => string | undefined;
}

export type NpmResolutionResult = { ok: true; invocation: NpmInvocation } | { ok: false };

/**
 * Windows never calls `resolveGlobalNpmRoot` — that would mean executing
 * `npm.cmd`, a batch script, which this resolver does not do anywhere (see
 * the file header). Instead, `npm-cli.js` is derived directly from the real
 * node path's own directory, using the flat layout every official Windows
 * Node.js distribution actually uses.
 */
function validatePair(
  node: string,
  platform: NodeJS.Platform,
  deps: Pick<NpmResolverDeps, 'exists' | 'resolveRealNodePath' | 'resolveGlobalNpmRoot' | 'probeVersion'>
): NpmInvocation | undefined {
  const realNode = deps.resolveRealNodePath(node);
  if (realNode === undefined) return undefined;

  const p = pathModuleFor(platform);

  if (platform === 'win32') {
    const npmCliJs = p.join(p.dirname(realNode), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!deps.exists(npmCliJs)) return undefined;
    if (!deps.probeVersion(node, npmCliJs)) return undefined;
    return { node, npmCliJs };
  }

  const npmRoot = deps.resolveGlobalNpmRoot(node);
  if (npmRoot === undefined) return undefined;
  const npmCliJs = p.join(npmRoot, 'npm', 'bin', 'npm-cli.js');
  if (!deps.exists(npmCliJs)) return undefined;
  if (!deps.probeVersion(node, npmCliJs)) return undefined;

  return { node, npmCliJs };
}

/**
 * Every candidate — including a login-shell probe result — is validated
 * (node exists + executable, then the platform-appropriate derivation and
 * probes above) before being accepted, every call. Nothing is cached across
 * calls, so a resolution always reflects the current filesystem. A
 * candidate that exists but fails any of these (a shim with nothing behind
 * it, a broken or incompatible install) is skipped, not accepted —
 * resolution falls through to the next candidate.
 */
export function resolveNpmInvocation(deps: NpmResolverDeps): NpmResolutionResult {
  for (const node of candidateNodePaths(deps)) {
    if (!deps.exists(node) || !deps.isExecutable(node)) continue;
    const invocation = validatePair(node, deps.platform, deps);
    if (invocation !== undefined) return { ok: true, invocation };
  }

  if (deps.platform === 'win32') return { ok: false };

  const probedNode = deps.probeLoginShellNode();
  if (probedNode !== undefined && deps.exists(probedNode) && deps.isExecutable(probedNode)) {
    const invocation = validatePair(probedNode, deps.platform, deps);
    if (invocation !== undefined) return { ok: true, invocation };
  }
  return { ok: false };
}

function realIsExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realListDir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function runFixedProbe(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): string | undefined {
  try {
    const output = execFileSync(executable, [...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function realResolveRealNodePath(node: string, cwd: string): string | undefined {
  return runFixedProbe(node, REAL_NODE_PATH_PROBE_ARGS, { cwd });
}

/** POSIX only — see the file header for why this needs PATH prepended, and why Windows never calls this at all. */
function realResolveGlobalNpmRoot(node: string, platform: NodeJS.Platform, cwd: string): string | undefined {
  const p = pathModuleFor(platform);
  const nodeDir = p.dirname(node);
  const npmBin = p.join(nodeDir, 'npm'); // the co-located wrapper script — never npm.cmd, this path only runs on POSIX
  if (!existsSync(npmBin)) return undefined;
  const env = { ...process.env, PATH: prependDirToPath(nodeDir, platform, process.env['PATH']) };
  return runFixedProbe(npmBin, NPM_ROOT_PROBE_ARGS, { cwd, env });
}

function realProbeVersion(node: string, npmCliJs: string, cwd: string): boolean {
  return runFixedProbe(node, [npmCliJs, NPM_VERSION_PROBE_ARG], { cwd }) !== undefined;
}

function realProbeLoginShellNode(cwd: string): string | undefined {
  const shell = process.env['SHELL'] ?? '/bin/zsh';
  const output = runFixedProbe(shell, LOGIN_SHELL_PROBE_ARGS, { cwd });
  return output?.split('\n').pop()?.trim() || undefined;
}

/**
 * `cwd` should be the resolved project root — see the file header's
 * "PROJECT-AWARE" note. Called from UpgradeExecutionSession.run with the
 * same `params.cwd` the eventual task's ProcessExecution uses.
 */
export function createNodeNpmResolverDeps(cwd: string): NpmResolverDeps {
  const platform = process.platform;
  return {
    platform,
    pathEnv: process.env['PATH'],
    homeDir: homedir(),
    fnmDirEnv: process.env['FNM_DIR'],
    cwd,
    exists: existsSync,
    isExecutable: realIsExecutable,
    listDir: realListDir,
    resolveRealNodePath: (node) => realResolveRealNodePath(node, cwd),
    resolveGlobalNpmRoot: (node) => realResolveGlobalNpmRoot(node, platform, cwd),
    probeVersion: (node, npmCliJs) => realProbeVersion(node, npmCliJs, cwd),
    probeLoginShellNode: () => realProbeLoginShellNode(cwd),
  };
}
