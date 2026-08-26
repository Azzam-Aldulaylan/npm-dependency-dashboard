/**
 * Assembles the one JSON-safe payload the Upgrade Analysis modal renders
 * from — the replacement for the flat string `confirmUpgrade()` used to build
 * (src/host/upgradeRunner.ts, now removed).
 *
 * The wire shape (`UpgradeAnalysisPresentation` and its nested types) is
 * *defined* in src/host/webviewProtocol.ts, not here — see that file's own
 * comment for why (it must stay reachable from the webview's Node-free
 * typecheck, which this file, and the real `CompatibilityFinding`/
 * `SecurityOutcome` types it consumes, are not). Passing `analysis.findings`
 * (core's `CompatibilityFinding[]`) into a field typed as the wire
 * `CompatibilityFinding[]` needs no conversion — the shapes are structurally
 * identical, so TypeScript accepts it directly.
 *
 * This is where new user-facing *structure* is allowed to live in `src/host`:
 * findings/security-outcome are passed through with their already-structured
 * fields intact (`kind`, `status`, `subject`, `requirement`, `relation`)
 * rather than collapsed into prose — the webview's own presentation helpers
 * (findingCopy.ts, outcomeCopy.ts) build the actual copy from those fields,
 * the same way severityDisplay.ts already does for `Severity`. Nothing here
 * imports `vscode`.
 */

import { isMajorUpgrade } from '../core/upgrade/plan.js';
import type { DependencyClassification } from '../core/upgrade/plan.js';
import type {
  UpgradeAnalysisChange,
  UpgradeAnalysisCompatibility,
  UpgradeAnalysisFiles,
  UpgradeAnalysisPresentation,
  UpgradeAnalysisSmartPlan,
  UpgradeAnalysisVerification,
} from './webviewProtocol.js';
import type { SecurityOutcome } from './webviewProtocol.js';

export interface BuildUpgradeAnalysisChangesOptions {
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  classification: DependencyClassification;
  changes?: readonly {
    packageName: string;
    currentVersion: string;
    targetVersion: string;
    classification: DependencyClassification;
  }[];
}

/**
 * Shared by the Stage-0 `overview` partial (upgradeAssistantCoordinator.ts)
 * and the final buildUpgradeAnalysisPresentation below, so the two can never
 * compute a different `changes` array for the same analysis.
 */
export function buildUpgradeAnalysisChanges(options: BuildUpgradeAnalysisChangesOptions): UpgradeAnalysisChange[] {
  const changes = options.changes ?? [{
    packageName: options.packageName,
    currentVersion: options.currentVersion,
    targetVersion: options.targetVersion,
    classification: options.classification,
  }];
  return changes.map((change) => ({
    ...change,
    majorUpdate: isMajorUpgrade(change.currentVersion, change.targetVersion),
  }));
}

/** Shared by the Stage-0 `overview` partial and buildUpgradeAnalysisPresentation below. */
export function buildUpgradeAnalysisVerification(verificationScriptNames: readonly string[]): UpgradeAnalysisVerification {
  return verificationScriptNames.length > 0
    ? { configured: true, scriptNames: [...verificationScriptNames] }
    : { configured: false };
}

/** Shared by the Stage-0 `overview` partial and buildUpgradeAnalysisPresentation below. */
export function buildUpgradeAnalysisFiles(manifestPath: string, lockfilePath: string): UpgradeAnalysisFiles {
  return {
    manifestPath,
    lockfilePath,
    // The transaction system (upgradeTransaction.ts) always attempts a
    // compare-and-swap restore of exactly these two allowlisted files on
    // failure — there is no execution path that reaches this presentation
    // without that guarantee applying.
    rollbackAvailable: true,
  };
}

export interface BuildUpgradeAnalysisPresentationOptions extends BuildUpgradeAnalysisChangesOptions {
  analysisId: string;
  /** ISO timestamp — computed once by the coordinator at final-assembly time, passed in rather than computed here so this builder stays deterministic/pure. */
  analyzedAt: string;
  /** ISO timestamp derived from the exact stored-analysis retention deadline. */
  expiresAt: string;
  compatibility: UpgradeAnalysisCompatibility;
  security: SecurityOutcome | null;
  smartPlan: UpgradeAnalysisSmartPlan | null;
  verificationScriptNames: readonly string[];
  manifestPath: string;
  lockfilePath: string;
}

export function buildUpgradeAnalysisPresentation(
  options: BuildUpgradeAnalysisPresentationOptions
): UpgradeAnalysisPresentation {
  const changes = buildUpgradeAnalysisChanges(options);
  return {
    analysisId: options.analysisId,
    analyzedAt: options.analyzedAt,
    expiresAt: options.expiresAt,
    package: options.packageName,
    currentVersion: options.currentVersion,
    targetVersion: options.targetVersion,
    classification: options.classification,
    majorUpdate: isMajorUpgrade(options.currentVersion, options.targetVersion),
    changes,
    compatibility: options.compatibility,
    security: options.security,
    smartPlan: options.smartPlan,
    verification: buildUpgradeAnalysisVerification(options.verificationScriptNames),
    files: buildUpgradeAnalysisFiles(options.manifestPath, options.lockfilePath),
  };
}
