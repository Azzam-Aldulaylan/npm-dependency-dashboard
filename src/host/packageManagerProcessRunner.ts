/** Shared bounded output and cancellation lifecycle for isolated package-manager analysis. */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';

import type { PackageManagerInvocation, ResolverProcessResult } from './resolverVerifier.js';

interface ProcessOptions {
  description: string;
  /** Omitted means the caller's existing cancellation policy, not a new deadline. */
  timeoutMs?: number;
  terminationGraceMs?: number;
  stdoutLimitBytes?: number;
  stdoutPolicy?: 'tail' | 'reject';
}

export class NodePackageManagerProcessRunner {
  constructor(private readonly options: ProcessOptions) {
    for (const limit of [options.timeoutMs, options.terminationGraceMs, options.stdoutLimitBytes]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647)) {
        throw new Error('Package-manager process limits must be positive 32-bit integers.');
      }
    }
  }

  run(invocation: PackageManagerInvocation, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<ResolverProcessResult> {
    return new Promise((resolve, reject) => {
      const abortError = (): Error => Object.assign(new Error(`${this.options.description} was cancelled.`), { name: 'AbortError' });
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const child = spawn(invocation.executable, [...invocation.prefixArgs, ...args], {
        cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        // A dedicated POSIX group lets cancellation reach resolver children
        // such as git, without ever signalling the extension host's group.
        detached: process.platform !== 'win32',
      });
      const stdoutLimit = this.options.stdoutLimitBytes ?? 32_768;
      const rejectOversized = this.options.stdoutPolicy === 'reject';
      let stdout = '';
      const stdoutDecoder = new StringDecoder('utf8');
      let stdoutTail: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutBytes = 0;
      let failure: Error | undefined;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let treeTermination: Promise<void> | undefined;
      const terminate = (killSignal: NodeJS.Signals): void => {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid, killSignal); }
          catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(killSignal);
          }
        } else if (process.platform === 'win32' && child.pid !== undefined) {
          // Windows has no POSIX process groups. Wait for taskkill as well as
          // the original child's close before releasing its temp directory.
          treeTermination ??= new Promise<void>((done) => {
            const killer = spawn(path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
              shell: false, windowsHide: true, stdio: 'ignore',
            });
            const killerTimeout = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL'); }, 2_000);
            killerTimeout.unref();
            killer.once('error', () => child.kill('SIGKILL'));
            killer.once('close', (code) => {
              clearTimeout(killerTimeout);
              if (code !== 0) child.kill('SIGKILL');
              done();
            });
          });
        } else child.kill(killSignal);
      };
      const stop = (error: Error): void => {
        if (failure !== undefined) return;
        failure = error;
        terminate('SIGTERM');
        terminationTimer = setTimeout(() => terminate('SIGKILL'), this.options.terminationGraceMs ?? 1_000);
        terminationTimer.unref();
      };
      const abort = (): void => stop(abortError());
      const timeout = this.options.timeoutMs === undefined ? undefined : setTimeout(() => stop(Object.assign(
        new Error(`${this.options.description} timed out.`), { name: 'TimeoutError' }
      )), this.options.timeoutMs);
      timeout?.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure !== undefined) return;
        if (rejectOversized) {
          stdoutBytes += chunk.length;
          if (stdoutBytes > stdoutLimit) stop(new Error(`${this.options.description} exceeded the response limit.`));
          else stdout += stdoutDecoder.write(chunk);
        } else stdoutTail = Buffer.concat([stdoutTail, chunk]).subarray(-stdoutLimit);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]).subarray(-32_768);
      });
      child.on('error', (error) => { failure ??= error; });
      child.on('close', () => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        signal?.removeEventListener('abort', abort);
        if (failure !== undefined) {
          // A leader can exit before a descendant that ignored SIGTERM.
          // Force the remaining isolated group down before returning.
          if (terminationTimer !== undefined) terminate('SIGKILL');
          void (treeTermination ?? Promise.resolve()).then(() => reject(failure));
        } else resolve({ exitCode: child.exitCode,
          stdout: rejectOversized ? stdout + stdoutDecoder.end() : stdoutTail.toString('utf8'),
          stderr: stderr.toString('utf8') });
      });
    });
  }
}
