/**
 * npm invocation resolution, fully offline: platform, PATH, home directory,
 * FNM_DIR, cwd, directory listing, existence/executability, both resolution
 * probes (`node -p process.execPath`, POSIX-only `npm root -g`), the
 * `--version` probe, and the login-shell probe are all injected, so POSIX/
 * macOS/Windows/missing-npm/broken-install/shim scenarios are all exercised
 * without touching the real filesystem or spawning a real process — and
 * without needing to run on each OS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateNodePaths,
  resolveNpmInvocation,
  prependDirToPath,
  createNodeNpmResolverDeps,
  LOGIN_SHELL_PROBE_ARGS,
  REAL_NODE_PATH_PROBE_ARGS,
  NPM_ROOT_PROBE_ARGS,
  NPM_VERSION_PROBE_ARG,
} from '../out/host/npmResolver.js';

const HOME_POSIX = '/Users/dev';
const HOME_WIN = 'C:\\Users\\dev';
const PROJECT_CWD = '/Users/dev/projects/my-app';

function noopListDir() {
  return [];
}

// ------------------------------------------------------------- candidates

test('PATH entries are checked first, in order', () => {
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '/usr/bin:/opt/homebrew/bin',
    homeDir: HOME_POSIX,
    fnmDirEnv: undefined,
    listDir: noopListDir,
  });
  assert.equal(candidates[0], '/usr/bin/node');
  assert.equal(candidates[1], '/opt/homebrew/bin/node');
});

test('an empty or undefined PATH does not crash candidate generation', () => {
  assert.doesNotThrow(() => {
    candidateNodePaths({ platform: 'darwin', pathEnv: undefined, homeDir: HOME_POSIX, fnmDirEnv: undefined, listDir: noopListDir });
    candidateNodePaths({ platform: 'darwin', pathEnv: '', homeDir: HOME_POSIX, fnmDirEnv: undefined, listDir: noopListDir });
  });
});

test('Volta has one stable candidate path, no version subdirectory', () => {
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: undefined,
    listDir: noopListDir,
  });
  assert.ok(candidates.includes(`${HOME_POSIX}/.volta/bin/node`));
});

test('nvm candidates are generated from installed versions, highest semver first', () => {
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: undefined,
    listDir: (dir) => {
      if (dir === `${HOME_POSIX}/.nvm/versions/node`) return ['v18.19.0', 'v20.11.0', 'v16.2.0'];
      return [];
    },
  });
  const nvmCandidates = candidates.filter((c) => c.includes('.nvm/versions/node'));
  assert.deepEqual(nvmCandidates, [
    `${HOME_POSIX}/.nvm/versions/node/v20.11.0/bin/node`,
    `${HOME_POSIX}/.nvm/versions/node/v18.19.0/bin/node`,
    `${HOME_POSIX}/.nvm/versions/node/v16.2.0/bin/node`,
  ]);
});

test('nvm ignores non-version directory entries rather than guessing', () => {
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: undefined,
    listDir: (dir) => (dir === `${HOME_POSIX}/.nvm/versions/node` ? ['node_modules', '.DS_Store'] : []),
  });
  assert.ok(!candidates.some((c) => c.includes('node_modules/bin')));
  assert.ok(!candidates.some((c) => c.includes('.DS_Store')));
});

test('fnm checks every known default-install base directory for an aliases/default symlink', () => {
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: undefined,
    listDir: noopListDir,
  });
  assert.ok(candidates.includes(`${HOME_POSIX}/Library/Application Support/fnm/aliases/default/bin/node`));
  assert.ok(candidates.includes(`${HOME_POSIX}/.local/share/fnm/aliases/default/bin/node`));
  assert.ok(candidates.includes(`${HOME_POSIX}/.fnm/aliases/default/bin/node`));
});

test('fnm enumerates the modern node-versions/<version>/installation layout, highest semver first, no default alias needed', () => {
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: undefined,
    listDir: (dir) =>
      dir === `${HOME_POSIX}/.local/share/fnm/node-versions` ? ['v18.19.0', 'v20.11.0'] : [],
  });
  const modern = candidates.filter((c) => c.includes('node-versions'));
  assert.deepEqual(modern, [
    `${HOME_POSIX}/.local/share/fnm/node-versions/v20.11.0/installation/bin/node`,
    `${HOME_POSIX}/.local/share/fnm/node-versions/v18.19.0/installation/bin/node`,
  ]);
});

test('FNM_DIR, when set, is checked and takes priority over the built-in default locations', () => {
  const customFnmDir = '/custom/fnm-home';
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: customFnmDir,
    listDir: noopListDir,
  });
  assert.ok(candidates.includes(`${customFnmDir}/aliases/default/bin/node`));
  const fnmCandidates = candidates.filter((c) => c.includes('fnm'));
  assert.equal(fnmCandidates.indexOf(`${customFnmDir}/aliases/default/bin/node`), 0, 'FNM_DIR is checked before the built-in defaults');
});

test('a duplicate base directory (FNM_DIR matching a built-in default) is not checked twice', () => {
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: `${HOME_POSIX}/.fnm`,
    listDir: noopListDir,
  });
  const occurrences = candidates.filter((c) => c === `${HOME_POSIX}/.fnm/aliases/default/bin/node`);
  assert.equal(occurrences.length, 1);
});

test('Homebrew Apple Silicon and Intel prefixes are both checked', () => {
  const candidates = candidateNodePaths({
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: undefined,
    listDir: noopListDir,
  });
  assert.ok(candidates.includes('/opt/homebrew/bin/node'));
  assert.ok(candidates.includes('/usr/local/bin/node'));
});

test('linux uses the same POSIX candidate set (no win32-only entries)', () => {
  const candidates = candidateNodePaths({
    platform: 'linux',
    pathEnv: '/usr/bin',
    homeDir: '/home/dev',
    fnmDirEnv: undefined,
    listDir: noopListDir,
  });
  assert.ok(candidates.includes('/home/dev/.volta/bin/node'));
  assert.ok(!candidates.some((c) => c.endsWith('.exe')));
});

test('windows candidates use node.exe and win32 path joining, not version-manager paths', () => {
  const candidates = candidateNodePaths({
    platform: 'win32',
    pathEnv: 'C:\\nodejs;C:\\Windows\\System32',
    homeDir: HOME_WIN,
    fnmDirEnv: undefined,
    listDir: noopListDir,
  });
  assert.ok(candidates.every((c) => c.endsWith('node.exe')));
  assert.ok(candidates.includes('C:\\nodejs\\node.exe'));
  assert.ok(candidates.includes(`${HOME_WIN}\\AppData\\Roaming\\npm\\node.exe`));
  assert.ok(!candidates.some((c) => c.includes('.volta') || c.includes('fnm') || c.includes('nvm')));
});

// --------------------------------------------------------------- resolution

function baseDeps(overrides = {}) {
  return {
    platform: 'darwin',
    pathEnv: '',
    homeDir: HOME_POSIX,
    fnmDirEnv: undefined,
    cwd: PROJECT_CWD,
    listDir: noopListDir,
    exists: () => false,
    isExecutable: () => false,
    resolveRealNodePath: () => undefined,
    resolveGlobalNpmRoot: () => undefined,
    probeVersion: () => false,
    probeLoginShellNode: () => undefined,
    ...overrides,
  };
}

test('POSIX: the first candidate that passes every check wins', () => {
  const node = `${HOME_POSIX}/.nvm/versions/node/v20.11.0/bin/node`;
  const npmRoot = `${HOME_POSIX}/.nvm/versions/node/v20.11.0/lib/node_modules`;
  const npmCliJs = `${npmRoot}/npm/bin/npm-cli.js`;

  const result = resolveNpmInvocation(
    baseDeps({
      listDir: (dir) => (dir === `${HOME_POSIX}/.nvm/versions/node` ? ['v20.11.0'] : []),
      exists: (p) => p === node || p === npmCliJs,
      isExecutable: (p) => p === node,
      resolveRealNodePath: (n) => (n === node ? node : undefined),
      resolveGlobalNpmRoot: (n) => (n === node ? npmRoot : undefined),
      probeVersion: (n, cli) => n === node && cli === npmCliJs,
    })
  );

  assert.deepEqual(result, { ok: true, invocation: { node, npmCliJs } });
});

test('a node that exists but is not executable is skipped', () => {
  const node = '/usr/local/bin/node';
  const result = resolveNpmInvocation(baseDeps({ exists: (p) => p === node, isExecutable: () => false }));
  assert.deepEqual(result, { ok: false });
});

test('a node whose real-path probe fails (a shim with nothing behind it) is skipped', () => {
  const node = '/usr/local/bin/node';
  const result = resolveNpmInvocation(
    baseDeps({
      exists: (p) => p === node,
      isExecutable: (p) => p === node,
      resolveRealNodePath: () => undefined,
    })
  );
  assert.deepEqual(result, { ok: false });
});

test('POSIX: a node whose co-located npm cannot answer `root -g` is skipped', () => {
  const node = '/usr/local/bin/node';
  const result = resolveNpmInvocation(
    baseDeps({
      exists: (p) => p === node,
      isExecutable: (p) => p === node,
      resolveRealNodePath: (n) => n,
      resolveGlobalNpmRoot: () => undefined,
    })
  );
  assert.deepEqual(result, { ok: false });
});

test('existence and the executable bit are not sufficient: a failing version probe is skipped too', () => {
  const node = '/usr/local/bin/node';
  const npmRoot = '/usr/local/lib/node_modules';
  const npmCliJs = `${npmRoot}/npm/bin/npm-cli.js`;
  const result = resolveNpmInvocation(
    baseDeps({
      exists: (p) => p === node || p === npmCliJs,
      isExecutable: (p) => p === node,
      resolveRealNodePath: (n) => n,
      resolveGlobalNpmRoot: (n) => (n === node ? npmRoot : undefined),
      probeVersion: () => false,
    })
  );
  assert.deepEqual(result, { ok: false });
});

// ----------------------------------------------------- Windows: never npm.cmd

test('windows resolution never calls resolveGlobalNpmRoot — npm.cmd is never invoked', () => {
  let called = false;
  const node = 'C:\\nodejs\\node.exe';
  const npmCliJs = 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

  const result = resolveNpmInvocation(
    baseDeps({
      platform: 'win32',
      homeDir: HOME_WIN,
      pathEnv: 'C:\\nodejs',
      cwd: 'C:\\project',
      exists: (p) => p === node || p === npmCliJs,
      isExecutable: (p) => p === node,
      resolveRealNodePath: (n) => (n === node ? node : undefined),
      resolveGlobalNpmRoot: () => {
        called = true;
        return undefined;
      },
      probeVersion: (n, cli) => n === node && cli === npmCliJs,
    })
  );

  assert.deepEqual(result, { ok: true, invocation: { node, npmCliJs } });
  assert.equal(called, false, 'resolveGlobalNpmRoot (which would run npm.cmd) must never be called on Windows');
});

test('windows derives npm-cli.js from the *real* resolved node path, using the flat official-installer layout', () => {
  // The candidate is a shim (e.g. a Windows Volta install, found via PATH —
  // candidateNodePaths has no Windows-specific version-manager locations,
  // only PATH + the two fixed system locations); the real node it
  // dispatches to lives elsewhere. Derivation must use the REAL path's
  // directory, not the shim's own — mirroring the POSIX Volta fix.
  const shimNode = 'C:\\Users\\dev\\.volta\\bin\\node.exe';
  const realNode = 'C:\\Users\\dev\\.volta\\tools\\image\\node\\20.11.0\\node.exe';
  const npmCliJs = 'C:\\Users\\dev\\.volta\\tools\\image\\node\\20.11.0\\node_modules\\npm\\bin\\npm-cli.js';
  const wrongGuess = 'C:\\Users\\dev\\.volta\\bin\\node_modules\\npm\\bin\\npm-cli.js';

  const result = resolveNpmInvocation(
    baseDeps({
      platform: 'win32',
      homeDir: HOME_WIN,
      pathEnv: 'C:\\Users\\dev\\.volta\\bin',
      cwd: 'C:\\project',
      exists: (p) => p === shimNode || p === npmCliJs,
      isExecutable: (p) => p === shimNode,
      resolveRealNodePath: (n) => (n === shimNode ? realNode : undefined),
      probeVersion: (n, cli) => n === shimNode && cli === npmCliJs,
    })
  );

  assert.deepEqual(result, { ok: true, invocation: { node: shimNode, npmCliJs } });
  assert.notEqual(result.invocation.npmCliJs, wrongGuess);
});

test('windows: a node whose real-path probe fails never reaches npm-cli.js derivation at all', () => {
  let resolveGlobalNpmRootCalled = false;
  const node = 'C:\\nodejs\\node.exe';
  const result = resolveNpmInvocation(
    baseDeps({
      platform: 'win32',
      homeDir: HOME_WIN,
      pathEnv: 'C:\\nodejs',
      cwd: 'C:\\project',
      exists: (p) => p === node,
      isExecutable: (p) => p === node,
      resolveRealNodePath: () => undefined,
      resolveGlobalNpmRoot: () => {
        resolveGlobalNpmRootCalled = true;
        return undefined;
      },
    })
  );
  assert.deepEqual(result, { ok: false });
  assert.equal(resolveGlobalNpmRootCalled, false);
});

// ---------------------------------------------------- version-manager regressions

test('regression: a Volta shim resolves correctly via the two probes, not via a relative-path guess', () => {
  // Volta's node is a shim: no lib/node_modules of its own. The real
  // underlying node (and npm's global root) live somewhere else entirely —
  // this is exactly what a relative-path-based derivation gets wrong. The
  // *original shim path* must still be the returned invocation target (see
  // the file header on why), even though the probes resolve through it to a
  // different real location to find npm-cli.js.
  const shimNode = `${HOME_POSIX}/.volta/bin/node`;
  const shimNpm = `${HOME_POSIX}/.volta/bin/npm`; // co-located, used internally to run `root -g`
  const realNode = `${HOME_POSIX}/.volta/tools/image/node/20.11.0/bin/node`;
  const npmRoot = `${HOME_POSIX}/.volta/tools/image/node/20.11.0/lib/node_modules`;
  const npmCliJs = `${npmRoot}/npm/bin/npm-cli.js`;
  const wrongGuess = `${HOME_POSIX}/.volta/lib/node_modules/npm/bin/npm-cli.js`;

  const result = resolveNpmInvocation(
    baseDeps({
      exists: (p) => p === shimNode || p === shimNpm || p === npmCliJs,
      isExecutable: (p) => p === shimNode,
      resolveRealNodePath: (n) => (n === shimNode ? realNode : undefined),
      resolveGlobalNpmRoot: (n) => (n === shimNode ? npmRoot : undefined),
      probeVersion: (n, cli) => n === shimNode && cli === npmCliJs,
    })
  );

  assert.deepEqual(result, { ok: true, invocation: { node: shimNode, npmCliJs } });
  assert.notEqual(result.invocation.npmCliJs, wrongGuess);
});

test('regression: modern fnm (node-versions/<version>/installation, no default alias) resolves', () => {
  const node = `${HOME_POSIX}/.local/share/fnm/node-versions/v20.11.0/installation/bin/node`;
  const npmRoot = `${HOME_POSIX}/.local/share/fnm/node-versions/v20.11.0/installation/lib/node_modules`;
  const npmCliJs = `${npmRoot}/npm/bin/npm-cli.js`;

  const result = resolveNpmInvocation(
    baseDeps({
      listDir: (dir) =>
        dir === `${HOME_POSIX}/.local/share/fnm/node-versions` ? ['v20.11.0'] : [],
      exists: (p) => p === node || p === npmCliJs,
      isExecutable: (p) => p === node,
      resolveRealNodePath: (n) => (n === node ? node : undefined),
      resolveGlobalNpmRoot: (n) => (n === node ? npmRoot : undefined),
      probeVersion: (n, cli) => n === node && cli === npmCliJs,
    })
  );

  assert.deepEqual(result, { ok: true, invocation: { node, npmCliJs } });
});

test('regression: FNM_DIR-based modern fnm layout resolves', () => {
  const fnmDir = '/custom/fnm-home';
  const node = `${fnmDir}/node-versions/v18.19.0/installation/bin/node`;
  const npmRoot = `${fnmDir}/node-versions/v18.19.0/installation/lib/node_modules`;
  const npmCliJs = `${npmRoot}/npm/bin/npm-cli.js`;

  const result = resolveNpmInvocation(
    baseDeps({
      fnmDirEnv: fnmDir,
      listDir: (dir) => (dir === `${fnmDir}/node-versions` ? ['v18.19.0'] : []),
      exists: (p) => p === node || p === npmCliJs,
      isExecutable: (p) => p === node,
      resolveRealNodePath: (n) => (n === node ? node : undefined),
      resolveGlobalNpmRoot: (n) => (n === node ? npmRoot : undefined),
      probeVersion: (n, cli) => n === node && cli === npmCliJs,
    })
  );

  assert.deepEqual(result, { ok: true, invocation: { node, npmCliJs } });
});

test('regression: GUI PATH puts a broken Homebrew node first — resolution falls through to a working absolute nvm node/npm', () => {
  // Models the extension host's inherited PATH listing a broken Homebrew
  // node before an nvm install even gets a chance: Homebrew's node exists,
  // is executable, and even resolves a real path — but its co-located npm
  // wrapper can't answer `root -g` (the scenario the PATH-prepending fix in
  // realResolveGlobalNpmRoot exists for: without it, a poisoned PATH could
  // make the wrapper's `env node` shebang pick the wrong node entirely).
  // The nvm candidate, listed later, must still resolve successfully.
  const homebrewNode = '/opt/homebrew/bin/node';
  const nvmNode = `${HOME_POSIX}/.nvm/versions/node/v20.11.0/bin/node`;
  const nvmNpmRoot = `${HOME_POSIX}/.nvm/versions/node/v20.11.0/lib/node_modules`;
  const nvmNpmCliJs = `${nvmNpmRoot}/npm/bin/npm-cli.js`;

  const result = resolveNpmInvocation(
    baseDeps({
      pathEnv: '/opt/homebrew/bin', // the "broken Homebrew node earlier in PATH" the GUI process inherited
      listDir: (dir) => (dir === `${HOME_POSIX}/.nvm/versions/node` ? ['v20.11.0'] : []),
      exists: (p) => [homebrewNode, nvmNode, nvmNpmCliJs].includes(p),
      isExecutable: (p) => p === homebrewNode || p === nvmNode,
      resolveRealNodePath: (n) => n, // both resolve fine on their own
      resolveGlobalNpmRoot: (n) => (n === nvmNode ? nvmNpmRoot : undefined), // Homebrew's wrapper can't answer
      probeVersion: (n, cli) => n === nvmNode && cli === nvmNpmCliJs,
    })
  );

  assert.deepEqual(result, { ok: true, invocation: { node: nvmNode, npmCliJs: nvmNpmCliJs } });
});

// ------------------------------------------------------- login-shell fallback

test('when nothing on disk matches, the login-shell probe is tried (POSIX only)', () => {
  const probedNode = '/Users/dev/.custom/bin/node';
  const npmRoot = '/Users/dev/.custom/lib/node_modules';
  const npmCliJs = `${npmRoot}/npm/bin/npm-cli.js`;

  const result = resolveNpmInvocation(
    baseDeps({
      exists: (p) => p === probedNode || p === npmCliJs,
      isExecutable: (p) => p === probedNode,
      resolveRealNodePath: (n) => (n === probedNode ? probedNode : undefined),
      resolveGlobalNpmRoot: (n) => (n === probedNode ? npmRoot : undefined),
      probeVersion: (n, cli) => n === probedNode && cli === npmCliJs,
      probeLoginShellNode: () => probedNode,
    })
  );

  assert.deepEqual(result, { ok: true, invocation: { node: probedNode, npmCliJs } });
});

test('a probed node that fails validation is not accepted', () => {
  const probedNode = '/nonexistent/node';
  const result = resolveNpmInvocation(baseDeps({ probeLoginShellNode: () => probedNode }));
  assert.deepEqual(result, { ok: false });
});

test('when nothing resolves at all, the result is a clean not-found, not a throw', () => {
  const result = resolveNpmInvocation(baseDeps());
  assert.deepEqual(result, { ok: false });
});

test('windows never falls back to a login-shell probe', () => {
  let probed = false;
  const result = resolveNpmInvocation(
    baseDeps({
      platform: 'win32',
      homeDir: HOME_WIN,
      cwd: 'C:\\project',
      probeLoginShellNode: () => {
        probed = true;
        return undefined;
      },
    })
  );
  assert.deepEqual(result, { ok: false });
  assert.equal(probed, false);
});

// --------------------------------------------------------- PATH prepending

test('prependDirToPath puts the given directory first, ahead of whatever PATH already had', () => {
  assert.equal(
    prependDirToPath(`${HOME_POSIX}/.nvm/versions/node/v20.11.0/bin`, 'darwin', '/opt/homebrew/bin:/usr/bin'),
    `${HOME_POSIX}/.nvm/versions/node/v20.11.0/bin:/opt/homebrew/bin:/usr/bin`
  );
});

test('prependDirToPath uses the platform-correct delimiter', () => {
  assert.equal(prependDirToPath('C:\\nodejs', 'win32', 'C:\\Windows'), 'C:\\nodejs;C:\\Windows');
});

test('prependDirToPath with no existing PATH is just the directory itself', () => {
  assert.equal(prependDirToPath('/a/b', 'darwin', undefined), '/a/b');
  assert.equal(prependDirToPath('/a/b', 'darwin', ''), '/a/b');
});

// ------------------------------------------------------------------ cwd

test('createNodeNpmResolverDeps carries the given cwd through to the returned deps', () => {
  const deps = createNodeNpmResolverDeps(PROJECT_CWD);
  assert.equal(deps.cwd, PROJECT_CWD);
});

test('createNodeNpmResolverDeps with a different cwd reflects that value, not a cached one', () => {
  const first = createNodeNpmResolverDeps('/project/a');
  const second = createNodeNpmResolverDeps('/project/b');
  assert.equal(first.cwd, '/project/a');
  assert.equal(second.cwd, '/project/b');
});

// ------------------------------------------------------- probes are fixed literals

test('the login-shell probe command is a fixed literal with no interpolation', () => {
  assert.deepEqual([...LOGIN_SHELL_PROBE_ARGS], ['-lic', 'command -v node']);
});

test('the real-node-path probe args are a fixed literal', () => {
  assert.deepEqual([...REAL_NODE_PATH_PROBE_ARGS], ['-p', 'process.execPath']);
});

test('the npm-root probe args are a fixed literal', () => {
  assert.deepEqual([...NPM_ROOT_PROBE_ARGS], ['root', '-g']);
});

test('the version probe argument is a fixed literal', () => {
  assert.equal(NPM_VERSION_PROBE_ARG, '--version');
});
