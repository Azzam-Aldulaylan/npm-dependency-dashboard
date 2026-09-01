const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const vscode = require('vscode');

const TERMINAL_STATUSES = new Set(['empty', 'ready', 'partial-error']);
const POLL_MS = 50;
const HOST_TIMEOUT_MS = 60_000;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message, timeoutMs = HOST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await wait(POLL_MS);
  }
  throw new Error(`${message}. Last observed value: ${JSON.stringify(last)}`);
}

function terminalEvents(snapshot, afterSequence = 0) {
  return snapshot.messages
    .filter((event) => event.sequence > afterSequence)
    .filter((event) => TERMINAL_STATUSES.has(event.message.status));
}

function fatalEvents(snapshot, afterSequence = 0) {
  return snapshot.messages
    .filter((event) => event.sequence > afterSequence)
    .filter((event) => event.message.status === 'fatal-error');
}

function lastSequence(snapshot) {
  return snapshot.messages.at(-1)?.sequence ?? 0;
}

function eventsAfter(snapshot, sequence) {
  return snapshot.messages.filter((event) => event.sequence > sequence);
}

async function dispatchAfterRevalidation(api, message, completed) {
  let observed = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const beforeAction = lastSequence(api.dashboard.snapshot());
    await api.dashboard.dispatch(message);
    observed = eventsAfter(api.dashboard.snapshot(), beforeAction);
    const result = observed.findLast((event) => completed(event.message));
    if (result) return { result, observed };

    const revalidating = observed.findLast(
      (event) => event.message.error?.code === 'REVALIDATING'
    );
    if (!revalidating || attempt === 3) return { result: undefined, observed };
    await waitFor(
      () => terminalEvents(api.dashboard.snapshot(), revalidating.sequence).at(-1),
      'Dashboard did not finish revalidating before the action retry'
    );
  }
  return { result: undefined, observed };
}

async function run() {
  const packageManager = process.env['DEPENDENCY_DASHBOARD_FIXTURE_MANAGER'];
  const fixtureRoot = process.env['DEPENDENCY_DASHBOARD_FIXTURE_ROOT'];
  const reportPath = process.env['DEPENDENCY_DASHBOARD_HOST_REPORT'];
  const currentVersion = process.env['DEPENDENCY_DASHBOARD_FIXTURE_CURRENT_VERSION'];
  const upgradeVersion = process.env['DEPENDENCY_DASHBOARD_FIXTURE_UPGRADE_VERSION'];
  assert.ok(packageManager === 'npm' || packageManager === 'pnpm');
  assert.ok(fixtureRoot);
  assert.ok(reportPath);
  assert.ok(currentVersion);
  assert.ok(upgradeVersion);

  const extension = vscode.extensions.all.find(
    (candidate) => candidate.packageJSON && candidate.packageJSON.name === 'npm-dependency-dashboard'
  );
  assert.ok(extension, 'Dependency Dashboard extension was not loaded by the test host.');
  const api = await extension.activate();
  assert.ok(api && api.dashboard, 'The Extension Host test API was not returned during test activation.');

  const firstStarted = performance.now();
  await vscode.commands.executeCommand('dependencyDashboard.open');
  const first = await waitFor(
    () => terminalEvents(api.dashboard.snapshot()).at(-1),
    'Dashboard did not produce an initial terminal state'
  );
  const firstScanMs = performance.now() - firstStarted;
  let snapshot = api.dashboard.snapshot();
  assert.equal(snapshot.open, true);
  assert.equal(snapshot.disposed, false);
  assert.equal(snapshot.packageManager, packageManager);
  assert.equal(snapshot.selectedManifestPath, 'package.json');
  assert.ok(snapshot.panelId);
  const firstPanelId = snapshot.panelId;
  assert.equal(fatalEvents(snapshot).length, 0, 'Initial scan emitted a fatal error.');
  assert.ok(first.message.data, 'Initial terminal state did not carry dashboard data.');
  const rowNames = new Set(first.message.data.rows.map((row) => row.name));
  assert.ok(rowNames.has('is-number'), 'The real fixture dependency was not present in dashboard rows.');
  assert.ok(rowNames.has('kleur'), 'The real fixture dev dependency was not present in dashboard rows.');
  const upgradeRow = first.message.data.rows.find((row) => row.name === 'is-number');
  assert.equal(upgradeRow.current, currentVersion);
  assert.equal(upgradeRow.upgradeTo, upgradeVersion);
  await vscode.commands.executeCommand('dependencyDashboard.open');
  assert.equal(
    api.dashboard.snapshot().panelId,
    firstPanelId,
    'Opening the dashboard twice should reveal, not replace, the current panel.'
  );
  await assert.rejects(
    api.dashboard.dispatch({ type: 'not-a-real-dashboard-message' }),
    /rejected an invalid webview message/
  );

  let beforeAction = lastSequence(api.dashboard.snapshot());
  await api.dashboard.dispatch({ type: 'where-used', package: 'is-number' });
  let actionMessages = eventsAfter(api.dashboard.snapshot(), beforeAction);
  const usage = actionMessages.findLast(
    (event) => event.message.status === 'usage-result' && event.message.package === 'is-number'
  );
  assert.ok(usage, 'Where Used did not return a result for the real imported dependency.');
  assert.ok(
    usage.message.analysis.result.references.some((reference) => reference.filePath === 'index.mjs'),
    'Where Used did not find the fixture source import.'
  );

  beforeAction = lastSequence(api.dashboard.snapshot());
  await api.dashboard.dispatch({ type: 'analyze-cleanup' });
  actionMessages = eventsAfter(api.dashboard.snapshot(), beforeAction);
  const cleanup = actionMessages.findLast((event) => event.message.status === 'cleanup-result');
  assert.ok(cleanup, 'Smart Cleanup analysis did not return a result.');
  assert.ok(
    cleanup.message.findings.some(
      (finding) => finding.packageName === 'kleur' && finding.kind === 'likely-unused'
    ),
    'The intentionally unused fixture dependency was not reported as likely unused.'
  );
  assert.equal(
    cleanup.message.findings.some(
      (finding) => finding.packageName === 'is-number' && finding.kind === 'likely-unused'
    ),
    false,
    'The imported fixture dependency was incorrectly reported as unused.'
  );

  beforeAction = lastSequence(api.dashboard.snapshot());
  await api.dashboard.dispatch({
    type: 'analyze-removal-impact',
    requestId: 'host-removal-impact-1',
    packages: ['kleur'],
  });
  actionMessages = eventsAfter(api.dashboard.snapshot(), beforeAction);
  const removalImpact = actionMessages.findLast(
    (event) => event.message.status === 'removal-impact-result' && event.message.requestId === 'host-removal-impact-1'
  );
  assert.ok(removalImpact, 'Removal impact did not return a correlated result.');
  assert.equal(removalImpact.message.assessments.length, 1);
  assert.equal(removalImpact.message.assessments[0].packageName, 'kleur');

  const targetsOutcome = await dispatchAfterRevalidation(
    api,
    { type: 'load-upgrade-targets', package: 'is-number', requestId: 'host-targets-1' },
    (message) => message.status === 'upgrade-targets' && message.requestId === 'host-targets-1'
  );
  actionMessages = targetsOutcome.observed;
  const targets = targetsOutcome.result;
  assert.ok(
    targets,
    `Upgrade target discovery did not complete. Events: ${JSON.stringify(
      actionMessages.map((event) => event.message)
    )}`
  );
  assert.ok(
    targets.message.targets.options.some((option) => option.version === upgradeVersion),
    'The fixture upgrade version was not present in host-owned target options.'
  );

  const upgradeOutcome = await dispatchAfterRevalidation(
    api,
    {
      type: 'upgrade',
      package: 'is-number',
      target: upgradeVersion,
      requestId: 'host-upgrade-analysis-1',
    },
    (message) => message.status === 'upgrade-analysis' && message.requestId === 'host-upgrade-analysis-1'
  );
  actionMessages = upgradeOutcome.observed;
  const upgradeAnalysis = upgradeOutcome.result;
  assert.ok(
    upgradeAnalysis,
    `Upgrade Review did not return a completed analysis. Events: ${JSON.stringify(
      actionMessages.map((event) => event.message)
    )}`
  );
  assert.equal(upgradeAnalysis.message.analysis.currentVersion, currentVersion);
  assert.equal(upgradeAnalysis.message.analysis.targetVersion, upgradeVersion);
  await api.dashboard.dispatch({
    type: 'cancel-upgrade',
    analysisId: upgradeAnalysis.message.analysis.analysisId,
  });

  snapshot = api.dashboard.snapshot();
  const beforeRefresh = lastSequence(snapshot);
  const refreshStarted = performance.now();
  await vscode.commands.executeCommand('dependencyDashboard.refresh');
  const refreshed = await waitFor(
    () => terminalEvents(api.dashboard.snapshot(), beforeRefresh).at(-1),
    'Command-palette refresh did not finish'
  );
  const refreshMs = performance.now() - refreshStarted;
  assert.ok(refreshed.message.data.rows.length >= 2);
  snapshot = api.dashboard.snapshot();
  assert.equal(fatalEvents(snapshot, beforeRefresh).length, 0, 'Refresh emitted a fatal error.');

  const manifestPath = path.join(fixtureRoot, 'package.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const beforeWatcher = lastSequence(snapshot);
  await writeFile(manifestPath, manifestText.endsWith('\n') ? manifestText.slice(0, -1) : `${manifestText}\n`, 'utf8');
  await waitFor(
    () => terminalEvents(api.dashboard.snapshot(), beforeWatcher).at(-1),
    'Manifest watcher did not revalidate the dashboard'
  );
  snapshot = api.dashboard.snapshot();
  assert.equal(fatalEvents(snapshot, beforeWatcher).length, 0, 'Manifest revalidation emitted a fatal error.');

  const beforeSourceChange = lastSequence(snapshot);
  const sourcePath = path.join(fixtureRoot, 'index.mjs');
  const sourceText = await readFile(sourcePath, 'utf8');
  await writeFile(sourcePath, `${sourceText}\n// Extension Host source-watcher probe.\n`, 'utf8');
  await wait(900);
  snapshot = api.dashboard.snapshot();
  assert.equal(fatalEvents(snapshot, beforeSourceChange).length, 0, 'A source-only change emitted a fatal dashboard error.');

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(() => !api.dashboard.snapshot().open, 'Dashboard panel did not dispose after closing');

  const reopenStarted = performance.now();
  await vscode.commands.executeCommand('dependencyDashboard.open');
  const reopened = await waitFor(
    () => terminalEvents(api.dashboard.snapshot()).at(-1),
    'Reopened dashboard did not restore a terminal state'
  );
  const cachedReopenMs = performance.now() - reopenStarted;
  assert.ok(reopened.message.data.rows.some((row) => row.name === 'is-number'));
  assert.notEqual(api.dashboard.snapshot().panelId, firstPanelId, 'Reopening after disposal should create a new panel.');

  const soakStartedAt = Date.now();
  const soakMs = Number.parseInt(process.env['DEPENDENCY_DASHBOARD_HOST_SOAK_MS'] || '1500', 10);
  await wait(Number.isFinite(soakMs) && soakMs >= 0 ? soakMs : 1500);
  snapshot = api.dashboard.snapshot();
  assert.equal(snapshot.open, true, 'Dashboard closed during the result-retention soak.');
  assert.equal(fatalEvents(snapshot).length, 0, 'Dashboard emitted a fatal error during the result-retention soak.');
  const terminalAfterReopen = terminalEvents(snapshot).at(-1);
  assert.ok(terminalAfterReopen, 'Dashboard lost its terminal result during the result-retention soak.');

  const report = {
    packageManager,
    vscodeVersion: vscode.version,
    firstScanMs,
    refreshMs,
    cachedReopenMs,
    soakMs: Date.now() - soakStartedAt,
    rows: reopened.message.data.rows.length,
    finalStatus: terminalAfterReopen.message.status,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[dependency-dashboard] ${JSON.stringify(report)}`);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

module.exports = { run };
