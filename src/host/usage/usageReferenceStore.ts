/**
 * Trusted lookup for "Open file" / "Go to line" on a usage-analysis
 * reference — the security boundary described in the redesign brief:
 *
 *   Webview:  open reference { usageId, referenceIndex }
 *   Host:     resolve trusted reference ID -> workspace containment check
 *             (already applied once, at scan time, by relativeToFolder in
 *             workspaceFiles.ts) -> open file/line
 *
 * The webview never sends a filesystem path or a line number — only an
 * opaque id this store issued, plus an index into the reference array *that
 * same result* already carries. A forged id, a stale id (past its TTL), or
 * an out-of-range index all resolve to null; the caller treats that exactly
 * like "nothing to open", never a hard error.
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import type { DependencyReference, DependencyUsageResult } from '../../core/usage/types.js';
import { USAGE_ANALYSIS_REUSE_MS } from './usageAnalysisState.js';

interface StoredUsageResult {
  packageName: string;
  result: DependencyUsageResult;
  folder: vscode.WorkspaceFolder;
  expiresAt: number;
}

export class UsageReferenceStore {
  private readonly entries = new Map<string, StoredUsageResult>();

  constructor(private readonly ttlMs: number = USAGE_ANALYSIS_REUSE_MS) {}

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(id);
    }
  }

  /** Stores one completed usage result and returns the opaque id future open-reference requests must present. */
  store(packageName: string, result: DependencyUsageResult, folder: vscode.WorkspaceFolder): string {
    this.sweep();
    const id = randomBytes(16).toString('hex');
    this.entries.set(id, { packageName, result, folder, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  /** Null for a forged/expired id or an out-of-range index — never partially trusted. */
  resolveReference(
    usageId: string,
    referenceIndex: number
  ): { folder: vscode.WorkspaceFolder; reference: DependencyReference } | null {
    const entry = this.entries.get(usageId);
    if (entry === undefined || Date.now() >= entry.expiresAt) return null;
    const reference = entry.result.references[referenceIndex];
    if (reference === undefined) return null;
    return { folder: entry.folder, reference };
  }

  clear(): void {
    this.entries.clear();
  }
}
