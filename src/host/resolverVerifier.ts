/**
 * Package-manager resolver verification in an isolated temporary project.
 *
 * The safety boundary is the temporary directory, not a package manager's
 * interpretation of "dry run": only a host-owned manifest and active
 * lockfile are copied, workspace configuration is deliberately not copied,
 * lifecycle scripts are disabled, and the real project is never the cwd.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type {
  ResolverVerification,
  ResolverVerifier,
  SupportedPackageManager,
  UpgradeProposal,
} from '../core/compatibility/types.js';
import type { PeerResolutionPolicy } from '../core/compatibility/types.js';
import { buildDependencyGraph } from '../core/lockfile/build.js';
import { parseManifest } from '../core/manifest/parse.js';
import { buildStagedManifest } from '../core/upgrade/stagedManifest.js';
import type { DependencyGraph } from '../core/types.js';

export interface PackageManagerInvocation {
  executable: string;
  prefixArgs: readonly string[];
  /** May be captured by the invocation resolver's existing health probe. */
  version?: string;
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

/**
 * Argv for the "materialize a real lockfile" step used by
 * `materializeResolvedGraph` — `--package-lock-only`/`--lockfile-only` runs
 * the real resolver and writes a real lockfile without downloading
 * `node_modules` content. This is deliberately a separate argv builder from
 * `buildResolverArgs`: that one is a dry-run that writes nothing, this one
 * must actually produce a lockfile to parse.
 */
export function buildLockfileMaterializationArgs(
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
      '--package-lock-only',
      '--ignore-scripts',
      '--audit=false',
      '--fund=false',
      '--json',
      `--registry=${registry}`,
      ...policyArgs,
    ];
  }
  return [
    'install',
    '--lockfile-only',
    '--ignore-scripts',
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
    const stagedManifest = buildStagedManifest(
      this.options.manifestText,
      proposal.changes.map((change) => ({
        packageName: change.packageName,
        target: change.targetVersion,
        classification: change.classification,
      }))
    );
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-preflight-'));
    try {
      await writeFile(path.join(tempRoot, 'package.json'), stagedManifest, 'utf8');
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

  /**
   * Best-effort: materializes the real, proposed post-upgrade dependency tree
   * by running the real package manager's own resolver in the same isolated
   * temp-dir pattern as `verify()`, then parsing its output lockfile with the
   * existing lockfile parser — never a second, hand-rolled resolver. Used
   * only to answer "does a transitive vulnerability remain" (see
   * evaluateSecurityOutcome in src/core/advisories/securityOutcome.ts); any
   * failure here degrades that answer to `unknown`, never a wrong guess.
   *
   * `proposal.changes` may be empty — this is the "no direct-dependency
   * version change proposed at all" case a transitive-remediation analysis
   * uses (see resolveRemediationRequest / handleAnalyzeRemediation): the
   * manifest is staged unchanged, and whether the lockfile passed to this
   * verifier's constructor is supplied determines whether the package
   * manager reuses it or resolves fully fresh from declared ranges.
   * `buildStagedManifest` itself rejects an empty change list (it exists to
   * pin exact versions, which there are none of here), so that step is
   * skipped entirely rather than passed a list it would reject.
   */
  async materializeResolvedGraph(
    proposal: UpgradeProposal,
    signal?: AbortSignal
  ): Promise<{ ok: true; graph: DependencyGraph } | { ok: false }> {
    const stagedManifest =
      proposal.changes.length === 0
        ? this.options.manifestText
        : buildStagedManifest(
            this.options.manifestText,
            proposal.changes.map((change) => ({
              packageName: change.packageName,
              target: change.targetVersion,
              classification: change.classification,
            }))
          );
    const lockfileName = this.options.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-security-outcome-'));
    try {
      await writeFile(path.join(tempRoot, 'package.json'), stagedManifest, 'utf8');
      if (this.options.lockfile !== undefined) {
        await writeFile(path.join(tempRoot, this.options.lockfile.name), this.options.lockfile.text, 'utf8');
      }
      const result = await this.runner.run(
        this.options.invocation,
        buildLockfileMaterializationArgs(this.options.packageManager, this.options.registry, this.options.policy),
        tempRoot,
        signal
      );
      if (result.exitCode !== 0) return { ok: false };

      const lockfileText = await readFile(path.join(tempRoot, lockfileName), 'utf8');
      const manifest = parseManifest(stagedManifest);
      const graph = buildDependencyGraph({
        root: tempRoot,
        manifest,
        lockfileText,
        packageManager: this.options.packageManager,
      });
      return { ok: true, graph };
    } catch {
      return { ok: false };
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}
