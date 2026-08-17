/**
 * On-demand workspace usage-analysis result model — shared by "Where is this
 * used?" and unused-dependency detection (see the redesign brief: "unused
 * detection and Where is this used? must share the same underlying
 * usage-analysis infrastructure"). Nothing here may import 'vscode'; the
 * actual workspace scan lives in src/host/usage/, which is vscode-aware.
 */

export type DependencyReferenceKind = 'import' | 'require' | 'dynamic-import' | 'script' | 'config';

export interface DependencyReference {
  /** Workspace-folder-relative, forward-slash path — never absolute, never outside the workspace. */
  filePath: string;
  /** 1-based. 0 for a reference with no meaningful line (none currently produced this way, but kept non-optional for a stable wire shape). */
  line: number;
  /** 1-based. */
  column: number;
  /** A short, trimmed source line — never a whole file. */
  snippet: string;
  kind: DependencyReferenceKind;
  /** For 'script', the package.json script name; for 'config', the recognized config file's own name. Absent for source-code references. */
  context?: string;
}

export interface DependencyUsageResult {
  packageName: string;
  references: DependencyReference[];
  /** True when the scan stopped before covering every eligible file (a workspace size cap, or cancellation) — `references` may be incomplete. */
  truncated: boolean;
  scannedFileCount: number;
  scannedAt: string;
}
