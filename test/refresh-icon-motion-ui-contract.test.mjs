import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('../webview/src/styles.css', import.meta.url), 'utf8');

test('refresh icons spin with their counter-clockwise arrowheads', () => {
  assert.match(
    styles,
    /@keyframes dashboard-refresh-spin\s*{\s*to\s*{\s*transform:\s*rotate\(-360deg\)/,
  );

  for (const className of [
    'stale-status__icon',
    'manage-glance__status-icon--spin',
    'manage-action-card__status-icon--spin',
    'manage-removal-stat__spinner',
    'vuln-recommended__spin',
    'usage-status__icon--spin',
    'removal-review__loading-icon',
    'banner__icon--spin',
  ]) {
    assert.match(
      styles,
      new RegExp(`\\.${className}\\s*{[^}]*animation:\\s*dashboard-refresh-spin`, 's'),
      `${className} should use the refresh-specific animation`,
    );
  }
});

test('the direction-neutral loading ring keeps its existing spin', () => {
  assert.match(
    styles,
    /\.loading-ring--indeterminate\s*{[^}]*animation:\s*dashboard-spin\b/s,
  );
});

test('refresh motion is disabled when reduced motion is requested', () => {
  const reducedMotionStart = styles.indexOf('@media (prefers-reduced-motion: reduce)');
  const reducedMotionEnd = styles.indexOf('/* ------------------------------------------------------------ empty state */');
  const reducedMotionBlock = styles.slice(reducedMotionStart, reducedMotionEnd);

  assert.notEqual(reducedMotionStart, -1, 'reduced-motion styles should exist');
  assert.ok(reducedMotionEnd > reducedMotionStart, 'reduced-motion styles should be bounded');
  assert.match(reducedMotionBlock, /\.banner__icon--spin\s*{\s*animation:\s*none;/s);
  assert.match(reducedMotionBlock, /\.stale-status__icon,/);
  assert.match(reducedMotionBlock, /\.removal-review__loading-icon,/);
});
