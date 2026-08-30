import { vulnerabilityIdentifiers } from './identifiers.js';
import type { AttributedAdvisory, PackageRow, Severity } from '../types.js';

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  info: 0,
};

export interface VulnerabilityFindingMetric {
  /** Stable detector identity. Public aliases are presentation data, not identity. */
  key: string;
  sourceId: string;
  identifiers: readonly string[];
  flaggedPackage: string;
  severity: Severity;
  title: string;
  directRoots: readonly string[];
}

export interface VulnerabilitySnapshotMetrics {
  /** Direct dependency rows through which at least one finding is reachable. */
  affectedDirectDependencies: number;
  /** Unique npm advisory + flagged-package findings, independent of path count. */
  advisoryFindings: number;
  severity: Readonly<Record<Severity, number>>;
  findings: readonly VulnerabilityFindingMetric[];
}

/**
 * npm's source id is stable across optional CVE/GHSA alias enrichment. The
 * flagged package remains part of the key because remediation is
 * package-specific even when a public identifier is shared.
 */
export function canonicalAdvisoryFindingKey(attributed: AttributedAdvisory): string {
  return `${typeof attributed.advisory.id}:${String(attributed.advisory.id)}\u0000${attributed.flaggedPackage}`;
}

export function vulnerabilitySnapshotMetrics(rows: readonly PackageRow[]): VulnerabilitySnapshotMetrics {
  const findings = new Map<string, {
    attributed: AttributedAdvisory;
    directRoots: Set<string>;
  }>();
  const affectedRoots = new Set<string>();

  for (const row of rows) {
    if (row.advisories.length > 0) affectedRoots.add(row.name);
    for (const attributed of row.advisories) {
      const key = canonicalAdvisoryFindingKey(attributed);
      const existing = findings.get(key);
      if (existing === undefined) {
        findings.set(key, { attributed, directRoots: new Set([row.name]) });
      } else {
        existing.directRoots.add(row.name);
      }
    }
  }

  const severity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    info: 0,
  };
  const normalized = [...findings.entries()].map(([key, value]) => {
    severity[value.attributed.advisory.severity] += 1;
    return {
      key,
      sourceId: String(value.attributed.advisory.id),
      identifiers: vulnerabilityIdentifiers(value.attributed.advisory),
      flaggedPackage: value.attributed.flaggedPackage,
      severity: value.attributed.advisory.severity,
      title: value.attributed.advisory.title,
      directRoots: [...value.directRoots].sort((left, right) => left.localeCompare(right, 'en')),
    };
  }).sort((left, right) =>
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
    left.flaggedPackage.localeCompare(right.flaggedPackage, 'en') ||
    left.key.localeCompare(right.key, 'en')
  );

  return {
    affectedDirectDependencies: affectedRoots.size,
    advisoryFindings: normalized.length,
    severity,
    findings: normalized,
  };
}
