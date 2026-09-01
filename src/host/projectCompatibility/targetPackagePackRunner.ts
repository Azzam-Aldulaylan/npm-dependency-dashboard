/** Bounded, script-free inventory process lifecycle; settle only after child cleanup. */
import type { PackageManagerInvocation, ResolverProcessResult } from '../resolverVerifier.js';
import { NodePackageManagerProcessRunner } from '../packageManagerProcessRunner.js';

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const TARGET_PACKAGE_INSPECTION_TIMEOUT_MS = 20_000;
const TARGET_PACKAGE_TERMINATION_GRACE_MS = 1_000;

export interface TargetPackagePackRunner {
  run(
    invocation: PackageManagerInvocation,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<ResolverProcessResult>;
}

export class NodeTargetPackagePackRunner implements TargetPackagePackRunner {
  private readonly runner: NodePackageManagerProcessRunner;

  constructor(options: { timeoutMs?: number; terminationGraceMs?: number } = {}) {
    this.runner = new NodePackageManagerProcessRunner({
      description: 'Target package inventory inspection',
      timeoutMs: options.timeoutMs ?? TARGET_PACKAGE_INSPECTION_TIMEOUT_MS,
      terminationGraceMs: options.terminationGraceMs ?? TARGET_PACKAGE_TERMINATION_GRACE_MS,
      stdoutLimitBytes: MAX_STDOUT_BYTES,
      stdoutPolicy: 'reject',
    });
  }

  run(
    invocation: PackageManagerInvocation,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<ResolverProcessResult> {
    return this.runner.run(invocation, args, cwd, signal);
  }
}
