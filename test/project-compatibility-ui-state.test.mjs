import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupProjectCompatibilityFindings,
  summarizeProjectCompatibility,
} from '../out/host/projectCompatibilityUiState.js';

function finding(id, confidence, category) {
  return {
    id, confidence, category, packageName: 'next', targetVersion: '15.5.24', title: id,
    explanation: id, evidence: [], source: 'generic',
  };
}

test('project compatibility summary keeps three confidence classes and incomplete analyzers distinct', () => {
  const analysis = {
    identity: { packageName: 'next', currentVersion: '14.2.35', targetVersion: '15.5.24', requestId: 'r', sourceFingerprint: 'f' },
    findings: [finding('private', 'review', 'private-api'), finding('engine', 'confirmed', 'runtime'), finding('route', 'likely', 'framework-migration')],
    analyzers: [
      { analyzerId: 'runtime-compatibility', status: 'complete', findings: [] },
      { analyzerId: 'import-compatibility', status: 'unavailable', findings: [], unavailableReason: 'target-pack-failed' },
    ],
    startedAt: '2026-08-26T00:00:00.000Z', completedAt: '2026-08-26T00:00:01.000Z',
  };
  assert.deepEqual(summarizeProjectCompatibility(analysis), {
    confirmed: 1, likely: 1, review: 1, total: 3, runtimeStatus: 'complete',
    incompleteAnalyzers: [{ analyzerId: 'import-compatibility', status: 'unavailable', reason: 'target-pack-failed' }],
  });
  assert.deepEqual(groupProjectCompatibilityFindings(analysis).map((group) => group.confidence), ['confirmed', 'likely', 'review']);
});
