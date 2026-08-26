/**
 * The actual security boundary for the Upgrade action: whether a webview's
 * { package, target } request is allowed to become a real npm task. Every
 * rejection path here matters as much as the acceptance path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateUpgradeRequest, describeRejection } from '../out/core/upgrade/validate.js';

function row(overrides = {}) {
  return {
    name: 'left-pad',
    current: '1.0.0',
    wanted: '2.0.0',
    latest: '2.0.0',
    dev: false,
    advisories: [],
    worstSeverity: null,
    upgradeTo: '2.0.0',
    upgradeReason: 'update',
    ...overrides,
  };
}

function declared(overrides = {}) {
  return { name: 'left-pad', range: '^1.0.0', dev: false, optional: false, ...overrides };
}

// -------------------------------------------------------------- acceptance

test('a matching, eligible request is accepted with host-owned values', () => {
  const result = validateUpgradeRequest([row()], [declared()], {
    package: 'left-pad',
    target: '2.0.0',
  });
  assert.deepEqual(result, {
    ok: true,
    packageName: 'left-pad',
    currentVersion: '1.0.0',
    target: '2.0.0',
    classification: 'prod',
  });
});

test('classification is read from the manifest, not the request', () => {
  const rows = [row()];
  const devResult = validateUpgradeRequest(
    rows,
    [declared({ dev: true })],
    { package: 'left-pad', target: '2.0.0' }
  );
  assert.equal(devResult.ok, true);
  assert.equal(devResult.classification, 'dev');

  const optionalResult = validateUpgradeRequest(
    rows,
    [declared({ optional: true })],
    { package: 'left-pad', target: '2.0.0' }
  );
  assert.equal(optionalResult.ok, true);
  assert.equal(optionalResult.classification, 'optional');
});

test('optional wins over dev when a manifest entry is somehow both', () => {
  const result = validateUpgradeRequest(
    [row()],
    [declared({ dev: true, optional: true })],
    { package: 'left-pad', target: '2.0.0' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.classification, 'optional');
});

// -------------------------------------------------------------- rejections

test('no scan has completed yet: rows is undefined', () => {
  const result = validateUpgradeRequest(undefined, [declared()], {
    package: 'left-pad',
    target: '2.0.0',
  });
  assert.deepEqual(result, { ok: false, reason: 'no-scan-result' });
});

test('a package not present in the last scan is unknown', () => {
  const result = validateUpgradeRequest([row()], [declared()], {
    package: 'does-not-exist',
    target: '2.0.0',
  });
  assert.deepEqual(result, { ok: false, reason: 'unknown-package' });
});

test('a package with no eligible upgrade (null upgradeTo) is rejected', () => {
  const result = validateUpgradeRequest(
    [row({ upgradeTo: null })],
    [declared()],
    { package: 'left-pad', target: '2.0.0' }
  );
  assert.deepEqual(result, { ok: false, reason: 'no-eligible-upgrade' });
});

test('a target that does not exactly match the host-owned upgradeTo is stale', () => {
  const result = validateUpgradeRequest([row({ upgradeTo: '2.0.0' })], [declared()], {
    package: 'left-pad',
    target: '99.0.0',
  });
  assert.deepEqual(result, { ok: false, reason: 'stale-target' });
});

test('a forged request cannot pick an arbitrary version even for a real, eligible package', () => {
  // The row really is eligible for 2.0.0 — a forged request naming a
  // different version must still be refused, not "corrected" to 2.0.0.
  const result = validateUpgradeRequest([row({ upgradeTo: '2.0.0' })], [declared()], {
    package: 'left-pad',
    target: '2.0.0-evil',
  });
  assert.equal(result.ok, false);
});

test('a host-proven published target may differ from the dashboard default', () => {
  const result = validateUpgradeRequest(
    [row({ current: '1.0.0', upgradeTo: '3.0.0' })],
    [declared()],
    { package: 'left-pad', target: '2.0.0' },
    new Set(['2.0.0', '3.0.0'])
  );
  assert.deepEqual(result, {
    ok: true,
    packageName: 'left-pad',
    currentVersion: '1.0.0',
    target: '2.0.0',
    classification: 'prod',
  });
});

test('a selectable target still requires host proof and safe semver', () => {
  assert.equal(
    validateUpgradeRequest(
      [row({ upgradeTo: '3.0.0' })],
      [declared()],
      { package: 'left-pad', target: '2.0.0' },
      new Set(['2.1.0'])
    ).reason,
    'stale-target'
  );
  assert.equal(
    validateUpgradeRequest(
      [row({ upgradeTo: '3.0.0' })],
      [declared()],
      { package: 'left-pad', target: 'latest' },
      new Set(['latest'])
    ).reason,
    'unsafe-identifier'
  );
});

test('host publication proof can never authorize a downgrade or no-op target', () => {
  for (const target of ['1.0.0', '0.9.0']) {
    assert.deepEqual(
      validateUpgradeRequest(
        [row({ current: '1.0.0', upgradeTo: '3.0.0' })],
        [declared()],
        { package: 'left-pad', target },
        new Set([target])
      ),
      { ok: false, reason: 'no-eligible-upgrade' }
    );
  }
});

test('a row with no matching declared dependency is rejected defensively', () => {
  const result = validateUpgradeRequest([row()], [declared({ name: 'other-package' })], {
    package: 'left-pad',
    target: '2.0.0',
  });
  assert.deepEqual(result, { ok: false, reason: 'not-declared' });
});

test('an unsafe package name is rejected even if it otherwise matches', () => {
  const hostileRow = row({ name: 'pkg; rm -rf /' });
  const result = validateUpgradeRequest(
    [hostileRow],
    [declared({ name: 'pkg; rm -rf /' })],
    { package: 'pkg; rm -rf /', target: '2.0.0' }
  );
  assert.deepEqual(result, { ok: false, reason: 'unsafe-identifier' });
});

test('an unsafe version is rejected even if it otherwise matches', () => {
  const hostileRow = row({ upgradeTo: '$(whoami)' });
  const result = validateUpgradeRequest([hostileRow], [declared()], {
    package: 'left-pad',
    target: '$(whoami)',
  });
  assert.deepEqual(result, { ok: false, reason: 'unsafe-identifier' });
});

// ---------------------------------------------------------- describeRejection

test('every rejection reason has a non-empty, distinct description', () => {
  const reasons = [
    'no-scan-result',
    'unknown-package',
    'no-eligible-upgrade',
    'stale-target',
    'not-declared',
    'unsafe-identifier',
  ];
  const seen = new Set();
  for (const reason of reasons) {
    const { code, message } = describeRejection(reason);
    assert.ok(code.length > 0);
    assert.ok(message.length > 0);
    assert.ok(!seen.has(code), `duplicate code for ${reason}`);
    seen.add(code);
  }
});
