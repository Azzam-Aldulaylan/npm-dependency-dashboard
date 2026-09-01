/**
 * Exact target-package surface inspection without extracting or executing the
 * package. `npm pack --json` downloads the published tarball and returns its
 * bounded file inventory; `--ignore-scripts` prevents lifecycle hooks. The
 * package name/version and registry are host-owned inputs.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { isSafeNpmPackageName, isSafeSemverVersion } from '../../core/upgrade/plan.js';
import type { PackageManagerInvocation } from '../resolverVerifier.js';
import { NodeTargetPackagePackRunner, type TargetPackagePackRunner } from './targetPackagePackRunner.js';
export { NodeTargetPackagePackRunner, type TargetPackagePackRunner } from './targetPackagePackRunner.js';

const MAX_FILE_ENTRIES = 50_000;

export interface TargetPackageSurface {
  packageName: string;
  version: string;
  /** POSIX, package-root-relative paths reported by npm's published tarball inventory. */
  files: string[];
}

export function targetPackageSurfaceCacheKey(input: {
  registry: string;
  packageName: string;
  version: string;
}): string {
  if (!isSafeNpmPackageName(input.packageName) || !isSafeSemverVersion(input.version)) {
    throw new Error('Target package identity is invalid.');
  }
  const registry = new URL(input.registry);
  if (registry.protocol !== 'https:') throw new Error('Target package registry must use HTTPS.');
  return `${registry.toString()}\0${input.packageName}\0${input.version}`;
}

interface SurfaceCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Successful published inventories are independent of project source. Keep a
 * few exact targets so switching versions/packages does not repeat downloads,
 * but bound retained memory and age even for unusually large packages.
 */
export class TargetPackageSurfaceCache {
  private readonly entries = new Map<string, { surface: TargetPackageSurface; bytes: number; expiresAt: number }>();
  private retainedBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SurfaceCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 4;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
    for (const limit of [this.maxEntries, this.maxBytes, this.ttlMs]) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Target inventory cache limits must be non-negative integers.');
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) this.retainedBytes -= entry.bytes;
    this.entries.delete(key);
  }

  private expire(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
  }

  get(key: string): TargetPackageSurface | undefined {
    this.expire();
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry.surface, files: [...entry.surface.files] };
  }

  set(key: string, surface: TargetPackageSurface): void {
    const [registry, packageName, version, extra] = key.split('\0');
    if (registry === undefined || packageName !== surface.packageName || version !== surface.version || extra !== undefined ||
      targetPackageSurfaceCacheKey({ registry, packageName, version }) !== key) {
      throw new Error('Target inventory cache identity did not match the published surface.');
    }
    if (surface.files.length > MAX_FILE_ENTRIES || surface.files.some((file) => safePackageFilePath(file) !== file)) return;
    this.expire();
    this.delete(key);
    // Conservative UTF-16/string/list overhead estimate, not just path bytes.
    const bytes = 256 + 2 * (key.length + surface.packageName.length + surface.version.length) +
      surface.files.reduce((total, file) => total + 64 + 2 * file.length, 0);
    if (this.maxEntries === 0 || this.ttlMs === 0 || bytes > this.maxBytes) return;
    while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, {
      surface: { ...surface, files: [...surface.files] },
      bytes,
      expiresAt: this.now() + this.ttlMs,
    });
    this.retainedBytes += bytes;
  }
}

export function buildTargetPackagePackArgs(input: {
  packageName: string;
  version: string;
  registry: string;
  destination: string;
}): string[] {
  if (!isSafeNpmPackageName(input.packageName) || !isSafeSemverVersion(input.version)) {
    throw new Error('Target package identity is invalid.');
  }
  const registry = new URL(input.registry);
  if (registry.protocol !== 'https:') throw new Error('Target package registry must use HTTPS.');
  return [
    'pack',
    `${input.packageName}@${input.version}`,
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    input.destination,
    `--registry=${registry.toString()}`,
  ];
}

function safePackageFilePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value.includes('\0')) return null;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '..')) return null;
  return normalized;
}

export function parseTargetPackagePackOutput(
  stdout: string,
  expected: { packageName: string; version: string }
): TargetPackageSurface {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    throw new Error('Target package inventory was not valid JSON.');
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) throw new Error('Target package inventory had an unexpected shape.');
  const entry = decoded[0];
  if (typeof entry !== 'object' || entry === null) throw new Error('Target package inventory had an unexpected entry.');
  const record = entry as Record<string, unknown>;
  if (record['name'] !== expected.packageName || record['version'] !== expected.version) {
    throw new Error('Target package inventory identity did not match the requested package.');
  }
  const rawFiles = record['files'];
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILE_ENTRIES) {
    throw new Error('Target package inventory file list was unavailable or too large.');
  }
  const files = new Set<string>();
  for (const raw of rawFiles) {
    if (typeof raw !== 'object' || raw === null) continue;
    const safe = safePackageFilePath((raw as Record<string, unknown>)['path']);
    if (safe !== null) files.add(safe);
  }
  return { packageName: expected.packageName, version: expected.version, files: [...files].sort() };
}

export class TargetPackageInspector {
  private readonly runner: TargetPackagePackRunner;

  constructor(
    private readonly invocation: PackageManagerInvocation,
    private readonly registry: string,
    runner?: TargetPackagePackRunner
  ) {
    this.runner = runner ?? new NodeTargetPackagePackRunner();
  }

  async inspect(packageName: string, version: string, signal?: AbortSignal): Promise<TargetPackageSurface> {
    signal?.throwIfAborted();
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-target-package-'));
    try {
      signal?.throwIfAborted();
      const result = await this.runner.run(
        this.invocation,
        buildTargetPackagePackArgs({ packageName, version, registry: this.registry, destination: temporaryRoot }),
        temporaryRoot,
        signal
      );
      signal?.throwIfAborted();
      if (result.exitCode !== 0) throw new Error('Target package inventory could not be materialized.');
      return parseTargetPackagePackOutput(result.stdout, { packageName, version });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
