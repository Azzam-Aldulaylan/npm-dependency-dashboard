/**
 * Exact target-package surface inspection without extracting or executing the
 * package. `npm pack --json` downloads the published tarball and returns its
 * bounded file inventory; `--ignore-scripts` prevents lifecycle hooks. The
 * package name/version and registry are host-owned inputs.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { isSafeNpmPackageName, isSafeSemverVersion } from '../../core/upgrade/plan.js';
import type { PackageManagerInvocation, ResolverProcessResult } from '../resolverVerifier.js';

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_FILE_ENTRIES = 50_000;

export interface TargetPackageSurface {
  packageName: string;
  version: string;
  /** POSIX, package-root-relative paths reported by npm's published tarball inventory. */
  files: string[];
}

/** One-entry exact-identity cache: enough for target re-analysis without retaining packument-sized inventories. */
export class TargetPackageSurfaceCache {
  private entry: { key: string; surface: TargetPackageSurface } | undefined;

  get(key: string): TargetPackageSurface | undefined {
    return this.entry?.key === key ? this.entry.surface : undefined;
  }

  set(key: string, surface: TargetPackageSurface): void {
    this.entry = { key, surface };
  }
}

export interface TargetPackagePackRunner {
  run(
    invocation: PackageManagerInvocation,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<ResolverProcessResult>;
}

export class NodeTargetPackagePackRunner implements TargetPackagePackRunner {
  run(
    invocation: PackageManagerInvocation,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<ResolverProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, [...invocation.prefixArgs, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal === undefined ? {} : { signal }),
      });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          child.kill();
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
      });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        resolve({
          exitCode: stdoutBytes > MAX_STDOUT_BYTES ? null : exitCode,
          stdout: stdoutBytes > MAX_STDOUT_BYTES ? '' : stdout,
          stderr: stdoutBytes > MAX_STDOUT_BYTES ? 'Target package inventory exceeded the response limit.' : stderr,
        });
      });
    });
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
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-target-package-'));
    try {
      const result = await this.runner.run(
        this.invocation,
        buildTargetPackagePackArgs({ packageName, version, registry: this.registry, destination: temporaryRoot }),
        temporaryRoot,
        signal
      );
      if (result.exitCode !== 0) throw new Error('Target package inventory could not be materialized.');
      return parseTargetPackagePackOutput(result.stdout, { packageName, version });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
