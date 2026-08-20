/** Resolve pnpm as trusted JavaScript run by the already-resolved Node binary. */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type { NpmInvocation } from './npmResolver.js';
import type { PackageManagerInvocation } from './resolverVerifier.js';

export interface PnpmResolverDeps {
  exists(path: string): boolean;
  probe(executable: string, prefixArgs: readonly string[]): string | undefined;
}

export function pnpmInvocationCandidates(npm: NpmInvocation): PackageManagerInvocation[] {
  // npmCliJs is <global-root>/npm/bin/npm-cli.js for both POSIX and the
  // supported Windows layout. Only sibling, installation-owned packages are
  // considered; workspace node_modules is never searched.
  const globalRoot = path.dirname(path.dirname(path.dirname(npm.npmCliJs)));
  return [
    { executable: npm.node, prefixArgs: [path.join(globalRoot, 'pnpm', 'bin', 'pnpm.cjs')] },
    { executable: npm.node, prefixArgs: [path.join(globalRoot, 'corepack', 'dist', 'corepack.js'), 'pnpm'] },
    { executable: npm.node, prefixArgs: [path.join(globalRoot, 'corepack', 'dist', 'corepack.cjs'), 'pnpm'] },
  ];
}

export function resolvePnpmInvocation(
  npm: NpmInvocation,
  deps: PnpmResolverDeps
): PackageManagerInvocation | null {
  for (const candidate of pnpmInvocationCandidates(npm)) {
    const cli = candidate.prefixArgs[0];
    if (cli === undefined || !deps.exists(cli)) continue;
    const version = deps.probe(candidate.executable, candidate.prefixArgs);
    if (version !== undefined) return { ...candidate, version };
  }
  return null;
}

export function resolveInstalledPnpmInvocation(
  npm: NpmInvocation,
  cwd: string
): PackageManagerInvocation | null {
  return resolvePnpmInvocation(npm, {
    exists: existsSync,
    probe(executable, prefixArgs) {
      try {
        const output = execFileSync(executable, [...prefixArgs, '--version'], {
          cwd,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const version = output.trim();
        return version.length === 0 ? undefined : version.slice(0, 100);
      } catch {
        return undefined;
      }
    },
  });
}
