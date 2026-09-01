import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const bundle = await build({
  entryPoints: ['webview/src/components/UpgradeAnalysisCards.tsx'],
  bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const { SecurityOutcomeCard } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=upgrade-security-card.fixture.js').toString('base64')}`);

function entry(severity, status = 'remains') {
  return {
    advisory: { id: `fixture-${severity}`, title: `${severity} finding`, severity, vulnerableVersions: '<2', url: 'https://example.invalid/advisory' },
    flaggedPackage: `child-${severity}`, patchedVersion: { status: 'known', version: '2.0.0' },
    path: ['next', `child-${severity}`], status, resolvedVersion: status === 'unknown' ? null : '1.0.0',
  };
}

function context(value) {
  const path = { nodes: value.path.map(packageName => ({ packageName, version: '1.0.0' })) };
  return {
    advisory: value.advisory, flaggedPackage: value.flaggedPackage, flaggedVersion: '1.0.0',
    patchedVersion: value.patchedVersion, primaryPath: path, paths: [path],
    directRoots: [{ packageName: 'next', version: '14.2.35' }], provenResolution: null,
  };
}

function render(security) {
  return renderToStaticMarkup(createElement(SecurityOutcomeCard, {
    row: { name: 'next' }, security, onChangeTab: () => {},
  }));
}

test('before/after disclosures belong to their labeled section and sort globally critical to info', () => {
  // Unknown critical findings must not fall below a confirmed low finding.
  const entries = [entry('low'), entry('critical', 'unknown'), entry('moderate'), entry('high'), entry('info')];
  const security = { status: 'remains', resolvedAdvisories: [], remaining: entries, contexts: entries.map(context) };
  const original = structuredClone(security);
  const html = render(security);
  const before = html.match(/<section[^>]+aria-labelledby="security-before-heading">(.*?)<\/section>/s)?.[1];
  const after = html.match(/<section[^>]+aria-labelledby="security-after-heading">(.*?)<\/section>/s)?.[1];
  assert.ok(before);
  assert.ok(after);
  assert.match(before, /Dependency paths and remediation evidence/);
  assert.doesNotMatch(before, /Inspect/);
  assert.match(after, /Inspect 4 remaining and 1 undetermined/);
  assert.doesNotMatch(after, /Dependency paths and remediation evidence/);
  for (const section of [before, after]) {
    const titles = [...section.matchAll(/<strong>(.*?) finding<\/strong>/g)].map(match => match[1]);
    assert.deepEqual(titles, ['critical', 'high', 'moderate', 'low', 'info']);
  }
  assert.match(after, /Undetermined — could not verify a fix/);
  assert.match(after, /Confirmed to remain/);
  assert.deepEqual(security, original, 'presentation sorting never mutates host evidence');
});

test('all-resolved and unavailable outcomes do not offer a misleading remaining disclosure', () => {
  const html = render({ status: 'resolved', resolvedAdvisories: [entry('high')], remaining: [], contexts: [] });
  assert.match(html, /1 known vulnerability/);
  assert.match(html, /0 vulnerabilities/);
  assert.doesNotMatch(html, /Inspect|<details/);
  assert.equal(render(null), '');
});
