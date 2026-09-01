import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';

import {
  createRealProjectFixture,
  FIXTURE_BASELINE_VERSION,
  FIXTURE_TARGET_VERSION,
} from './real-project-fixtures.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionTestsPath = path.join(repositoryRoot, 'scripts', 'integration', 'extension-host-suite.cjs');
const requestedManager = process.argv.find((argument) => argument.startsWith('--manager='))?.split('=')[1];
const managers = requestedManager === undefined ? ['npm', 'pnpm'] : [requestedManager];
const vscodeVersion = process.env['VSCODE_TEST_VERSION'] ?? 'stable';
const reports = [];

for (const packageManager of managers) {
  if (packageManager !== 'npm' && packageManager !== 'pnpm') {
    throw new Error(`Unsupported fixture package manager: ${packageManager}`);
  }
  // The host fixture starts one real release behind so Upgrade Review has an
  // actionable target.
  const fixture = await createRealProjectFixture(packageManager, {
    dependencyVersion: FIXTURE_BASELINE_VERSION,
  });
  const reportPath = path.join(fixture.root, 'extension-host-report.json');
  // macOS limits Unix-domain socket paths to 103 characters. Keep the
  // deliberately spaced workspace path, but give Electron a short profile.
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'dd-vsc-u-'));
  const extensionsDir = await mkdtemp(path.join(tmpdir(), 'dd-vsc-e-'));
  try {
    await runTests({
      version: vscodeVersion,
      extensionDevelopmentPath: repositoryRoot,
      extensionTestsPath,
      extensionTestsEnv: {
        // Electron rejects several Node-only flags inherited from developer
        // shells (notably --openssl-legacy-provider on VS Code 1.90).
        NODE_OPTIONS: '',
        DEPENDENCY_DASHBOARD_EXTENSION_TEST: '1',
        DEPENDENCY_DASHBOARD_FIXTURE_MANAGER: packageManager,
        DEPENDENCY_DASHBOARD_FIXTURE_ROOT: fixture.root,
        DEPENDENCY_DASHBOARD_FIXTURE_CURRENT_VERSION: FIXTURE_BASELINE_VERSION,
        DEPENDENCY_DASHBOARD_FIXTURE_UPGRADE_VERSION: FIXTURE_TARGET_VERSION,
        DEPENDENCY_DASHBOARD_HOST_REPORT: reportPath,
        DEPENDENCY_DASHBOARD_HOST_SOAK_MS: process.env['DEPENDENCY_DASHBOARD_HOST_SOAK_MS'] ?? '1500',
      },
      launchArgs: [
        fixture.root,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });
    reports.push(JSON.parse(await readFile(reportPath, 'utf8')));
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
    await rm(extensionsDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
}

console.log('Extension Host integration results');
for (const report of reports) {
  console.log(
    `${report.packageManager}: first scan ${report.firstScanMs.toFixed(0)} ms, ` +
    `refresh ${report.refreshMs.toFixed(0)} ms, cached reopen ${report.cachedReopenMs.toFixed(0)} ms, ` +
    `${report.rows} rows`
  );
}
