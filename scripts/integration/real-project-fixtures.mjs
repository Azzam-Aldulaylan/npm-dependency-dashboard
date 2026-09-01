import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const FIXTURE_DEPENDENCY = 'is-number';
export const FIXTURE_BASELINE_VERSION = '6.0.0';
export const FIXTURE_TARGET_VERSION = '7.0.0';
export const FIXTURE_DEV_DEPENDENCY = 'kleur';

const COMMAND_TIMEOUT_MS = 120_000;

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

export function packageManagerInvocation(packageManager) {
  if (packageManager === 'npm') return { command: executable('npm'), prefixArgs: [] };
  return { command: executable('pnpm'), prefixArgs: [] };
}

export function installArgs(packageManager) {
  return packageManager === 'npm'
    ? ['install', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['install', '--ignore-scripts', '--no-frozen-lockfile'];
}

export async function runCommand(command, args, options = {}) {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      // Windows cannot execute npm.cmd/pnpm.cmd directly; all arguments in
      // these fixtures are fixed test-owned values, so the command-shell
      // boundary does not include project-controlled input.
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-32_768); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      const result = { exitCode, stdout, stderr, durationMs: performance.now() - started };
      if (exitCode === 0 || options.allowFailure === true) resolve(result);
      else reject(new Error(`${command} ${args.join(' ')} failed (${exitCode}).\n${stderr || stdout}`));
    });
  });
}

export async function runPackageManager(packageManager, args, cwd) {
  const invocation = packageManagerInvocation(packageManager);
  return await runCommand(invocation.command, [...invocation.prefixArgs, ...args], { cwd });
}

export async function createRealProjectFixture(packageManager, options = {}) {
  const dependencyVersion = options.dependencyVersion ?? FIXTURE_BASELINE_VERSION;
  const root = await mkdtemp(path.join(tmpdir(), `dependency dashboard ${packageManager} `));
  const manifestPath = path.join(root, 'package.json');
  const lockfilePath = path.join(root, packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml');
  const manifest = {
    name: `dependency-dashboard-${packageManager}-fixture`,
    version: '1.0.0',
    private: true,
    ...(packageManager === 'pnpm' ? { packageManager: 'pnpm@11.19.0' } : {}),
    scripts: { verify: 'node verify.mjs' },
    dependencies: { [FIXTURE_DEPENDENCY]: dependencyVersion },
    devDependencies: { [FIXTURE_DEV_DEPENDENCY]: '4.1.5' },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(root, 'verify.mjs'),
    `import assert from 'node:assert/strict';\nimport isNumber from 'is-number';\nassert.equal(isNumber(42), true);\nassert.equal(isNumber('not-a-number'), false);\n`,
    'utf8'
  );
  await writeFile(
    path.join(root, 'index.mjs'),
    `import isNumber from 'is-number';\nexport const acceptsNumber = (value) => isNumber(value);\n`,
    'utf8'
  );

  const install = await runPackageManager(packageManager, installArgs(packageManager), root);
  const baselineManifest = await readFile(manifestPath);
  const baselineLockfile = await readFile(lockfilePath);
  return {
    packageManager,
    root,
    manifestPath,
    lockfilePath,
    baselineManifest,
    baselineLockfile,
    setupDurationMs: install.durationMs,
    cleanup: async () => {
      if (process.env['DEPENDENCY_DASHBOARD_KEEP_FIXTURES'] !== '1') {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
