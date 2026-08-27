import * as path from 'node:path';

export interface GitHeadLike {
  commit?: string;
  name?: string;
  upstream?: { remote?: string; name?: string };
}

export interface GitRepositoryLike<T = unknown> {
  rootPath: string;
  value: T;
}

/** Status-only repository events retain this identity and are ignored. */
export function stableGitHeadIdentity(head: GitHeadLike | undefined): string | null {
  if (head === undefined) return null;
  return JSON.stringify([
    head.commit ?? null,
    head.name ?? null,
    head.upstream?.remote ?? null,
    head.upstream?.name ?? null,
  ]);
}

function containsPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Nested repositories win because their root is the deepest containing root. */
export function deepestContainingRepository<T>(
  repositories: readonly GitRepositoryLike<T>[],
  projectPath: string
): T | undefined {
  return repositories
    .filter((repository) => containsPath(repository.rootPath, projectPath))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0]?.value;
}
