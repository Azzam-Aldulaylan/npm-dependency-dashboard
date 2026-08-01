/**
 * TTL/freshness — pure, deterministic (every clock is an injected `now`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFreshness, effectiveTtlMinutes, DEFAULT_TTL_MINUTES } from '../out/core/cache/freshness.js';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

test('effectiveTtlMinutes falls back to the default for NaN, Infinity, negative, or non-numeric config', () => {
  assert.equal(effectiveTtlMinutes(NaN), DEFAULT_TTL_MINUTES);
  assert.equal(effectiveTtlMinutes(Infinity), DEFAULT_TTL_MINUTES);
  assert.equal(effectiveTtlMinutes(-5), DEFAULT_TTL_MINUTES);
  assert.equal(effectiveTtlMinutes('30'), DEFAULT_TTL_MINUTES);
  assert.equal(effectiveTtlMinutes(null), DEFAULT_TTL_MINUTES);
  assert.equal(effectiveTtlMinutes(undefined), DEFAULT_TTL_MINUTES);
});

test('effectiveTtlMinutes accepts zero and any valid positive finite number as-is', () => {
  assert.equal(effectiveTtlMinutes(0), 0);
  assert.equal(effectiveTtlMinutes(45), 45);
  assert.equal(effectiveTtlMinutes(0.5), 0.5);
});

test('classifyFreshness: exactly at the TTL boundary is stale, just under it is fresh', () => {
  const ttlMinutes = 30;
  const generatedAt = new Date(NOW - ttlMinutes * 60_000).toISOString();
  assert.equal(classifyFreshness(generatedAt, ttlMinutes, NOW), 'stale', 'age === ttl is not fresh');

  const justUnder = new Date(NOW - ttlMinutes * 60_000 + 1).toISOString();
  assert.equal(classifyFreshness(justUnder, ttlMinutes, NOW), 'fresh');
});

test('classifyFreshness: ttlMinutes=0 always means revalidate, never fresh, even for a snapshot from right now', () => {
  const justNow = new Date(NOW).toISOString();
  assert.equal(classifyFreshness(justNow, 0, NOW), 'stale');
  assert.equal(classifyFreshness(justNow, -1, NOW), 'stale', 'a negative ttl is treated the same as zero');
});

test('classifyFreshness: missing or unparseable generatedAt is unknown, not fresh', () => {
  assert.equal(classifyFreshness(undefined, 30, NOW), 'unknown');
  assert.equal(classifyFreshness('not-a-date', 30, NOW), 'unknown');
});

test('classifyFreshness: a generatedAt in the future (ordinary clock skew) is treated as fresh, not stale', () => {
  const future = new Date(NOW + 60_000).toISOString();
  assert.equal(classifyFreshness(future, 30, NOW), 'fresh');
});

test('classifyFreshness: an implausibly future generatedAt is unknown, never fresh indefinitely', () => {
  const oneDayFuture = new Date(NOW + 24 * 60 * 60_000).toISOString();
  assert.equal(classifyFreshness(oneDayFuture, 30, NOW), 'unknown');
  // A tampered/corrupt timestamp like this must never be trusted as "still
  // fresh" no matter how the TTL is configured — not even ttl=0's own
  // stale-by-default rule is needed to catch it; this is a distinct check.
  assert.equal(classifyFreshness(oneDayFuture, 0, NOW), 'stale', 'ttl=0 already forces stale regardless');
  assert.notEqual(classifyFreshness(oneDayFuture, 99999, NOW), 'fresh', 'no configured TTL makes this trustworthy');
});
