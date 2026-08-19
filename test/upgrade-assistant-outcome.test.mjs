import assert from 'node:assert/strict';
import test from 'node:test';

import { describeRemoveTransactionOutcome, describeUpgradeTransactionOutcome } from '../out/host/upgradeAssistantOutcome.js';

const succeededSnapshot = { status: 'succeeded', paths: ['/workspace/package.json'] };
const succeededInstall = { status: 'succeeded' };

function result(overrides = {}) {
  return {
    completion: 'kept',
    reason: 'verified',
    snapshot: succeededSnapshot,
    manifestStage: { status: 'not-run' },
    install: succeededInstall,
    verification: { status: 'passed', checks: [] },
    rollback: { status: 'not-needed' },
    retentionDecision: 'not-needed',
    ...overrides,
  };
}

test('verified and unverified kept upgrades remain clearly distinct', () => {
  assert.deepEqual(describeUpgradeTransactionOutcome('react', 'npm', result()), {
    kind: 'verified',
    message: 'Upgraded react; verification passed.',
  });
  assert.deepEqual(
    describeUpgradeTransactionOutcome(
      'react',
      'npm',
      result({
        reason: 'verification-not-configured',
        verification: { status: 'not-run', reason: 'not-configured' },
      })
    ),
    {
      kind: 'unverified',
      message: 'Upgraded react, but the application upgrade is not verified.',
    }
  );
});

test('successful rollback says only dependency files were restored and gives the package-manager reconcile command', () => {
  const presentation = describeUpgradeTransactionOutcome(
    'react',
    'pnpm',
    result({
      completion: 'rolled-back',
      reason: 'install-failed',
      install: { status: 'failed', code: 'TASK_FAILED', message: 'install failed' },
      verification: { status: 'not-run', reason: 'install-failed' },
      rollback: { status: 'succeeded', files: [{ path: '/workspace/package.json', status: 'restored' }] },
      retentionDecision: 'not-needed',
    })
  );

  assert.equal(presentation.kind, 'rolled-back');
  assert.equal(
    presentation.message,
    'Dependency files for react were restored to their pre-upgrade state. ' +
      'node_modules was not restored; run pnpm install to reconcile installed packages with the restored lockfile.'
  );
});

test('rollback conflict preserves concurrent edits and does not expose per-file paths', () => {
  const presentation = describeUpgradeTransactionOutcome(
    'react',
    'npm',
    result({
      completion: 'incomplete',
      reason: 'verification-failed',
      verification: { status: 'failed', checks: [] },
      rollback: {
        status: 'conflict',
        files: [{ path: '/sensitive/workspace/package.json', status: 'conflict', message: 'raw adapter detail' }],
      },
      retentionDecision: 'rollback',
    })
  );

  assert.equal(presentation.kind, 'error');
  assert.equal(presentation.error.code, 'ROLLBACK_CONFLICT');
  assert.match(presentation.error.message, /newer edits were preserved/);
  assert.match(presentation.error.message, /node_modules was not restored/);
  assert.match(presentation.error.message, /npm install/);
  assert.doesNotMatch(presentation.error.message, /sensitive|raw adapter detail/);
});

test('rollback I/O failure has a distinct code and warns that restoration may be partial', () => {
  const presentation = describeUpgradeTransactionOutcome(
    'react',
    'pnpm',
    result({
      completion: 'incomplete',
      reason: 'install-failed',
      install: { status: 'failed', code: 'TASK_FAILED', message: 'install failed' },
      verification: { status: 'not-run', reason: 'install-failed' },
      rollback: {
        status: 'failed',
        files: [{ path: '/workspace/package.json', status: 'failed', message: 'permission denied' }],
      },
    })
  );

  assert.equal(presentation.kind, 'error');
  assert.equal(presentation.error.code, 'ROLLBACK_FAILED');
  assert.match(presentation.error.message, /Some transaction-owned files may already have been restored/);
  assert.match(presentation.error.message, /node_modules was not restored/);
  assert.match(presentation.error.message, /pnpm install/);
  assert.doesNotMatch(presentation.error.message, /permission denied/);
});

test('snapshot and other non-rollback failures retain the generic transaction code', () => {
  const presentation = describeUpgradeTransactionOutcome(
    'react',
    'npm',
    result({
      completion: 'not-started',
      reason: 'snapshot-failed',
      snapshot: { status: 'failed', path: '/workspace/package.json', message: 'read failed' },
      install: { status: 'not-run' },
      verification: { status: 'not-run', reason: 'install-failed' },
    })
  );

  assert.deepEqual(presentation, {
    kind: 'error',
    error: {
      code: 'UPGRADE_TRANSACTION_FAILED',
      message: 'The upgrade transaction did not reach a verified or fully restored state. Review package.json and the lockfile.',
    },
  });
});

test('manifest stage conflicts are clean stale-source failures and hide host file details', () => {
  const presentation = describeUpgradeTransactionOutcome('react', 'npm', result({
    completion: 'not-started',
    reason: 'manifest-stage-failed',
    manifestStage: {
      status: 'failed',
      path: '/sensitive/workspace/package.json',
      code: 'CONFLICT',
      message: 'raw compare detail',
    },
    install: { status: 'not-run' },
    verification: { status: 'not-run', reason: 'manifest-stage-failed' },
  }));

  assert.equal(presentation.kind, 'error');
  assert.equal(presentation.error.code, 'STALE_SOURCE');
  assert.match(presentation.error.message, /No upgrade files were modified/);
  assert.doesNotMatch(presentation.error.message, /sensitive|raw compare detail/);
});

test('manifest stage write failures are distinct and do not claim an install ran', () => {
  const presentation = describeUpgradeTransactionOutcome('react', 'pnpm', result({
    completion: 'not-started',
    reason: 'manifest-stage-failed',
    manifestStage: {
      status: 'failed',
      path: '/workspace/package.json',
      code: 'WRITE_FAILED',
      message: 'permission denied',
    },
    install: { status: 'not-run' },
    verification: { status: 'not-run', reason: 'manifest-stage-failed' },
  }));

  assert.equal(presentation.kind, 'error');
  assert.equal(presentation.error.code, 'MANIFEST_STAGE_FAILED');
  assert.match(presentation.error.message, /install was not started/);
  assert.doesNotMatch(presentation.error.message, /permission denied/);
});

test('describeRemoveTransactionOutcome names a single package directly and a batch by count', () => {
  assert.deepEqual(describeRemoveTransactionOutcome(['left-pad'], 'npm', result()), {
    kind: 'verified',
    message: 'Removed left-pad; verification passed.',
  });
  assert.deepEqual(describeRemoveTransactionOutcome(['left-pad', 'is-odd', 'is-number'], 'npm', result()), {
    kind: 'verified',
    message: 'Removed 3 dependencies; verification passed.',
  });
});

test('describeRemoveTransactionOutcome mirrors the upgrade outcome\'s rollback/error precedence with remove-specific wording', () => {
  const rolledBack = describeRemoveTransactionOutcome(
    ['left-pad'],
    'pnpm',
    result({
      completion: 'rolled-back',
      reason: 'install-failed',
      install: { status: 'failed', code: 'TASK_FAILED', message: 'install failed' },
      verification: { status: 'not-run', reason: 'install-failed' },
      rollback: { status: 'succeeded', files: [{ path: '/workspace/package.json', status: 'restored' }] },
      retentionDecision: 'not-needed',
    })
  );
  assert.equal(rolledBack.kind, 'rolled-back');
  assert.equal(
    rolledBack.message,
    'Dependency files for left-pad were restored to their pre-removal state. ' +
      'node_modules was not restored; run pnpm install to reconcile installed packages with the restored lockfile.'
  );

  const conflict = describeRemoveTransactionOutcome(
    ['left-pad'],
    'npm',
    result({
      completion: 'incomplete',
      reason: 'verification-failed',
      verification: { status: 'failed', checks: [] },
      rollback: { status: 'conflict', files: [] },
      retentionDecision: 'rollback',
    })
  );
  assert.equal(conflict.kind, 'error');
  assert.equal(conflict.error.code, 'ROLLBACK_CONFLICT');

  const staleManifest = describeRemoveTransactionOutcome(
    ['left-pad'],
    'npm',
    result({
      completion: 'not-started',
      reason: 'manifest-stage-failed',
      manifestStage: { status: 'failed', path: '/workspace/package.json', code: 'CONFLICT', message: 'raw detail' },
      install: { status: 'not-run' },
      verification: { status: 'not-run', reason: 'manifest-stage-failed' },
    })
  );
  assert.equal(staleManifest.kind, 'error');
  assert.equal(staleManifest.error.code, 'STALE_SOURCE');
  assert.match(staleManifest.error.message, /No files were modified/);

  const genericFailure = describeRemoveTransactionOutcome(
    ['left-pad'],
    'npm',
    result({
      completion: 'not-started',
      reason: 'snapshot-failed',
      snapshot: { status: 'failed', path: '/workspace/package.json', message: 'read failed' },
      install: { status: 'not-run' },
      verification: { status: 'not-run', reason: 'install-failed' },
    })
  );
  assert.deepEqual(genericFailure, {
    kind: 'error',
    error: {
      code: 'REMOVE_TRANSACTION_FAILED',
      message: 'The removal transaction did not reach a verified or fully restored state. Review package.json and the lockfile.',
    },
  });
});
