/**
 * findingCopy — a CompatibilityFinding -> structured, renderable label/lines,
 * built entirely from the finding's own structured fields, never its
 * pre-baked `explanation` sentence (see src/host/findingCopy.ts's own
 * header). Every CompatibilityFindingKind is covered so a new kind added to
 * the domain model can't silently fall through to nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findingCopy } from '../out/host/findingCopy.js';

const CONTEXT = { package: 'react-toastify', currentVersion: '10.0.6' };

/** Every test below only cares about the text a line carries, not whether the presentation layer renders it as code. */
const texts = (copy) => copy.lines.map((l) => l.text);

function finding(kind, overrides) {
  return {
    id: `["${kind}"]`,
    kind,
    status: 'warning',
    source: 'static',
    subject: { name: 'some-library', version: '4.2.0', nodeId: 'node_modules/some-library' },
    relation: { kind: 'direct', nodeIds: ['node_modules/some-library'], packageNames: ['some-library'] },
    explanation: 'ignored by findingCopy — never read',
    ...overrides,
  };
}

test('peer-incompatible names the owner, the required range, and the proposed version', () => {
  const copy = findingCopy(
    finding('peer-incompatible', {
      requirement: { name: 'react-toastify', range: '^10.0.0', optional: false },
      observedVersion: '11.1.0',
    }),
    CONTEXT
  );
  assert.equal(copy.label, 'Peer conflict');
  assert.ok(texts(copy).some((l) => l.includes('some-library@4.2.0')));
  assert.ok(texts(copy).some((l) => l.includes('react-toastify ^10.0.0')));
  assert.ok(texts(copy).some((l) => l.includes('11.1.0')));
});

test('peer-missing names the requirement without an observed version', () => {
  const copy = findingCopy(
    finding('peer-missing', { requirement: { name: 'react-dom', range: '^18.0.0', optional: false }, observedVersion: null }),
    CONTEXT
  );
  assert.equal(copy.label, 'Missing peer dependency');
  assert.ok(texts(copy).some((l) => l.includes('react-dom ^18.0.0')));
});

test('optional-peer-missing is distinguished from a required missing peer', () => {
  const copy = findingCopy(
    finding('optional-peer-missing', { requirement: { name: 'redis', range: '^4.0.0', optional: true }, observedVersion: null }),
    CONTEXT
  );
  assert.equal(copy.label, 'Optional peer not installed');
});

test('peer-compatible reports what was accepted', () => {
  const copy = findingCopy(
    finding('peer-compatible', {
      status: 'compatible',
      requirement: { name: 'react', range: '^18.0.0', optional: false },
      observedVersion: '18.2.0',
    }),
    CONTEXT
  );
  assert.equal(copy.label, 'Peer compatibility');
  assert.ok(texts(copy).some((l) => l.includes('18.2.0')));
});

test('invalid-peer-range surfaces the unparseable range text', () => {
  const copy = findingCopy(
    finding('invalid-peer-range', { requirement: { name: 'react', range: 'not-a-range', optional: false } }),
    CONTEXT
  );
  assert.equal(copy.label, 'Peer range could not be parsed');
  assert.ok(texts(copy).some((l) => l.includes('not-a-range')));
});

test('metadata-unavailable and graph-metadata-incomplete each have their own distinct label', () => {
  const a = findingCopy(finding('metadata-unavailable'), CONTEXT);
  const b = findingCopy(finding('graph-metadata-incomplete'), CONTEXT);
  assert.notEqual(a.label, b.label);
});

test('major-version-change shows current -> target when the finding is about the analysis\'s own package', () => {
  const copy = findingCopy(
    finding('major-version-change', { subject: { name: 'react-toastify', version: '11.1.0', nodeId: null } }),
    CONTEXT
  );
  assert.equal(copy.label, 'Major update');
  assert.ok(texts(copy).some((l) => l.includes('10.0.6') && l.includes('11.1.0')));
});

test('major-version-change about a different package (the coordinated-plan case) omits the unavailable current version', () => {
  const copy = findingCopy(
    finding('major-version-change', { subject: { name: 'some-other-lib', version: '5.0.0', nodeId: null } }),
    CONTEXT
  );
  assert.ok(texts(copy).some((l) => l.includes('some-other-lib') && l.includes('5.0.0')));
  assert.ok(!texts(copy).some((l) => l.includes('10.0.6')));
});

test('every CompatibilityFindingKind produces a non-empty label and at least one line', () => {
  const kinds = [
    'peer-compatible',
    'peer-incompatible',
    'peer-missing',
    'optional-peer-missing',
    'invalid-peer-range',
    'metadata-unavailable',
    'graph-metadata-incomplete',
    'major-version-change',
  ];
  for (const kind of kinds) {
    const copy = findingCopy(
      finding(kind, { requirement: { name: 'x', range: '^1.0.0', optional: false }, observedVersion: '1.0.0' }),
      CONTEXT
    );
    assert.ok(copy.label.length > 0, `${kind} has no label`);
    assert.ok(copy.lines.length > 0, `${kind} has no lines`);
  }
});
