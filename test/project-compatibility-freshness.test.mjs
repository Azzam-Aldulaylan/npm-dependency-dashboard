import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectCompatibilityEvidenceIsCurrent,
  projectCompatibilityFinalReadIsCurrent,
} from '../out/host/projectCompatibility/projectCompatibilityFreshness.js';

test('project compatibility source authority requires the final and confirm-time evidence snapshot to match', () => {
  assert.equal(projectCompatibilityEvidenceIsCurrent('source-a', 'source-a'), true);
  assert.equal(projectCompatibilityEvidenceIsCurrent('source-a', 'source-b'), false,
    'a watcher/source change during or after analysis invalidates the retained findings');
  assert.equal(projectCompatibilityEvidenceIsCurrent('source-a', null), false,
    'failure to re-read authoritative evidence cannot confirm an old source-backed result');
});

test('unavailable source collection contributes no source-backed execution authority', () => {
  assert.equal(projectCompatibilityEvidenceIsCurrent(null, null), true);
  assert.equal(projectCompatibilityEvidenceIsCurrent(null, 'later-readable-source'), true,
    'null means no source-backed finding was authorized, not that a later fingerprint must equal null');
});

test('a watcher generation advancement during the final read rejects that snapshot', () => {
  assert.equal(projectCompatibilityFinalReadIsCurrent({
    generationBeforeRead: 41,
    generationAfterRead: 42,
    expectedFingerprint: 'source-a',
    observedFingerprint: 'source-a',
  }), false, 'matching bytes cannot authorize a result when an in-flight watcher event may follow them');
  assert.equal(projectCompatibilityFinalReadIsCurrent({
    generationBeforeRead: 42,
    generationAfterRead: 42,
    expectedFingerprint: 'source-a',
    observedFingerprint: 'source-a',
  }), true);
  assert.equal(projectCompatibilityFinalReadIsCurrent({
    generationBeforeRead: 42,
    generationAfterRead: 42,
    expectedFingerprint: 'source-a',
    observedFingerprint: 'source-b',
  }), false);
});
