import * as vscode from 'vscode';

import { deepestContainingRepository, stableGitHeadIdentity } from './gitHeadState.js';

interface GitBranch {
  commit?: string;
  name?: string;
  upstream?: { remote?: string; name?: string };
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD: GitBranch | undefined;
    onDidChange(listener: () => void): vscode.Disposable;
  };
}

interface GitApi {
  repositories: readonly GitRepository[];
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

/**
 * Optional adapter over VS Code's built-in Git extension. Activation,
 * disabled Git, non-repositories, and incompatible exports are all quiet
 * fallbacks; ordinary file watchers remain independently active.
 */
export async function watchGitHead(
  projectPath: string,
  onHeadChanged: () => void
): Promise<vscode.Disposable | undefined> {
  try {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (extension === undefined) return undefined;
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const api = exports?.getAPI?.(1);
    if (api === undefined) return undefined;
    const repository = deepestContainingRepository(
      api.repositories.map((candidate) => ({ rootPath: candidate.rootUri.fsPath, value: candidate })),
      projectPath
    );
    if (repository === undefined) return undefined;

    let identity = stableGitHeadIdentity(repository.state.HEAD);
    return repository.state.onDidChange(() => {
      const next = stableGitHeadIdentity(repository.state.HEAD);
      if (next === identity) return;
      identity = next;
      onHeadChanged();
    });
  } catch {
    return undefined;
  }
}
