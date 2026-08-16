/**
 * Transactional orchestration for a dependency upgrade.
 *
 * This module intentionally has no `vscode` import. The real host supplies
 * filesystem, install, verification, and user-decision adapters, while this
 * state machine owns the safety-sensitive ordering:
 *
 *   snapshot -> install -> verify -> keep or compare-and-swap rollback
 *
 * Paths are an allowlist resolved by the trusted host. Nothing in this module
 * accepts a path, command, script, package, or argument from the webview.
 */

export type FileState =
  | { exists: false }
  | { exists: true; contents: Uint8Array };

export type CompareAndSwapResult = 'restored' | 'conflict';

export interface UpgradeTransactionFileAdapter {
  /** Read exact bytes, or report that the allowlisted file does not exist. */
  read(path: string): Promise<FileState>;
  /**
   * Atomically, or with the strongest equivalent protection the host can
   * provide, replace `expected` with `replacement`. A mismatch must return
   * `conflict` without modifying the file. This prevents rollback from
   * overwriting an edit made after the install completed.
   */
  compareAndSwap(
    path: string,
    expected: FileState,
    replacement: FileState
  ): Promise<CompareAndSwapResult>;
}

export type InstallExecutionResult =
  | { status: 'succeeded'; exitCode?: number }
  | { status: 'failed'; code: string; message: string; exitCode?: number | null }
  | { status: 'cancelled'; message: string; exitCode?: number | null };

export interface UpgradeInstallExecutor {
  /**
   * Runs a host-constructed install invocation. It deliberately receives no
   * AbortSignal: killing a package manager while it writes the manifest or
   * lockfile is less safe than waiting for it to reach a stable boundary.
   */
  execute(): Promise<InstallExecutionResult>;
}

export interface VerificationCheckResult {
  id: string;
  status: 'passed' | 'failed' | 'cancelled';
  message?: string;
}

export type VerificationExecutionResult =
  | { status: 'passed'; checks: readonly VerificationCheckResult[] }
  | { status: 'failed'; checks: readonly VerificationCheckResult[]; message?: string }
  | { status: 'cancelled'; checks: readonly VerificationCheckResult[]; message?: string };

export interface UpgradeVerifier {
  /**
   * Runs only host-approved checks. Like install, verification is allowed to
   * finish before cancellation is acted on so rollback never races a process
   * that could still be touching project files.
   */
  verify(): Promise<VerificationExecutionResult>;
}

export type VerificationFailureDecision = 'keep' | 'rollback';

export interface VerificationFailureDecider {
  /**
   * The adapter may show a host-owned prompt. The signal is safe here because
   * this phase performs no project mutation; aborting the wait selects rollback.
   */
  decide(
    result: Extract<VerificationResult, { status: 'failed' }>,
    signal: AbortSignal | undefined
  ): Promise<VerificationFailureDecision>;
}

export type SnapshotResult =
  | { status: 'not-run' }
  | { status: 'succeeded'; paths: readonly string[] }
  | { status: 'failed'; path: string; message: string };

export type InstallResult =
  | { status: 'not-run' }
  | InstallExecutionResult;

export type VerificationResult =
  | { status: 'not-run'; reason: 'not-configured' | 'install-failed' | 'cancelled' }
  | VerificationExecutionResult;

export interface RollbackFileResult {
  path: string;
  status: 'restored' | 'conflict' | 'failed';
  message?: string;
}

export type RollbackResult =
  | { status: 'not-needed' }
  | {
      status: 'succeeded' | 'conflict' | 'failed';
      files: readonly RollbackFileResult[];
    };

export type TransactionCompletion = 'kept' | 'rolled-back' | 'not-started' | 'incomplete';

export type TransactionReason =
  | 'verified'
  | 'verification-not-configured'
  | 'verification-failed'
  | 'install-failed'
  | 'cancelled'
  | 'snapshot-failed';

export interface UpgradeTransactionResult {
  completion: TransactionCompletion;
  reason: TransactionReason;
  snapshot: SnapshotResult;
  install: InstallResult;
  verification: VerificationResult;
  rollback: RollbackResult;
  /** Whether a failed-verification decision was needed and how it resolved. */
  retentionDecision: 'not-needed' | 'keep' | 'rollback' | 'cancelled' | 'failed';
}

export interface UpgradeTransactionOptions {
  /** Canonical, host-resolved files this transaction is allowed to restore. */
  allowlistedPaths: readonly string[];
  files: UpgradeTransactionFileAdapter;
  install: UpgradeInstallExecutor;
  verifier?: UpgradeVerifier;
  /** Defaults to rollback when omitted. */
  verificationFailureDecider?: VerificationFailureDecider;
  signal?: AbortSignal;
}

interface SnapshotEntry {
  path: string;
  before: FileState;
}

type ExpectedEntry =
  | { snapshot: SnapshotEntry; expected: FileState }
  | { snapshot: SnapshotEntry; captureError: string };

function cloneState(state: FileState): FileState {
  if (!state.exists) return { exists: false };
  return { exists: true, contents: Uint8Array.from(state.contents) };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function stableAllowlist(paths: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

async function takeSnapshot(
  paths: readonly string[],
  files: UpgradeTransactionFileAdapter
): Promise<{ ok: true; entries: SnapshotEntry[] } | { ok: false; result: SnapshotResult }> {
  const entries: SnapshotEntry[] = [];
  for (const path of paths) {
    try {
      entries.push({ path, before: cloneState(await files.read(path)) });
    } catch (cause) {
      return {
        ok: false,
        result: { status: 'failed', path, message: errorMessage(cause) },
      };
    }
  }
  return { ok: true, entries };
}

async function captureExpectedStates(
  entries: readonly SnapshotEntry[],
  files: UpgradeTransactionFileAdapter
): Promise<ExpectedEntry[]> {
  const expected: ExpectedEntry[] = [];
  for (const snapshot of entries) {
    try {
      expected.push({ snapshot, expected: cloneState(await files.read(snapshot.path)) });
    } catch (cause) {
      expected.push({ snapshot, captureError: errorMessage(cause) });
    }
  }
  return expected;
}

async function rollback(
  entries: readonly ExpectedEntry[],
  files: UpgradeTransactionFileAdapter
): Promise<RollbackResult> {
  const results: RollbackFileResult[] = [];

  for (const entry of entries) {
    if ('captureError' in entry) {
      results.push({
        path: entry.snapshot.path,
        status: 'failed',
        message: `Could not capture post-install state: ${entry.captureError}`,
      });
      continue;
    }

    try {
      const result = await files.compareAndSwap(
        entry.snapshot.path,
        cloneState(entry.expected),
        cloneState(entry.snapshot.before)
      );
      results.push({ path: entry.snapshot.path, status: result });
    } catch (cause) {
      results.push({
        path: entry.snapshot.path,
        status: 'failed',
        message: errorMessage(cause),
      });
    }
  }

  if (results.some((result) => result.status === 'failed')) {
    return { status: 'failed', files: results };
  }
  if (results.some((result) => result.status === 'conflict')) {
    return { status: 'conflict', files: results };
  }
  return { status: 'succeeded', files: results };
}

function completionAfterRollback(result: RollbackResult): TransactionCompletion {
  return result.status === 'succeeded' ? 'rolled-back' : 'incomplete';
}

async function executeInstall(executor: UpgradeInstallExecutor): Promise<InstallExecutionResult> {
  try {
    return await executor.execute();
  } catch (cause) {
    return { status: 'failed', code: 'INSTALL_EXECUTOR_ERROR', message: errorMessage(cause) };
  }
}

async function executeVerification(verifier: UpgradeVerifier): Promise<VerificationExecutionResult> {
  try {
    return await verifier.verify();
  } catch (cause) {
    return {
      status: 'failed',
      checks: [],
      message: `Verification could not run: ${errorMessage(cause)}`,
    };
  }
}

async function decideAfterFailure(
  decider: VerificationFailureDecider | undefined,
  verification: Extract<VerificationResult, { status: 'failed' }>,
  signal: AbortSignal | undefined
): Promise<{ decision: VerificationFailureDecision; status: UpgradeTransactionResult['retentionDecision'] }> {
  if (decider === undefined) return { decision: 'rollback', status: 'rollback' };
  if (cancelled(signal)) return { decision: 'rollback', status: 'cancelled' };

  try {
    if (signal === undefined) {
      const decision = await decider.decide(verification, undefined);
      return { decision, status: decision };
    }

    const decision = await new Promise<VerificationFailureDecision>((resolve, reject) => {
      let settled = false;
      const finish = (value: VerificationFailureDecision): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      };
      const onAbort = (): void => finish('rollback');
      signal.addEventListener('abort', onAbort, { once: true });
      // Abort may have landed between the pre-check above and listener
      // registration; AbortSignal does not replay an already-fired event.
      if (signal.aborted) onAbort();
      decider.decide(verification, signal).then(finish, fail);
    });
    return {
      decision,
      status: cancelled(signal) ? 'cancelled' : decision,
    };
  } catch {
    return { decision: 'rollback', status: 'failed' };
  }
}

/** Run one complete upgrade transaction without throwing operational failures. */
export async function runUpgradeTransaction(
  options: UpgradeTransactionOptions
): Promise<UpgradeTransactionResult> {
  const paths = stableAllowlist(options.allowlistedPaths);
  const notRun: Pick<UpgradeTransactionResult, 'install' | 'verification' | 'rollback' | 'retentionDecision'> = {
    install: { status: 'not-run' },
    verification: { status: 'not-run', reason: 'cancelled' },
    rollback: { status: 'not-needed' },
    retentionDecision: 'not-needed',
  };

  if (cancelled(options.signal)) {
    return {
      completion: 'not-started',
      reason: 'cancelled',
      snapshot: { status: 'not-run' },
      ...notRun,
    };
  }

  const snapshot = await takeSnapshot(paths, options.files);
  if (!snapshot.ok) {
    return {
      completion: 'not-started',
      reason: 'snapshot-failed',
      snapshot: snapshot.result,
      ...notRun,
    };
  }
  const snapshotResult: SnapshotResult = { status: 'succeeded', paths };

  // Cancellation before the mutating command is a clean stop: nothing needs
  // restoration because this transaction has not changed a file yet.
  if (cancelled(options.signal)) {
    return {
      completion: 'not-started',
      reason: 'cancelled',
      snapshot: snapshotResult,
      ...notRun,
    };
  }

  // Once install starts it is always awaited. Cancellation is observed only
  // after it reaches this stable boundary, then handled by rollback.
  const install = await executeInstall(options.install);
  const expected = await captureExpectedStates(snapshot.entries, options.files);

  if (install.status !== 'succeeded') {
    const rolledBack = await rollback(expected, options.files);
    return {
      completion: completionAfterRollback(rolledBack),
      reason: install.status === 'cancelled' || cancelled(options.signal) ? 'cancelled' : 'install-failed',
      snapshot: snapshotResult,
      install,
      verification: {
        status: 'not-run',
        reason: install.status === 'cancelled' || cancelled(options.signal) ? 'cancelled' : 'install-failed',
      },
      rollback: rolledBack,
      retentionDecision: 'rollback',
    };
  }

  if (cancelled(options.signal)) {
    const rolledBack = await rollback(expected, options.files);
    return {
      completion: completionAfterRollback(rolledBack),
      reason: 'cancelled',
      snapshot: snapshotResult,
      install,
      verification: { status: 'not-run', reason: 'cancelled' },
      rollback: rolledBack,
      retentionDecision: 'rollback',
    };
  }

  if (options.verifier === undefined) {
    return {
      completion: 'kept',
      reason: 'verification-not-configured',
      snapshot: snapshotResult,
      install,
      verification: { status: 'not-run', reason: 'not-configured' },
      rollback: { status: 'not-needed' },
      retentionDecision: 'not-needed',
    };
  }

  // Verification also reaches a stable boundary before cancellation can
  // initiate rollback, so rollback cannot race an in-flight verification.
  const verification = await executeVerification(options.verifier);

  if (cancelled(options.signal) || verification.status === 'cancelled') {
    const rolledBack = await rollback(expected, options.files);
    return {
      completion: completionAfterRollback(rolledBack),
      reason: 'cancelled',
      snapshot: snapshotResult,
      install,
      verification,
      rollback: rolledBack,
      retentionDecision: 'rollback',
    };
  }

  if (verification.status === 'passed') {
    return {
      completion: 'kept',
      reason: 'verified',
      snapshot: snapshotResult,
      install,
      verification,
      rollback: { status: 'not-needed' },
      retentionDecision: 'not-needed',
    };
  }

  const retention = await decideAfterFailure(
    options.verificationFailureDecider,
    verification,
    options.signal
  );
  if (retention.decision === 'keep' && !cancelled(options.signal)) {
    return {
      completion: 'kept',
      reason: 'verification-failed',
      snapshot: snapshotResult,
      install,
      verification,
      rollback: { status: 'not-needed' },
      retentionDecision: 'keep',
    };
  }

  const rolledBack = await rollback(expected, options.files);
  return {
    completion: completionAfterRollback(rolledBack),
    reason: cancelled(options.signal) ? 'cancelled' : 'verification-failed',
    snapshot: snapshotResult,
    install,
    verification,
    rollback: rolledBack,
    retentionDecision: retention.status,
  };
}
