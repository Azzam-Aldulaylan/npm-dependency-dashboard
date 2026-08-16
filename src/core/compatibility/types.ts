import type { DependencyClassification } from '../upgrade/plan.js';
import type { PackageVersionMetadata } from '../registry/versions.js';

export type CompatibilityStatus = 'compatible' | 'warning' | 'conflict' | 'unknown';
export type CompatibilityCompleteness = 'complete' | 'partial';
export type SupportedPackageManager = 'npm' | 'pnpm';

/** One exact, host-validated manifest change under consideration. */
export interface UpgradeChange {
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  classification: DependencyClassification;
}

/**
 * A proposal is a set from the start so coordinated-upgrade planning consumes
 * the same compatibility model as a one-package preflight.
 */
export interface UpgradeProposal {
  requested: UpgradeChange;
  changes: UpgradeChange[];
}

export type CompatibilityFindingKind =
  | 'peer-compatible'
  | 'peer-incompatible'
  | 'peer-missing'
  | 'optional-peer-missing'
  | 'invalid-peer-range'
  | 'metadata-unavailable'
  | 'graph-metadata-incomplete'
  | 'major-version-change';

export interface CompatibilitySubject {
  name: string;
  version: string | null;
  nodeId: string | null;
}

export interface PeerRequirement {
  name: string;
  range: string;
  optional: boolean;
}

/** A deterministic package-name path from a direct dependency to the subject. */
export interface DependencyRelation {
  kind: 'direct' | 'transitive' | 'peer';
  nodeIds: string[];
  packageNames: string[];
}

export interface CompatibilityFinding {
  /** Stable machine-readable identifier within one analysis result. */
  id: string;
  kind: CompatibilityFindingKind;
  status: CompatibilityStatus;
  source: 'static';
  subject: CompatibilitySubject;
  requirement?: PeerRequirement;
  observedVersion?: string | null;
  relation: DependencyRelation;
  explanation: string;
}

export interface ResolverVerification {
  status: CompatibilityStatus;
  packageManager: SupportedPackageManager;
  packageManagerVersion: string | null;
  code: string;
  /** Sanitized, bounded summary. Never a command line or raw process output. */
  explanation: string;
}

export interface CompatibilityAnalysis {
  proposal: UpgradeProposal;
  status: CompatibilityStatus;
  completeness: CompatibilityCompleteness;
  findings: CompatibilityFinding[];
  resolverVerification?: ResolverVerification;
}

export interface PeerResolutionPolicy {
  strictPeerDeps: boolean;
  legacyPeerDeps: boolean;
}

/** Injectable, project-independent metadata seam; implementations may cache globally. */
export interface PackageMetadataProvider {
  getPackageVersionMetadata(
    packageName: string,
    version: string,
    signal?: AbortSignal
  ): Promise<PackageVersionMetadata>;
}

/** Host-owned package-manager simulation seam. Core never starts a process. */
export interface ResolverVerifier {
  verify(proposal: UpgradeProposal, signal?: AbortSignal): Promise<ResolverVerification>;
}
