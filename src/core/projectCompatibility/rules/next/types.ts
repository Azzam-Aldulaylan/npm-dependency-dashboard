import type {
  ProjectCompatibilityCategory,
  ProjectCompatibilityConfidence,
  ProjectCompatibilityFinding,
  ProjectCompatibilityIdentity,
} from '../../types.js';

export interface NextRuleProjectFile {
  /** Workspace-relative display path. This is never navigation authority. */
  filePath: string;
  content: string;
  /** Optional host-issued tuple resolved by the trusted usage reference store. */
  usageId?: string;
  referenceIndex?: number;
}

export interface NextRuleProjectEvidence {
  files: readonly NextRuleProjectFile[];
  scripts: Readonly<Record<string, string>>;
  /** Raw manifest declarations. Invalid/tag/git/workspace declarations stay unknown. */
  declaredDependencies: Readonly<Record<string, string>>;
}

export interface NextRuleAnalysisInput extends NextRuleProjectEvidence {
  identity: ProjectCompatibilityIdentity;
}

export interface NextProjectCompatibilityRule {
  id: string;
  packageName: 'next';
  targetRange: string;
  affectedSourceRange?: string;
  category: ProjectCompatibilityCategory;
  confidence: ProjectCompatibilityConfidence;
  evaluate(input: NextRuleAnalysisInput): ProjectCompatibilityFinding[];
}
