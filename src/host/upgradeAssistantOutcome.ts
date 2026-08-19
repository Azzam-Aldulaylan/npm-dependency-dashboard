import type { UpgradeTransactionResult } from './upgradeTransaction.js';
import type { ProtocolError } from './webviewProtocol.js';

export type UpgradeCompletionPresentation =
  | { kind: 'verified'; message: string }
  | { kind: 'unverified'; message: string }
  | { kind: 'rolled-back'; message: string }
  | { kind: 'error'; error: ProtocolError };

/**
 * Converts the transaction state machine's result into the exact host-facing
 * outcome shown to the user. Keeping this pure makes the distinction between
 * a file rollback and an installed-module rollback explicit and testable.
 */
export function describeUpgradeTransactionOutcome(
  packageName: string,
  packageManager: 'npm' | 'pnpm',
  transaction: UpgradeTransactionResult
): UpgradeCompletionPresentation {
  // Rollback status takes precedence over completion. This avoids ever
  // overstating restoration if a malformed or future result combines an
  // optimistic completion value with a conflict/I/O failure.
  if (transaction.rollback.status === 'conflict') {
    return {
      kind: 'error',
      error: {
        code: 'ROLLBACK_CONFLICT',
        message:
          'Rollback was incomplete because dependency files changed concurrently; newer edits were preserved. ' +
          'Some transaction-owned files may already have been restored. node_modules was not restored. ' +
          `Review package.json and the active lockfile before running ${packageManager} install.`,
      },
    };
  }
  if (transaction.rollback.status === 'failed') {
    return {
      kind: 'error',
      error: {
        code: 'ROLLBACK_FAILED',
        message:
          'Rollback failed for one or more dependency files. Some transaction-owned files may already have been restored. ' +
          'node_modules was not restored. ' +
          `Review package.json and the active lockfile before running ${packageManager} install.`,
      },
    };
  }

  if (transaction.reason === 'manifest-stage-failed' && transaction.manifestStage.status === 'failed') {
    return transaction.manifestStage.code === 'CONFLICT'
      ? {
          kind: 'error',
          error: {
            code: 'STALE_SOURCE',
            message: 'package.json changed before the coordinated upgrade could start. No upgrade files were modified; refresh and try again.',
          },
        }
      : {
          kind: 'error',
          error: {
            code: 'MANIFEST_STAGE_FAILED',
            message: 'The coordinated package.json changes could not be staged, so the package-manager install was not started.',
          },
        };
  }

  if (transaction.completion === 'kept' && transaction.reason === 'verified') {
    return { kind: 'verified', message: `Upgraded ${packageName}; verification passed.` };
  }
  if (transaction.completion === 'kept') {
    return {
      kind: 'unverified',
      message: `Upgraded ${packageName}, but the application upgrade is not verified.`,
    };
  }
  if (transaction.completion === 'rolled-back') {
    return {
      kind: 'rolled-back',
      message:
        `Dependency files for ${packageName} were restored to their pre-upgrade state. ` +
        `node_modules was not restored; run ${packageManager} install to reconcile installed packages with the restored lockfile.`,
    };
  }

  return {
    kind: 'error',
    error: {
      code: 'UPGRADE_TRANSACTION_FAILED',
      message: 'The upgrade transaction did not reach a verified or fully restored state. Review package.json and the lockfile.',
    },
  };
}

function describeRemovedPackages(packageNames: readonly string[]): string {
  return packageNames.length === 1 ? (packageNames[0] ?? '') : `${packageNames.length} dependencies`;
}

/** describeUpgradeTransactionOutcome's removal analog — same transaction result shape, same precedence rules, remove-specific wording. */
export function describeRemoveTransactionOutcome(
  packageNames: readonly string[],
  packageManager: 'npm' | 'pnpm',
  transaction: UpgradeTransactionResult
): UpgradeCompletionPresentation {
  const removed = describeRemovedPackages(packageNames);

  if (transaction.rollback.status === 'conflict') {
    return {
      kind: 'error',
      error: {
        code: 'ROLLBACK_CONFLICT',
        message:
          'Rollback was incomplete because dependency files changed concurrently; newer edits were preserved. ' +
          'Some transaction-owned files may already have been restored. node_modules was not restored. ' +
          `Review package.json and the active lockfile before running ${packageManager} install.`,
      },
    };
  }
  if (transaction.rollback.status === 'failed') {
    return {
      kind: 'error',
      error: {
        code: 'ROLLBACK_FAILED',
        message:
          'Rollback failed for one or more dependency files. Some transaction-owned files may already have been restored. ' +
          'node_modules was not restored. ' +
          `Review package.json and the active lockfile before running ${packageManager} install.`,
      },
    };
  }

  if (transaction.reason === 'manifest-stage-failed' && transaction.manifestStage.status === 'failed') {
    return transaction.manifestStage.code === 'CONFLICT'
      ? {
          kind: 'error',
          error: {
            code: 'STALE_SOURCE',
            message: 'package.json changed before the removal could start. No files were modified; refresh and try again.',
          },
        }
      : {
          kind: 'error',
          error: {
            code: 'MANIFEST_STAGE_FAILED',
            message: 'The package.json removal could not be staged, so the package-manager install was not started.',
          },
        };
  }

  if (transaction.completion === 'kept' && transaction.reason === 'verified') {
    return { kind: 'verified', message: `Removed ${removed}; verification passed.` };
  }
  if (transaction.completion === 'kept') {
    return {
      kind: 'unverified',
      message: `Removed ${removed}, but the application is not verified after removal.`,
    };
  }
  if (transaction.completion === 'rolled-back') {
    return {
      kind: 'rolled-back',
      message:
        `Dependency files for ${removed} were restored to their pre-removal state. ` +
        `node_modules was not restored; run ${packageManager} install to reconcile installed packages with the restored lockfile.`,
    };
  }

  return {
    kind: 'error',
    error: {
      code: 'REMOVE_TRANSACTION_FAILED',
      message: 'The removal transaction did not reach a verified or fully restored state. Review package.json and the lockfile.',
    },
  };
}
