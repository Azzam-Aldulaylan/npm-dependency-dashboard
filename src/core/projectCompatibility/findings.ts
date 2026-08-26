import semver from 'semver';

import { isSafeNpmPackageName } from '../upgrade/plan.js';
import type {
  ProjectCompatibilityCategory,
  ProjectCompatibilityConfidence,
  ProjectCompatibilityEvidence,
  ProjectCompatibilityFinding,
  ProjectCompatibilityIdentity,
} from './types.js';

const MAX_IDENTITY_VALUE_LENGTH = 512;

export class InvalidProjectCompatibilityIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProjectCompatibilityIdentityError';
  }
}
export function validateProjectCompatibilityIdentity(identity: ProjectCompatibilityIdentity): void {
  if (!isSafeNpmPackageName(identity.packageName)) {
    throw new InvalidProjectCompatibilityIdentityError('Compatibility package name is invalid.');
  }
  if (semver.valid(identity.currentVersion) === null || semver.valid(identity.targetVersion) === null) {
    throw new InvalidProjectCompatibilityIdentityError('Compatibility versions must be exact semver.');
  }
  if (!semver.gt(identity.targetVersion, identity.currentVersion)) {
    throw new InvalidProjectCompatibilityIdentityError('Compatibility target must be newer than current.');
  }
  for (const value of [identity.requestId, identity.sourceFingerprint]) {
    if (value.length === 0 || value.length > MAX_IDENTITY_VALUE_LENGTH) {
      throw new InvalidProjectCompatibilityIdentityError('Compatibility correlation identity is invalid.');
    }
  }
}

export function createProjectCompatibilityFindingId(
  identity: ProjectCompatibilityIdentity,
  ruleId: string,
  discriminator: readonly (string | number)[] = []
): string {
  return JSON.stringify([
    identity.packageName,
    identity.targetVersion,
    identity.sourceFingerprint,
    ruleId,
    ...discriminator,
  ]);
}

export function createProjectCompatibilityFinding(
  identity: ProjectCompatibilityIdentity,
  input: {
    ruleId: string;
    category: ProjectCompatibilityCategory;
    confidence: ProjectCompatibilityConfidence;
    title: string;
    explanation: string;
    migrationHint?: string;
    evidence?: readonly ProjectCompatibilityEvidence[];
    source?: ProjectCompatibilityFinding['source'];
    discriminator?: readonly (string | number)[];
  }
): ProjectCompatibilityFinding {
  const base: ProjectCompatibilityFinding = {
    id: createProjectCompatibilityFindingId(identity, input.ruleId, input.discriminator),
    category: input.category,
    confidence: input.confidence,
    packageName: identity.packageName,
    targetVersion: identity.targetVersion,
    title: input.title,
    explanation: input.explanation,
    evidence: [...(input.evidence ?? [])],
    source: input.source ?? 'generic',
    ruleId: input.ruleId,
  };
  if (input.migrationHint !== undefined) base.migrationHint = input.migrationHint;
  return base;
}
