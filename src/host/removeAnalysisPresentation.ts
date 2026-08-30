/**
 * Assembles the one JSON-safe payload the remove review/confirm modal
 * renders from — the removal analog of upgradeAnalysisPresentation.ts. See
 * that file's own comment for why the wire shape lives in webviewProtocol.ts
 * rather than here.
 */

import type { DependencyClassification } from '../core/upgrade/plan.js';
import type { RemoveAnalysisPresentation } from './webviewProtocol.js';

export interface BuildRemoveAnalysisPresentationOptions {
  analysisId: string;
  /** The first, host-validated package in the requested removal — see BulkUpgradeMessage's own anchor-package convention. */
  packageName: string;
  changes: readonly {
    packageName: string;
    classification: DependencyClassification;
    stillRequiredBy: readonly string[];
  }[];
  verificationScriptNames: readonly string[];
  manifestPath: string;
  lockfilePath: string;
  dedupe?: { actionId: string; affectedPackages: readonly string[]; expectedRemovedVersions: number };
}

export function buildRemoveAnalysisPresentation(
  options: BuildRemoveAnalysisPresentationOptions
): RemoveAnalysisPresentation {
  return {
    analysisId: options.analysisId,
    package: options.packageName,
    changes: options.changes.map((change) => ({
      packageName: change.packageName,
      classification: change.classification,
      stillRequiredBy: [...change.stillRequiredBy],
    })),
    verification:
      options.verificationScriptNames.length > 0
        ? { configured: true, scriptNames: [...options.verificationScriptNames] }
        : { configured: false },
    files: {
      manifestPath: options.manifestPath,
      lockfilePath: options.lockfilePath,
      // Same guarantee as an upgrade transaction — runUpgradeTransaction
      // always attempts a compare-and-swap restore of exactly these two
      // allowlisted files on failure.
      rollbackAvailable: true,
    },
    ...(options.dedupe === undefined
      ? {}
      : {
          dedupe: {
            actionId: options.dedupe.actionId,
            affectedPackages: [...options.dedupe.affectedPackages],
            expectedRemovedVersions: options.dedupe.expectedRemovedVersions,
          },
        }),
  };
}
