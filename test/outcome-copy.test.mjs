/**
 * outcomeCopy — status -> {label, className} for the compatibility, security,
 * and resolver-verification vocabularies the Upgrade Analysis modal renders.
 * Pure, mirrors severityDisplay.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compatibilityOutcomeDisplay,
  resolverOutcomeDisplay,
  securityOutcomeDisplay,
  upgradeSafetyHeadline,
} from '../out/host/outcomeCopy.js';

test('every compatibility status has a distinct, non-empty label and a className matching the status', () => {
  const statuses = ['compatible', 'warning', 'conflict', 'unknown'];
  const labels = new Set();
  for (const status of statuses) {
    const { label, className } = compatibilityOutcomeDisplay(status);
    assert.ok(label.length > 0);
    assert.equal(className, status);
    labels.add(label);
  }
  assert.equal(labels.size, statuses.length, 'labels must be distinct');
});

test('every security outcome status has a distinct, non-empty label and a className matching the status', () => {
  const statuses = ['resolved', 'remains', 'unknown', 'not-applicable'];
  const labels = new Set();
  for (const status of statuses) {
    const { label, className } = securityOutcomeDisplay(status);
    assert.ok(label.length > 0);
    assert.equal(className, status);
    labels.add(label);
  }
  assert.equal(labels.size, statuses.length, 'labels must be distinct');
});

test('resolver outcome reuses the same four-state vocabulary as compatibility, never its own wording scheme', () => {
  for (const status of ['compatible', 'warning', 'conflict', 'unknown']) {
    const { className } = resolverOutcomeDisplay(status);
    assert.equal(className, status);
  }
});

test('a failed resolver reports resolution failure, not a generic conflict label', () => {
  assert.match(resolverOutcomeDisplay('conflict').label, /fail/i);
});

test('an unavailable resolver reports that verification could not be confirmed', () => {
  assert.match(resolverOutcomeDisplay('unknown').label, /could not be verified/i);
});

test('every upgrade-safety headline has a distinct, non-empty label and a className matching the status', () => {
  const statuses = ['compatible', 'warning', 'conflict', 'unknown'];
  const labels = new Set();
  for (const status of statuses) {
    const { label, className } = upgradeSafetyHeadline(status);
    assert.ok(label.length > 0);
    assert.equal(className, status);
    labels.add(label);
  }
  assert.equal(labels.size, statuses.length, 'labels must be distinct');
});

test('a blocked upgrade is phrased as blocked, not a generic conflict label', () => {
  assert.match(upgradeSafetyHeadline('conflict').label, /block/i);
});

test('dependency compatibility does not imply complete project or runtime safety', () => {
  assert.equal(upgradeSafetyHeadline('compatible').label, 'No dependency conflicts found');
  assert.doesNotMatch(upgradeSafetyHeadline('compatible').label, /safe|all checks passed/i);
});
