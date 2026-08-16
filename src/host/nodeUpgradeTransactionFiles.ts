/**
 * Real Node filesystem adapter for upgrade transactions.
 *
 * The factory binds an explicit host-owned allowlist to one canonical
 * workspace root. Every operation revalidates containment and refuses a
 * symlink at the file itself or the nearest existing ancestor. The adapter
 * never accepts a path merely because it happens to be under the workspace;
 * it must exactly match an entry supplied to the factory.
 *
 * Node does not expose a general filesystem compare-and-swap primitive for an
 * existing pathname. We therefore use the strongest practical construction:
 * read/compare, prepare exact replacement bytes in the same directory,
 * read/compare again immediately before an atomic rename. Restoring a file
 * that is expected to be absent uses `link`, which is atomically no-clobber;
 * deleting a transaction-created file similarly performs a second comparison
 * immediately before unlink. Callers must still serialize dashboard-owned
 * operations around a transaction.
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  link,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';

import type {
  CompareAndSwapResult,
  FileState,
  UpgradeTransactionFileAdapter,
} from './upgradeTransaction.js';

export type UpgradeTransactionPathErrorCode =
  | 'PATH_NOT_ALLOWLISTED'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SYMLINK_NOT_ALLOWED'
  | 'INVALID_ALLOWLIST';

export class UpgradeTransactionPathError extends Error {
  constructor(
    readonly code: UpgradeTransactionPathErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'UpgradeTransactionPathError';
  }
}

export interface NodeUpgradeTransactionFileAdapterOptions {
  /** Workspace-folder root, not a selected workspace member's project root. */
  workspaceRoot: string;
  /** Absolute manifest/active-lockfile paths resolved by the trusted host. */
  allowlistedPaths: readonly string[];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function stateEquals(left: FileState, right: FileState): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return Buffer.from(left.contents).equals(Buffer.from(right.contents));
}

function cloneState(state: FileState): FileState {
  if (!state.exists) return { exists: false };
  return { exists: true, contents: Uint8Array.from(state.contents) };
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'ENOENT'
  );
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
      const parent = path.dirname(current);
      if (parent === current) throw cause;
      current = parent;
    }
  }
}

async function assertNoSymlinkComponents(base: string, candidate: string): Promise<void> {
  const relative = path.relative(base, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return;
  }

  let current = base;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new UpgradeTransactionPathError(
          'SYMLINK_NOT_ALLOWED',
          `Upgrade transaction path uses a symbolic link: ${current}`
        );
      }
    } catch (cause) {
      if (isMissing(cause)) return;
      throw cause;
    }
  }
}

async function assertSafeCanonicalPath(
  lexicalRoot: string,
  canonicalRoot: string,
  candidate: string
): Promise<void> {
  const componentBase = isWithin(lexicalRoot, candidate) ? lexicalRoot : canonicalRoot;
  await assertNoSymlinkComponents(componentBase, candidate);
  const existing = await nearestExistingPath(candidate);
  const stat = await lstat(existing);
  if (stat.isSymbolicLink()) {
    throw new UpgradeTransactionPathError(
      'SYMLINK_NOT_ALLOWED',
      `Upgrade transaction path uses a symbolic link: ${existing}`
    );
  }

  const canonicalExisting = await realpath(existing);
  if (canonicalExisting !== canonicalRoot && !isWithin(canonicalRoot, canonicalExisting)) {
    throw new UpgradeTransactionPathError(
      'PATH_OUTSIDE_WORKSPACE',
      `Upgrade transaction path is outside the workspace: ${candidate}`
    );
  }

  // If the file itself exists, nearestExistingPath returned it. Refuse a
  // canonical result outside the root even when the lexical path looked safe.
  if (existing === candidate && !isWithin(canonicalRoot, canonicalExisting)) {
    throw new UpgradeTransactionPathError(
      'PATH_OUTSIDE_WORKSPACE',
      `Upgrade transaction file is outside the workspace: ${candidate}`
    );
  }
}

class NodeUpgradeTransactionFileAdapter implements UpgradeTransactionFileAdapter {
  constructor(
    private readonly lexicalRoot: string,
    private readonly canonicalRoot: string,
    private readonly allowed: ReadonlySet<string>
  ) {}

  private async resolveAllowed(candidate: string): Promise<string> {
    const resolved = path.resolve(candidate);
    if (!this.allowed.has(resolved)) {
      throw new UpgradeTransactionPathError(
        'PATH_NOT_ALLOWLISTED',
        `Path is not owned by this upgrade transaction: ${candidate}`
      );
    }
    await assertSafeCanonicalPath(this.lexicalRoot, this.canonicalRoot, resolved);
    return resolved;
  }

  async read(candidate: string): Promise<FileState> {
    const resolved = await this.resolveAllowed(candidate);
    let handle;
    try {
      // O_NOFOLLOW closes the leaf-symlink race between the lstat/realpath
      // validation above and opening the file on platforms that support it.
      handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      return { exists: true, contents: Uint8Array.from(await handle.readFile()) };
    } catch (cause) {
      if (isMissing(cause)) return { exists: false };
      throw cause;
    } finally {
      await handle?.close();
    }
  }

  async compareAndSwap(
    candidate: string,
    expected: FileState,
    replacement: FileState
  ): Promise<CompareAndSwapResult> {
    const resolved = await this.resolveAllowed(candidate);
    const current = await this.read(resolved);
    if (!stateEquals(current, expected)) return 'conflict';

    if (!replacement.exists) {
      if (!expected.exists) return 'restored';
      const justBeforeDelete = await this.read(resolved);
      if (!stateEquals(justBeforeDelete, expected)) return 'conflict';
      try {
        await unlink(resolved);
        return 'restored';
      } catch (cause) {
        // Disappearance after the second comparison is a concurrent change,
        // not a rollback write failure.
        if (isMissing(cause)) return 'conflict';
        throw cause;
      }
    }

    const temporary = path.join(
      path.dirname(resolved),
      `.${path.basename(resolved)}.dependency-dashboard-${randomUUID()}.tmp`
    );
    let temporaryCreated = false;
    try {
      const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(replacement.contents);
        await handle.sync();
      } finally {
        await handle.close();
      }

      const justBeforeReplace = await this.read(resolved);
      if (!stateEquals(justBeforeReplace, expected)) return 'conflict';

      if (!expected.exists) {
        // Unlike rename, link never overwrites a file that appeared after the
        // comparison. Both paths are in one directory/filesystem.
        try {
          await link(temporary, resolved);
        } catch (cause) {
          const code =
            typeof cause === 'object' && cause !== null && 'code' in cause
              ? (cause as { code?: unknown }).code
              : undefined;
          if (code === 'EEXIST') return 'conflict';
          throw cause;
        }
        return 'restored';
      }

      // Same-directory rename is atomic for readers. Node/filesystems do not
      // offer a conditional rename, hence the second exact-byte check above.
      await rename(temporary, resolved);
      temporaryCreated = false;
      return 'restored';
    } finally {
      if (temporaryCreated) await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export async function createNodeUpgradeTransactionFileAdapter(
  options: NodeUpgradeTransactionFileAdapterOptions
): Promise<UpgradeTransactionFileAdapter> {
  const root = path.resolve(options.workspaceRoot);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new UpgradeTransactionPathError(
      'SYMLINK_NOT_ALLOWED',
      `Workspace root must not be a symbolic link: ${root}`
    );
  }
  const canonicalRoot = await realpath(root);

  const allowed = new Set<string>();
  for (const raw of options.allowlistedPaths) {
    if (raw.length === 0 || !path.isAbsolute(raw)) {
      throw new UpgradeTransactionPathError(
        'INVALID_ALLOWLIST',
        'Upgrade transaction allowlist entries must be non-empty absolute paths.'
      );
    }
    const resolved = path.resolve(raw);
    if (!isWithin(root, resolved) && !isWithin(canonicalRoot, resolved)) {
      throw new UpgradeTransactionPathError(
        'PATH_OUTSIDE_WORKSPACE',
        `Upgrade transaction path is outside the workspace: ${raw}`
      );
    }
    await assertSafeCanonicalPath(root, canonicalRoot, resolved);
    allowed.add(resolved);
  }

  if (allowed.size === 0) {
    throw new UpgradeTransactionPathError(
      'INVALID_ALLOWLIST',
      'An upgrade transaction requires at least one allowlisted file.'
    );
  }

  return new NodeUpgradeTransactionFileAdapter(root, canonicalRoot, allowed);
}

/** Exposed for adapters/tests that need exact FileState comparison semantics. */
export function fileStatesEqual(left: FileState, right: FileState): boolean {
  return stateEquals(cloneState(left), cloneState(right));
}
