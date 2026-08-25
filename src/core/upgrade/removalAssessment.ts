/**
 * Classifies a package's removal impact from already-gathered evidence into
 * one of four honest outcomes — see `RemovalAssessment`'s own doc in
 * src/core/types.ts for why they are never collapsed.
 *
 * This is a pure function over evidence the host has already gathered
 * (a usage-analyzer scan, a peer-requirement graph walk, a
 * `stillRequiredBy` transitive check) — it never re-derives, re-scans, or
 * fetches anything itself, and it never runs the underlying scan more than
 * once regardless of how many packages are being assessed in the same batch
 * (see src/host/removal/removalImpactCoordinator.ts, which reuses one
 * `analyzeDependencyUsage` call across the whole batch).
 */

import type { DependencyReference } from '../usage/types.js';
import type { RemovalAssessment, RemovalEvidence } from '../types.js';
import type { PeerRequirementEvidence } from './peerRequirement.js';

export interface RemovalAssessmentInputs {
  /**
   * `null` means the workspace usage scan for this package did not complete
   * — not attempted, cancelled, or failed. Never treated as "no references
   * found"; see the `unknown` branch below.
   */
  usage: { references: readonly DependencyReference[]; truncated: boolean } | null;
  peerRequirements: readonly PeerRequirementEvidence[];
  /** Other still-kept direct dependencies whose subtree still resolves through this package — informational only, never a blocker. */
  stillRequiredBy: readonly string[];
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function sourceEvidence(references: readonly DependencyReference[]): RemovalEvidence | null {
  const count = references.filter((r) => r.kind === 'import' || r.kind === 'require' || r.kind === 'dynamic-import').length;
  return count === 0 ? null : { kind: 'source-reference', summary: `Used in ${pluralize(count, 'file')}` };
}

function scriptEvidence(references: readonly DependencyReference[]): RemovalEvidence | null {
  const scripts = [...new Set(references.filter((r) => r.kind === 'script').map((r) => r.context ?? r.filePath))];
  return scripts.length === 0
    ? null
    : { kind: 'script-reference', summary: `Referenced by package.json script${scripts.length === 1 ? '' : 's'}: ${scripts.join(', ')}` };
}

function configEvidence(references: readonly DependencyReference[]): RemovalEvidence | null {
  const files = [...new Set(references.filter((r) => r.kind === 'config').map((r) => r.context ?? r.filePath))];
  return files.length === 0
    ? null
    : { kind: 'config-reference', summary: `Referenced by config file${files.length === 1 ? '' : 's'}: ${files.join(', ')}` };
}

function peerEvidence(requirement: PeerRequirementEvidence): RemovalEvidence {
  return requirement.optional
    ? { kind: 'peer-requirement', summary: `${requirement.requiredBy} has an optional peer dependency on this package` }
    : { kind: 'peer-requirement', summary: `${requirement.requiredBy} requires this package as a peer dependency` };
}

function transitiveEvidence(stillRequiredBy: readonly string[]): RemovalEvidence | null {
  return stillRequiredBy.length === 0
    ? null
    : { kind: 'transitive-dependency', summary: `Still required transitively by ${stillRequiredBy.join(', ')}` };
}

export function assessRemoval(inputs: RemovalAssessmentInputs): RemovalAssessment {
  const requiredPeers = inputs.peerRequirements.filter((p) => !p.optional);
  const optionalPeers = inputs.peerRequirements.filter((p) => p.optional);

  if (requiredPeers.length > 0) {
    return { status: 'blocked', evidence: requiredPeers.map(peerEvidence) };
  }

  if (inputs.usage === null) {
    return { status: 'unknown', evidence: [{ kind: 'source-reference', summary: 'Workspace usage analysis was incomplete or cancelled.' }] };
  }

  const source = sourceEvidence(inputs.usage.references);
  const script = scriptEvidence(inputs.usage.references);
  const config = configEvidence(inputs.usage.references);
  const transitive = transitiveEvidence(inputs.stillRequiredBy);

  const reviewEvidence = [source, script, config, ...optionalPeers.map(peerEvidence)].filter(
    (entry): entry is RemovalEvidence => entry !== null
  );

  if (reviewEvidence.length > 0) {
    return { status: 'review', evidence: transitive === null ? reviewEvidence : [...reviewEvidence, transitive] };
  }

  // No source/script/config/optional-peer evidence found. A truncated scan
  // (file cap reached, or cancelled) cannot prove "no known references" —
  // that conclusion is only trustworthy from a complete scan.
  if (inputs.usage.truncated) {
    return {
      status: 'unknown',
      evidence: [{ kind: 'source-reference', summary: 'The workspace scan did not cover every file — results may be incomplete.' }],
    };
  }

  return { status: 'low-risk', evidence: transitive === null ? [] : [transitive] };
}
