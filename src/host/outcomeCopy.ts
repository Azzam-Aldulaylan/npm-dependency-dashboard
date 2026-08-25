/**
 * Status → {label, className} for the two outcome vocabularies the Upgrade
 * Analysis modal renders: compatibility (compatible/warning/conflict/unknown)
 * and security (resolved/remains/unknown/not-applicable). Mirrors
 * severityDisplay.ts's own pattern exactly — a pure, host-side lookup so it's
 * unit-testable, imported by the webview the same way SeverityBadge already
 * imports severityDisplay.
 *
 * `className` follows the existing `severity--*`/`status-badge--*` BEM-ish
 * convention in webview/src/styles.css (`outcome--*`), so a new status never
 * needs a new one-off class name invented at the call site.
 */

import type { CompatibilityStatus, SecurityOutcomeStatus } from './webviewProtocol.js';

export interface OutcomeDisplay {
  label: string;
  className: string;
}

const COMPATIBILITY_LABELS: Record<CompatibilityStatus, string> = {
  compatible: 'Compatible',
  warning: 'Compatible with warnings',
  conflict: 'Compatibility conflict',
  unknown: 'Compatibility incomplete',
};

export function compatibilityOutcomeDisplay(status: CompatibilityStatus): OutcomeDisplay {
  return { label: COMPATIBILITY_LABELS[status], className: status };
}

const SECURITY_LABELS: Record<SecurityOutcomeStatus, string> = {
  resolved: 'All known vulnerabilities addressed',
  remains: 'A known vulnerability remains',
  unknown: 'Security outcome could not be fully verified',
  'not-applicable': 'No known vulnerabilities',
};

export function securityOutcomeDisplay(status: SecurityOutcomeStatus): OutcomeDisplay {
  return { label: SECURITY_LABELS[status], className: status };
}

const UPGRADE_SAFETY_LABELS: Record<CompatibilityStatus, string> = {
  compatible: 'Upgrade is safe',
  warning: 'Upgrade has warnings',
  conflict: 'Upgrade is blocked',
  unknown: 'Upgrade safety is unknown',
};

/** Same compatibility status, phrased as the Upgrade review tab's own one-line headline — never a second, independently-derived safety judgment. */
export function upgradeSafetyHeadline(status: CompatibilityStatus): OutcomeDisplay {
  return { label: UPGRADE_SAFETY_LABELS[status], className: status };
}

const RESOLVER_LABELS: Record<CompatibilityStatus, string> = {
  compatible: 'Package manager resolution succeeded',
  warning: 'Package manager resolution succeeded with warnings',
  conflict: 'Package manager resolution failed',
  unknown: 'Resolution could not be verified',
};

/** Resolver evidence reuses the same four-state vocabulary as overall compatibility, per spec — never its own separate wording. */
export function resolverOutcomeDisplay(status: CompatibilityStatus): OutcomeDisplay {
  return { label: RESOLVER_LABELS[status], className: status };
}
