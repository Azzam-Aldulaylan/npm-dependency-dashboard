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
  UpgradeAnalysisCompatibility,
  UpgradeAnalysisPresentation,
  UpgradeAnalysisSmartPlan,
} from './webviewProtocol.js';
import type { SecurityOutcome } from './webviewProtocol.js';

export interface BuildUpgradeAnalysisPresentationOptions {
  analysisId: string;
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  classification: DependencyClassification;
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
  return {
    analysisId: options.analysisId,
    package: options.packageName,
    currentVersion: options.currentVersion,
    targetVersion: options.targetVersion,
    classification: options.classification,
    majorUpdate: isMajorUpgrade(options.currentVersion, options.targetVersion),
    compatibility: options.compatibility,
    security: options.security,
    smartPlan: options.smartPlan,
    verification:
      options.verificationScriptNames.length > 0
        ? { configured: true, scriptNames: [...options.verificationScriptNames] }
        : { configured: false },
    files: {
      manifestPath: options.manifestPath,
      lockfilePath: options.lockfilePath,
      // The transaction system (upgradeTransaction.ts) always attempts a
      // compare-and-swap restore of exactly these two allowlisted files on
      // failure — there is no execution path that reaches this presentation
      // without that guarantee applying.
      rollbackAvailable: true,
    },
  };
}
