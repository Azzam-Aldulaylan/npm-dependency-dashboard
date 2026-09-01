import semver from 'semver';
import { createProjectCompatibilityFinding } from './findings.js';
import type { ProjectImportReference } from './imports.js';
import type { ProjectCompatibilityAnalyzerResult, ProjectCompatibilityIdentity } from './types.js';

/** Deliberately scoped: deprecated import entry points, not symbol/prop analysis.
 * Each rule requires documented target-version applicability and a real import.
 * Source: https://nextjs.org/docs/pages/api-reference/components/image-legacy
 * Next 16 deprecates next/legacy/image; deprecation is not a confirmed break. */
export function analyzeDeprecatedApis(input: {
  identity: ProjectCompatibilityIdentity;
  references: readonly ProjectImportReference[];
  sourceComplete: boolean;
}): ProjectCompatibilityAnalyzerResult {
  const analyzerId = 'deprecated-api-compatibility';
  if (input.identity.packageName !== 'next' || !semver.satisfies(input.identity.targetVersion, '>=16.0.0 <17.0.0')) {
    return { analyzerId, status: 'unavailable', findings: [], unavailableReason: 'deprecated-api-rules-unavailable' };
  }
  const findings = input.references.filter((reference) => reference.specifier === 'next/legacy/image').map((reference) =>
    createProjectCompatibilityFinding(input.identity, {
      ruleId: 'next-16-legacy-image-deprecated', category: 'framework-migration', confidence: 'review',
      source: 'framework-rule', title: 'Deprecated Image component import',
      explanation: 'This project imports next/legacy/image, which is deprecated in Next.js 16. Deprecated does not mean removed.',
      migrationHint: 'Migrate to next/image and review its prop and layout differences. See https://nextjs.org/docs/pages/api-reference/components/image-legacy.',
      evidence: [{
        kind: 'source-reference', filePath: reference.filePath, line: reference.line,
        column: reference.column, snippet: reference.snippet, specifier: reference.specifier,
        ...(reference.usageId === undefined ? {} : { usageId: reference.usageId }),
        ...(reference.referenceIndex === undefined ? {} : { referenceIndex: reference.referenceIndex }),
      }],
      discriminator: [reference.filePath, reference.line, reference.column, reference.specifier],
    })
  );
  return {
    analyzerId, status: input.sourceComplete ? 'complete' : 'partial', findings,
    ...(input.sourceComplete ? {} : { unavailableReason: 'project-source-scan-truncated' }),
  };
}
