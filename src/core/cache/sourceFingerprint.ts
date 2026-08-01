/**
 * Binds a persisted project cache entry to the exact on-disk state it was
 * produced from — pure, no vscode (`node:crypto` is a plain Node built-in,
 * not an extension API).
 *
 * A cache key alone (S6 project identity + registry) says *which* project an
 * entry belongs to, not *whether the entry still matches what's on disk*. A
 * file edited while the panel was closed (no watcher running to invalidate
 * it) would otherwise still hash-match its old cache key on reopen and
 * replay stale rows as if they were current. The fingerprint closes that
 * gap: hydration compares it against a freshly-computed one from the
 * just-read manifest/lockfile before trusting a persisted entry at all.
 */

import { createHash } from 'node:crypto';

import { isRecord } from '../validation.js';

export interface ProjectSourceFingerprint {
  manifestHash: string;
  /** null when there is no lockfile at all — distinct from a lockfile whose content happens to hash the same as some other string. */
  lockfileHash: string | null;
  /** Absolute path, or null — a topology change (no-lockfile -> package-lock, package-lock -> shrinkwrap, a nearer lockfile appearing) changes *which* file is authoritative even if none of the file contents involved happen to differ. */
  lockfilePath: string | null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function computeSourceFingerprint(input: {
  manifestText: string;
  lockfileText: string | null;
  lockfilePath: string | null;
}): ProjectSourceFingerprint {
  return {
    manifestHash: sha256(input.manifestText),
    lockfileHash: input.lockfileText === null ? null : sha256(input.lockfileText),
    lockfilePath: input.lockfilePath,
  };
}

export function sourceFingerprintsMatch(a: ProjectSourceFingerprint, b: ProjectSourceFingerprint): boolean {
  return a.manifestHash === b.manifestHash && a.lockfileHash === b.lockfileHash && a.lockfilePath === b.lockfilePath;
}

export function isSourceFingerprint(value: unknown): value is ProjectSourceFingerprint {
  return (
    isRecord(value) &&
    typeof value['manifestHash'] === 'string' &&
    (value['lockfileHash'] === null || typeof value['lockfileHash'] === 'string') &&
    (value['lockfilePath'] === null || typeof value['lockfilePath'] === 'string')
  );
}
