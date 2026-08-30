import type { UpgradeTransactionResult } from './upgradeTransaction.js';
import type { ProtocolError, UpgradeResultPresentation } from './webviewProtocol.js';

/** The sole application-state gate: task success alone never authorizes "applied". */
export function classifyUpgradeApplication(
  completion: UpgradeTransactionResult['completion'],
  structurallyCurrent: boolean,
  locallyConfirmed: boolean
): UpgradeResultPresentation['application'] {
  if (completion === 'rolled-back') return 'rolled-back';
  return completion === 'kept' && structurallyCurrent && locallyConfirmed ? 'applied' : 'unconfirmed';
}

/** A generation-raced snapshot may be displayed, but never enriched as current. */
export function classifyMutationEnrichmentStart(
  structurallyCurrent: boolean
): 'start-targeted' | 'superseded' {
  return structurallyCurrent ? 'start-targeted' : 'superseded';
}

export function canRetryMutationEnrichment(
  current: { refreshId: string; state: string } | undefined,
  requestedRefreshId: string
): boolean {
  return (
    current?.refreshId === requestedRefreshId &&
    (current.state === 'failed' || current.state === 'cancelled')
  );
}

export type UpgradeCompletionPresentation =
  | { kind: 'verified'; message: string }
  | { kind: 'unverified'; message: string }
  | { kind: 'unconfirmed'; message: string }
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
  transaction: UpgradeTransactionResult,
  appliedStateConfirmed = true
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

  if (transaction.completion === 'kept' && !appliedStateConfirmed) {
    return {
      kind: 'unconfirmed',
      message: 'Install completed, but the resulting dependency state could not be confirmed.',
    };
  }
  if (transaction.completion === 'kept' && transaction.reason === 'verified') {
    return { kind: 'verified', message: `Upgrade applied to ${packageName}; verification passed.` };
  }
  if (transaction.completion === 'kept') {
    return {
      kind: 'unverified',
      message:
        transaction.verification.status === 'failed'
          ? `Upgrade applied to ${packageName}, but verification failed and the changes were kept.`
          : `Upgrade applied to ${packageName}. Verification is not configured.`,
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
  transaction: UpgradeTransactionResult,
  options: { dedupe?: boolean } = {}
): UpgradeCompletionPresentation {
  const removed = describeRemovedPackages(packageNames);
  const applied = options.dedupe === true
    ? packageNames.length === 0
      ? 'Applied the reviewed project deduplication'
      : `Removed ${removed} and applied the reviewed project deduplication`
    : `Removed ${removed}`;

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
    return { kind: 'verified', message: `${applied}; verification passed.` };
  }
  if (transaction.completion === 'kept') {
    return {
      kind: 'unverified',
      message: `${applied}, but the application is not verified after cleanup.`,
    };
  }
  if (transaction.completion === 'rolled-back') {
    return {
      kind: 'rolled-back',
      message:
        (options.dedupe === true
          ? 'Dependency files for the selected cleanup actions were restored to their pre-cleanup state. '
          : `Dependency files for ${removed} were restored to their pre-removal state. `) +
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
