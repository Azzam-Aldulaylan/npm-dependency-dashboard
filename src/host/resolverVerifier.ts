/**
 * Package-manager resolver verification in an isolated temporary project.
 *
 * The safety boundary is the temporary directory, not a package manager's
 * interpretation of "dry run": only a host-owned manifest and active
 * lockfile are copied, workspace configuration is deliberately not copied,
 * lifecycle scripts are disabled, and the real project is never the cwd.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type {
  ResolverVerification,
  ResolverVerifier,
  SupportedPackageManager,
  UpgradeProposal,
} from '../core/compatibility/types.js';
import type { PeerResolutionPolicy } from '../core/compatibility/types.js';

export interface PackageManagerInvocation {
  executable: string;
  prefixArgs: readonly string[];
}

/** Fixed argv probe; returns null rather than weakening verification when unavailable. */
export function probePackageManagerVersion(
  invocation: PackageManagerInvocation,
  cwd: string
): string | null {
  try {
    const output = execFileSync(
      invocation.executable,
      [...invocation.prefixArgs, '--version'],
      { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return output.length === 0 ? null : output.slice(0, 100);
  } catch {
    return null;
  }
}

export interface ResolverProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ResolverProcessRunner {
  run(
    invocation: PackageManagerInvocation,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<ResolverProcessResult>;
}

export class NodeResolverProcessRunner implements ResolverProcessRunner {
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
      const append = (current: string, chunk: Buffer): string =>
        (current + chunk.toString('utf8')).slice(-32_768);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on('error', reject);
      child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
  }
}

export interface IsolatedResolverVerifierOptions {
  packageManager: SupportedPackageManager;
  packageManagerVersion: string | null;
  invocation: PackageManagerInvocation;
  manifestText: string;
  lockfile?: { name: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml'; text: string };
  registry: string;
  policy: PeerResolutionPolicy;
  runner?: ResolverProcessRunner;
}

function parseManifestObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('package.json is not an object');
  }
  return parsed as Record<string, unknown>;
}

function applyProposal(manifest: Record<string, unknown>, proposal: UpgradeProposal): void {
  for (const change of proposal.changes) {
    let matched = false;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const block = manifest[field];
      if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
      if (!Object.hasOwn(block, change.packageName)) continue;
      (block as Record<string, unknown>)[change.packageName] = change.targetVersion;
      matched = true;
    }
    if (!matched) throw new Error(`${change.packageName} is not declared in package.json`);
  }
}

export function buildResolverArgs(
  manager: SupportedPackageManager,
  registry: string,
  policy: PeerResolutionPolicy
): string[] {
  const policyArgs: string[] = [];
  if (policy.legacyPeerDeps && manager === 'npm') policyArgs.push('--legacy-peer-deps');
  else if (policy.strictPeerDeps) {
    policyArgs.push(manager === 'pnpm' ? '--strict-peer-dependencies' : '--strict-peer-deps');
  }

  if (manager === 'npm') {
    return [
      'install',
      '--dry-run',
      '--ignore-scripts',
      '--package-lock=false',
      '--audit=false',
      '--fund=false',
      '--json',
      `--registry=${registry}`,
      ...policyArgs,
    ];
  }
  return [
    'install',
    '--ignore-scripts',
    '--lockfile=false',
    '--reporter=silent',
    `--registry=${registry}`,
    ...policyArgs,
  ];
}

function diagnostic(result: ResolverProcessResult, tempRoot: string): string {
  const combined = `${result.stderr}\n${result.stdout}`
    .replaceAll(tempRoot, '<temporary-project>')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return combined.length === 0 ? 'The package manager returned no diagnostic.' : combined.slice(0, 500);
}

function verificationForResult(
  manager: SupportedPackageManager,
  version: string | null,
  result: ResolverProcessResult,
  tempRoot: string
): ResolverVerification {
  if (result.exitCode === 0) {
    return {
      status: 'compatible',
      packageManager: manager,
      packageManagerVersion: version,
      code: 'RESOLVED',
      explanation: 'The package manager resolved the proposed dependency set in an isolated temporary project.',
    };
  }
  const details = diagnostic(result, tempRoot);
  const peerConflict = /ERESOLVE|peer dep|peer-dependenc|ERR_PNPM_PEER_DEP_ISSUES/i.test(details);
  return {
    status: peerConflict ? 'conflict' : 'unknown',
    packageManager: manager,
    packageManagerVersion: version,
    code: peerConflict ? 'RESOLUTION_CONFLICT' : 'RESOLVER_FAILED',
    explanation: `Isolated resolver verification failed: ${details}`,
  };
}

export class IsolatedResolverVerifier implements ResolverVerifier {
  private readonly runner: ResolverProcessRunner;

  constructor(private readonly options: IsolatedResolverVerifierOptions) {
    this.runner = options.runner ?? new NodeResolverProcessRunner();
  }

  async verify(proposal: UpgradeProposal, signal?: AbortSignal): Promise<ResolverVerification> {
    const manifest = parseManifestObject(this.options.manifestText);
    applyProposal(manifest, proposal);
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-preflight-'));
    try {
      await writeFile(path.join(tempRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      if (this.options.lockfile !== undefined) {
        await writeFile(path.join(tempRoot, this.options.lockfile.name), this.options.lockfile.text, 'utf8');
      }
      const result = await this.runner.run(
        this.options.invocation,
        buildResolverArgs(this.options.packageManager, this.options.registry, this.options.policy),
        tempRoot,
        signal
      );
      return verificationForResult(
        this.options.packageManager,
        this.options.packageManagerVersion,
        result,
        tempRoot
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}
