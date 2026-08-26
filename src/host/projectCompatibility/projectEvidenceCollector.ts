/** Host-owned, bounded project evidence collection for pre-upgrade checks. */

import * as vscode from 'vscode';
import { createHash } from 'node:crypto';

import { scanFilesBounded } from '../../core/usage/boundedFileScan.js';
import { scanSourceForImportSpecifiers } from '../../core/usage/importScan.js';
import type { ProjectImportReference } from '../../core/projectCompatibility/imports.js';
import type { NextRuleProjectFile } from '../../core/projectCompatibility/rules/next/index.js';
import {
  findConfigFiles,
  findSourceFiles,
  readTextFileCapped,
  relativeToFolder,
} from '../usage/workspaceFiles.js';
import {
  parseProjectManifestCompatibilityEvidence,
  projectCompatibilityScanIsTruncated,
  shouldRetainFrameworkRuleFile,
  type ProjectManifestCompatibilityEvidence,
} from './projectEvidenceParsing.js';

export {
  parseProjectManifestCompatibilityEvidence,
  projectCompatibilityScanIsTruncated,
  shouldRetainFrameworkRuleFile,
  type ProjectManifestCompatibilityEvidence,
} from './projectEvidenceParsing.js';

const DEFAULT_MAX_FILES = 6_000;
const MAX_IMPORT_REFERENCES = 400;
const MAX_FRAMEWORK_RULE_FILES = 200;

export interface CollectedProjectCompatibilityEvidence extends ProjectManifestCompatibilityEvidence {
  imports: ProjectImportReference[];
  ruleFiles: NextRuleProjectFile[];
  scannedFileCount: number;
  truncated: boolean;
  /** Stable digest of only the source/config evidence this analysis consumed. */
  evidenceFingerprint: string;
}

function evidenceFingerprint(input: {
  manifest: ProjectManifestCompatibilityEvidence;
  imports: readonly ProjectImportReference[];
  ruleFiles: readonly NextRuleProjectFile[];
  truncated: boolean;
}): string {
  return createHash('sha256').update(JSON.stringify({
    manifest: input.manifest,
    imports: input.imports,
    ruleFiles: input.ruleFiles,
    truncated: input.truncated,
  }), 'utf8').digest('hex');
}

export async function collectProjectCompatibilityEvidence(input: {
  folder: vscode.WorkspaceFolder;
  dir: string;
  manifestText: string;
  packageName: string;
  signal?: AbortSignal;
  maxFiles?: number;
}): Promise<CollectedProjectCompatibilityEvidence> {
  const manifest = parseProjectManifestCompatibilityEvidence(input.manifestText);
  const cancellation = new vscode.CancellationTokenSource();
  const abort = (): void => cancellation.cancel();
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
    const sourceFiles = await findSourceFiles(input.folder, input.dir, maxFiles, cancellation.token);
    const imports: ProjectImportReference[] = [];
    const retainedFiles = new Map<string, NextRuleProjectFile>();
    let evidenceLimitReached = false;
    let failedReadCount = 0;
    const sourceScan = await scanFilesBounded({
      items: sourceFiles,
      read: readTextFileCapped,
      isCancelled: () => cancellation.token.isCancellationRequested,
      consume: (uri, content) => {
        const filePath = relativeToFolder(input.folder, uri);
        if (filePath === null) return;
        for (const match of scanSourceForImportSpecifiers(content)) {
          if (match.packageName !== input.packageName) continue;
          if (imports.length >= MAX_IMPORT_REFERENCES) {
            evidenceLimitReached = true;
            continue;
          }
          imports.push({
            specifier: match.specifier,
            kind: match.kind,
            filePath,
            line: match.line,
            column: match.column,
            snippet: match.snippet,
          });
        }
        if (shouldRetainFrameworkRuleFile(input.packageName, filePath)) {
          if (retainedFiles.size >= MAX_FRAMEWORK_RULE_FILES) evidenceLimitReached = true;
          else retainedFiles.set(filePath, { filePath, content });
        }
      },
      onReadFailure: () => { failedReadCount += 1; },
    });

    const configFiles = await findConfigFiles(input.folder, input.dir, cancellation.token);
    const configScan = await scanFilesBounded({
      items: configFiles,
      read: readTextFileCapped,
      isCancelled: () => cancellation.token.isCancellationRequested,
      consume: (uri, content) => {
        const filePath = relativeToFolder(input.folder, uri);
        if (filePath !== null) {
          if (!retainedFiles.has(filePath) && retainedFiles.size >= MAX_FRAMEWORK_RULE_FILES) evidenceLimitReached = true;
          else retainedFiles.set(filePath, { filePath, content });
        }
      },
      onReadFailure: () => { failedReadCount += 1; },
    });

    imports.sort((left, right) =>
      left.filePath.localeCompare(right.filePath) || left.line - right.line || left.column - right.column ||
      left.specifier.localeCompare(right.specifier)
    );
    const ruleFiles = [...retainedFiles.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
    const truncated = projectCompatibilityScanIsTruncated({
      discoveredSourceFiles: sourceFiles.length,
      maxFiles,
      sourceCancelled: sourceScan.cancelled,
      configCancelled: configScan.cancelled,
      failedReadCount,
      evidenceLimitReached,
    });
    return {
      ...manifest,
      imports,
      ruleFiles,
      scannedFileCount: sourceScan.processed,
      truncated,
      evidenceFingerprint: evidenceFingerprint({ manifest, imports, ruleFiles, truncated }),
    };
  } finally {
    input.signal?.removeEventListener('abort', abort);
    cancellation.dispose();
  }
}
