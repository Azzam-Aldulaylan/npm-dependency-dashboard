/**
 * Pure presentation decisions shared by the Manage dependency workspace and
 * the standalone analysis dialogs. Keeping labels and semantic variants here
 * prevents two views of the same action from drifting apart.
 */

import type { UpgradeAnalysisPresentation } from './webviewProtocol.js';

export type SemanticButtonVariant = 'primary' | 'caution' | 'danger' | 'secondary' | 'subtle';

export interface UpgradeConfirmationAction {
  label: string;
  onClick: 'confirm' | 'use-smart-plan';
  variant: 'primary' | 'caution';
}

/** The final action offered after upgrade analysis, including its visual semantics. */
export function upgradeConfirmationAction(
  analysis: Pick<UpgradeAnalysisPresentation, 'changes' | 'compatibility' | 'smartPlan' | 'targetVersion'>
): UpgradeConfirmationAction | null {
  if (analysis.compatibility.status === 'conflict') {
    return analysis.smartPlan !== null
      ? { label: 'Use coordinated upgrade', onClick: 'use-smart-plan', variant: 'primary' }
      : null;
  }

  const caution = analysis.compatibility.status === 'warning' || analysis.compatibility.status === 'unknown';
  return {
    label:
      analysis.changes.length > 1
        ? caution
          ? `Upgrade ${analysis.changes.length} anyway`
          : `Upgrade ${analysis.changes.length} dependencies`
        : caution
          ? 'Upgrade anyway'
          : `Upgrade to ${analysis.targetVersion}`,
    onClick: 'confirm',
    variant: caution ? 'caution' : 'primary',
  };
}

export interface BulkRemovalAction {
  label: string;
  variant: 'primary' | 'danger';
}

/**
 * Bulk removal is a two-phase action: analysis is safe and forward-moving;
 * only the operation offered after a complete impact review is destructive.
 */
export function bulkRemovalAction(selectedCount: number, impactReady: boolean): BulkRemovalAction {
  return impactReady
    ? { label: `Remove ${selectedCount}`, variant: 'danger' }
    : {
        label: `Analyze removal impact${selectedCount > 0 ? ` (${selectedCount})` : ''}`,
        variant: 'primary',
      };
}

export function semanticButtonClassName(variant: SemanticButtonVariant, layoutClass?: string): string {
  return `button button--${variant}${layoutClass === undefined ? '' : ` ${layoutClass}`}`;
}
