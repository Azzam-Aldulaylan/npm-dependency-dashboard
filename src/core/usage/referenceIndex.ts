import { scanSourceForImports } from './importScan.js';
import type { DependencyReference } from './types.js';

export type ImportScanner = typeof scanSourceForImports;

/**
 * Buckets all requested package references while each source file is parsed
 * exactly once, regardless of how many direct dependencies cleanup analyzes.
 */
export class UsageReferenceIndex {
  private readonly requested: ReadonlySet<string>;
  private readonly references = new Map<string, DependencyReference[]>();

  constructor(
    packageNames: readonly string[],
    private readonly scan: ImportScanner = scanSourceForImports
  ) {
    this.requested = new Set(packageNames);
    for (const name of this.requested) this.references.set(name, []);
  }

  addSourceFile(filePath: string, text: string): void {
    for (const match of this.scan(text)) {
      if (!this.requested.has(match.packageName)) continue;
      this.references.get(match.packageName)?.push({
        filePath,
        line: match.line,
        column: match.column,
        snippet: match.snippet,
        kind: match.kind,
      });
    }
  }

  addReference(packageName: string, reference: DependencyReference): void {
    this.references.get(packageName)?.push(reference);
  }

  forPackage(packageName: string): DependencyReference[] {
    return this.references.get(packageName) ?? [];
  }
}
