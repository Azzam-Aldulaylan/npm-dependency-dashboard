/**
 * TTL / freshness — pure, no vscode, no `Date.now()` baked in (every
 * function here takes `now` as a parameter so tests are deterministic
 * without faking global time).
 */

export const DEFAULT_TTL_MINUTES = 30;

/**
 * Validates a raw `dependencyDashboard.cacheTtlMinutes` setting value.
 * Anything not a finite, non-negative number (NaN, Infinity, a negative
 * number, a string, undefined, null, ...) falls back to the documented
 * default rather than propagating a broken value into freshness math. `0`
 * is a legitimate, meaningful value (see `classifyFreshness`) and passes
 * through unchanged.
 */
export function effectiveTtlMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return DEFAULT_TTL_MINUTES;
  return raw;
}

export type Freshness = 'fresh' | 'stale' | 'unknown';

/**
 * How far into the future a `generatedAt` is still tolerated as ordinary
 * clock skew (system clocks drifting apart, or the brief gap between a scan
 * starting and its timestamp being read). Beyond this, a future timestamp is
 * no longer plausible skew — it is corrupt or tampered `workspaceState`, and
 * trusting it as `fresh` would suppress every future revalidation
 * (network *and* the background timer) indefinitely, recoverable only by a
 * manual refresh. `unknown` degrades it the same way a missing/malformed
 * timestamp already does, rather than a fixed `stale` — either is untrusted,
 * not "old but real."
 */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * `generatedAt` is the ISO timestamp a cache entry (in-memory or persisted)
 * claims to be from. `unknown` covers anything not usable as a freshness
 * signal at all (missing, unparseable, or implausibly far in the future) —
 * the caller treats that the same as "no cache", not as "stale" (stale still
 * implies "there is a real, if old, snapshot to show").
 *
 * `ttlMinutes <= 0` always reports `stale`, never `fresh` — this is the
 * documented meaning of a `0` TTL: always revalidate, and a defensive floor
 * against a negative value slipping through (effectiveTtlMinutes should
 * already have clamped that, but this function makes no assumption about
 * having been called through it).
 */
export function classifyFreshness(generatedAt: string | undefined, ttlMinutes: number, now: number): Freshness {
  if (generatedAt === undefined) return 'unknown';
  const generatedMs = Date.parse(generatedAt);
  if (Number.isNaN(generatedMs)) return 'unknown';
  if (ttlMinutes <= 0) return 'stale';
  const ageMs = now - generatedMs;
  if (ageMs < -MAX_FUTURE_SKEW_MS) return 'unknown'; // implausibly future — never trust it as fresh, indefinitely
  if (ageMs < 0) return 'fresh'; // ordinary clock skew — harmless
  return ageMs < ttlMinutes * 60_000 ? 'fresh' : 'stale';
}
