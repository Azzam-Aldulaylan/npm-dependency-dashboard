import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const component = readFileSync(join(process.cwd(), 'webview/src/components/TransitiveFixReview.tsx'), 'utf8');
const overview = readFileSync(join(process.cwd(), 'webview/src/components/OverviewPanel.tsx'), 'utf8');
const vulnerabilities = readFileSync(join(process.cwd(), 'webview/src/components/VulnerabilitiesPanel.tsx'), 'utf8');
const vulnerabilityCard = readFileSync(join(process.cwd(), 'webview/src/components/VulnerabilityCard.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');
const protocol = readFileSync(join(process.cwd(), 'src/host/webviewProtocol.ts'), 'utf8');
const presentation = readFileSync(join(process.cwd(), 'src/host/transitiveRemediationPresentation.ts'), 'utf8');
const coordinator = readFileSync(join(process.cwd(), 'src/host/upgradeAssistantCoordinator.ts'), 'utf8');

test('one transitive fix review component serves Overview and Vulnerabilities', () => {
  assert.match(overview, /<TransitiveFixReview/);
  assert.match(vulnerabilities, /<TransitiveFixReview/);
  assert.doesNotMatch(vulnerabilities, /onChangeTab\('overview'\)/);
});

test('a fix must be reviewed before the apply action is exposed', () => {
  assert.match(component, /state\.reviewed \? \(/);
  assert.match(component, />\s*Review fix\s*</);
  assert.match(component, /plan\.outcome === 'partial' \? 'Apply partial fix' : 'Apply fix'/);
  assert.match(app, /state\.phase !== 'plan' \|\| !state\.reviewed/);
});

test('the review presents exact changes, security outcomes, and unchanged direct files', () => {
  assert.match(component, /change\.fromVersions/);
  assert.match(component, /change\.toVersions/);
  assert.match(component, /change\.affectedPaths/);
  assert.match(component, /title="Resolved"/);
  assert.match(component, /title="Still present"/);
  assert.match(component, /title="Introduced"/);
  assert.match(component, /plan\.files\.manifestChanged \? 'Changes' : 'Unchanged'/);
  assert.match(component, /plan\.files\.lockfileChanged \? 'Changes' : 'Unchanged'/);
  assert.match(component, /plan\.rootPackage.*plan\.currentVersion/s);
});

test('execution authority is limited to the opaque analysis id', () => {
  for (const type of ['confirm-remediation', 'cancel-remediation', 'retry-remediation']) {
    assert.match(protocol, new RegExp(`\\| \\{ type: '${type}'; analysisId: string \\}`));
  }
  assert.match(app, /postMessage\(\{ type: 'confirm-remediation', analysisId \}\)/);
  assert.match(app, /postMessage\(\{ type: 'cancel-remediation', analysisId \}\)/);
  assert.match(app, /postMessage\(\{ type: 'retry-remediation', analysisId \}\)/);
  assert.doesNotMatch(app, /type: 'confirm-remediation',[^}]+(?:target|path|version|package)/);
});

test('progress and terminal states keep recovery inside the manage workspace', () => {
  for (const copy of [
    'Preparing the reviewed lockfile change',
    'Installing the reviewed dependency tree',
    'Checking that the vulnerabilities are resolved',
    'Running project verification',
    'Restoring the previous dependency state',
    'Transitive fix applied and verified',
    'Partial transitive fix applied',
    'Changes rolled back',
    'Fix applied but not verified',
    'Recovery required',
  ]) {
    assert.match(component, new RegExp(copy));
  }
  assert.match(app, /phase: 'stale', plan, message: incoming\.message/);
  assert.match(app, /phase: 'result', plan, result: incoming\.result/);
  assert.match(component, /action: \{ label: 'Check again', onClick: onAnalyze/);
  assert.match(app, /state\.phase === 'applying' \|\| state\.phase === 'result'/);
  assert.match(overview, /hasEligibleTransitiveFix\(row\) \|\| remediation !== undefined/);
});

test('an older host response asks for a reload instead of offering a looping plan action', () => {
  const legacyBlock = component.match(/if \(state\.phase === 'legacy-result'\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  assert.match(legacyBlock, /Reload the Extension Development Host/);
  assert.doesNotMatch(legacyBlock, /Build fix plan/);
  assert.doesNotMatch(legacyBlock, /onAnalyze/);
});

test('resolved security impact exposes only clickable public vulnerability identifiers', () => {
  assert.match(component, /<VulnerabilityIdentifierLinks/);
  assert.match(component, /advisory\.affectedPaths\[0\]/);
  assert.match(presentation, /normalized\.startsWith\('CVE-'\)/);
  assert.match(presentation, /normalized\.startsWith\('GHSA-'\)/);
  assert.doesNotMatch(presentation, /normalized\.startsWith\('NPM:'\)/);
});

test('a completed fix re-check becomes a calm terminal state without another action', () => {
  assert.match(coordinator, /code: 'NO_REMEDIATION_NEEDED'/);
  assert.match(app, /incoming\.error\.code === 'NO_REMEDIATION_NEEDED'/);
  assert.match(app, /phase: 'not-needed'/);
  const notNeededBlock = component.match(/if \(state\.phase === 'not-needed'\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  assert.match(notNeededBlock, /No transitive fix needed/);
  assert.doesNotMatch(notNeededBlock, /action=/);
  assert.doesNotMatch(notNeededBlock, /button/);
});

test('the generic advisory source action is only a fallback when no public identifier exists', () => {
  assert.match(vulnerabilities, /identifiers\.length === 0 \? \([\s\S]*?View advisory source/);
  assert.match(vulnerabilityCard, /identifiers\.length === 0 \? \([\s\S]*?View advisory source/);
});
