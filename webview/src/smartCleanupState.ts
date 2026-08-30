import type { Severity } from '../../src/core/types.js';

export const SMART_CLEANUP_MAX_ACTIONS = 150;
export const SMART_CLEANUP_REVIEW_CACHE_MS = 60 * 60_000;

export type SmartCleanupCategory = 'unused' | 'deprecated' | 'duplicates' | 'security';
export type SmartCleanupConfidence = 'safe' | 'review' | 'blocked' | 'unknown';
export type SmartCleanupAnalysisStepStatus = 'waiting' | 'running' | 'complete' | 'unavailable';

export interface SmartCleanupAnalysisStep {
  id: 'usage' | 'removal-safety' | 'deprecation' | 'duplicates';
  label: string;
  status: SmartCleanupAnalysisStepStatus;
  detail?: string;
}

/**
 * The only executable Smart Cleanup v1 action. `id` is presentation-local,
 * never execution authority: the host re-derives the named direct dependency,
 * rereads project files, and issues a single-use removal analysis before any
 * mutation. Other cleanup categories remain evidence.
 */
export interface SmartCleanupRemovalRecommendation {
  id: string;
  kind: 'remove-direct-dependency';
  packageName: string;
  dependencyType: 'production' | 'development' | 'optional' | 'peer';
  confidence: SmartCleanupConfidence;
  rationale: string;
  evidence: readonly string[];
}

export interface SmartCleanupDeprecatedFinding {
  id: string;
  packageName: string;
  installedVersion: string | null;
  message: string;
  suggestedReplacement?: string;
  nextStep:
    | { kind: 'review-removal'; actionId: string; reason: string }
    | { kind: 'review-upgrade'; targetVersion: string; reason: string }
    | { kind: 'review-related-upgrades'; upgrades: readonly { packageName: string; targetVersion: string }[]; reason: string }
    | { kind: 'guidance'; reason: string };
}

export interface SmartCleanupDuplicateVersion {
  version: string;
  direct: boolean;
  paths: readonly (readonly string[])[];
  totalPaths: number;
  truncated: boolean;
}

export interface SmartCleanupDuplicateFinding {
  id: string;
  packageName: string;
  versions: readonly SmartCleanupDuplicateVersion[];
  excessVersionCount: number;
  directRoots: readonly { packageName: string; upgradeAvailable: boolean }[];
  summary: string;
  outcome: 'safe-convergence' | 'keep-both' | 'unknown';
  targetVersion?: string;
  reason: string;
}

export interface SmartCleanupDedupeAction {
  id: string;
  kind: 'dedupe-project';
  affectedPackages: readonly string[];
  expectedRemovedVersions: number;
  confidence: 'safe';
}

export interface SmartCleanupSecurityFinding {
  id: string;
  advisoryId: string | null;
  packageName: string;
  severity: Severity;
  summary: string;
  /** Removal action ids for direct dependency roots that currently introduce this advisory. */
  directRootActionIds: readonly string[];
  /** Every direct dependency root currently introducing this advisory. */
  directRoots: readonly string[];
  /** Every direct root carrying the advisory, including roots not eligible for cleanup. */
  directRootCount: number;
}

export interface SmartCleanupPlan {
  planId: string;
  requestId: string;
  projectName: string;
  generatedAt: string;
  recommendations: readonly SmartCleanupRemovalRecommendation[];
  deprecated: readonly SmartCleanupDeprecatedFinding[];
  duplicates: readonly SmartCleanupDuplicateFinding[];
  dedupeAction: SmartCleanupDedupeAction | null;
  security: readonly SmartCleanupSecurityFinding[];
}

export interface SmartCleanupExecutionProgress {
  completed: number;
  total: number;
  currentLabel: string;
}

export interface SmartCleanupMetric {
  id:
    | 'dependencies'
    | 'deprecated-dependencies'
    | 'duplicate-groups'
    | 'excess-versions'
    | 'vulnerable-dependencies'
    | 'advisory-findings';
  label: string;
  before: number;
  after: number;
  detail: string;
}

export interface SmartCleanupResultAdvisory {
  sourceId: string;
  identifiers: readonly string[];
  flaggedPackage: string;
  severity: Severity;
  title: string;
}

export interface SmartCleanupResult {
  metrics: readonly SmartCleanupMetric[];
  completedActionIds: readonly string[];
  skippedActionIds: readonly string[];
  failedActionIds: readonly string[];
  resolvedAdvisories: readonly SmartCleanupResultAdvisory[];
  introducedAdvisories: readonly SmartCleanupResultAdvisory[];
  verification: 'passed' | 'failed' | 'not-run';
  rollback: 'not-needed' | 'restored' | 'incomplete';
  detail?: string;
}

export type SmartCleanupPhase =
  | 'analyzing'
  | 'partial'
  | 'ready'
  | 'stale'
  | 'cancelled'
  | 'empty'
  | 'unsupported'
  | 'confirming'
  | 'executing'
  | 'rolling-back'
  | 'complete'
  | 'cancelled-rolled-back'
  | 'incomplete'
  | 'failed';

export interface SmartCleanupState {
  phase: SmartCleanupPhase;
  projectName: string;
  requestId: string | null;
  plan: SmartCleanupPlan | null;
  analysisSteps: readonly SmartCleanupAnalysisStep[];
  expandedCategories: ReadonlySet<SmartCleanupCategory>;
  selectedActionIds: ReadonlySet<string>;
  reviewedActionIds: ReadonlySet<string>;
  returnPhase: 'partial' | 'ready';
  execution: SmartCleanupExecutionProgress | null;
  result: SmartCleanupResult | null;
  message: string | null;
}

export interface SmartCleanupReviewCacheIdentity {
  projectKey: string;
  dashboardGeneratedAt: string;
  expiresAt: number;
}

/**
 * A closed review may be shown again without analysis only while it still
 * belongs to the same project and exact dashboard snapshot. Mutation
 * authority remains host-owned and is rechecked separately before cleanup.
 */
export function smartCleanupReviewIsReusable(
  state: SmartCleanupState,
  cache: SmartCleanupReviewCacheIdentity | null,
  current: { projectKey: string; dashboardGeneratedAt: string },
  now = Date.now()
): boolean {
  return cache !== null &&
    cache.projectKey === current.projectKey &&
    cache.dashboardGeneratedAt === current.dashboardGeneratedAt &&
    cache.expiresAt > now &&
    (state.phase === 'ready' || state.phase === 'partial' || state.phase === 'empty');
}

export type SmartCleanupAction =
  | { type: 'analysis-started'; projectName: string; requestId: string; steps: readonly SmartCleanupAnalysisStep[] }
  | { type: 'analysis-progress'; requestId: string; steps: readonly SmartCleanupAnalysisStep[] }
  | { type: 'analysis-partial'; requestId: string; plan: SmartCleanupPlan; message: string }
  | { type: 'analysis-ready'; requestId: string; plan: SmartCleanupPlan }
  | { type: 'analysis-empty'; requestId: string; message: string }
  | { type: 'analysis-unsupported'; requestId: string; message: string }
  | { type: 'analysis-cancelled'; requestId: string; message: string }
  | { type: 'analysis-failed'; requestId: string; message: string }
  | { type: 'source-stale'; message: string }
  | { type: 'operation-rejected'; message: string }
  | { type: 'toggle-category'; category: SmartCleanupCategory }
  | { type: 'toggle-safe-action'; actionId: string }
  | { type: 'review-action'; actionId: string }
  | { type: 'toggle-reviewed-action'; actionId: string }
  | { type: 'select-all-safe' }
  | { type: 'clear-selection' }
  | { type: 'show-confirmation' }
  | { type: 'keep-dependency'; actionId: string }
  | { type: 'back-to-review' }
  | { type: 'execution-started'; total: number; currentLabel: string }
  | { type: 'execution-progress'; completed: number; total: number; currentLabel: string }
  | { type: 'rollback-started'; message: string }
  | { type: 'execution-complete'; result: SmartCleanupResult }
  | { type: 'execution-incomplete'; result: SmartCleanupResult; message: string }
  | { type: 'execution-cancelled-and-restored'; result: SmartCleanupResult }
  | { type: 'reset' };

const DEFAULT_EXPANDED_CATEGORIES: ReadonlySet<SmartCleanupCategory> = new Set(['unused']);

export function createSmartCleanupState(projectName: string): SmartCleanupState {
  return {
    phase: 'analyzing',
    projectName,
    requestId: null,
    plan: null,
    analysisSteps: [],
    expandedCategories: DEFAULT_EXPANDED_CATEGORIES,
    selectedActionIds: new Set(),
    reviewedActionIds: new Set(),
    returnPhase: 'ready',
    execution: null,
    result: null,
    message: null,
  };
}

function defaultSafeSelection(plan: SmartCleanupPlan): ReadonlySet<string> {
  const removalIds = plan.recommendations
      .filter((recommendation) => recommendation.confidence === 'safe')
      .slice(0, SMART_CLEANUP_MAX_ACTIONS)
      .map((recommendation) => recommendation.id);
  return new Set([
    ...removalIds,
    ...(plan.dedupeAction == null || removalIds.length >= SMART_CLEANUP_MAX_ACTIONS ? [] : [plan.dedupeAction.id]),
  ]);
}

function requestMatches(state: SmartCleanupState, requestId: string): boolean {
  return state.requestId === requestId;
}

function recommendationFor(state: SmartCleanupState, actionId: string): SmartCleanupRemovalRecommendation | undefined {
  return state.plan?.recommendations.find((recommendation) => recommendation.id === actionId);
}

function isSafeAction(state: SmartCleanupState, actionId: string): boolean {
  return recommendationFor(state, actionId)?.confidence === 'safe' || state.plan?.dedupeAction?.id === actionId;
}

function toggleId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}

function withPlan(
  state: SmartCleanupState,
  phase: 'partial' | 'ready',
  plan: SmartCleanupPlan,
  message: string | null
): SmartCleanupState {
  return {
    ...state,
    phase,
    projectName: plan.projectName,
    requestId: plan.requestId,
    plan,
    selectedActionIds: defaultSafeSelection(plan),
    reviewedActionIds: new Set(),
    returnPhase: phase,
    execution: null,
    result: null,
    message,
  };
}

export function smartCleanupReducer(state: SmartCleanupState, action: SmartCleanupAction): SmartCleanupState {
  switch (action.type) {
    case 'analysis-started':
      return {
        ...createSmartCleanupState(action.projectName),
        requestId: action.requestId,
        analysisSteps: action.steps,
      };
    case 'analysis-progress':
      return requestMatches(state, action.requestId) && state.phase === 'analyzing'
        ? { ...state, requestId: action.requestId, analysisSteps: action.steps }
        : state;
    case 'analysis-partial':
      return state.phase === 'analyzing' && requestMatches(state, action.requestId) && action.plan.requestId === action.requestId
        ? withPlan(state, 'partial', action.plan, action.message)
        : state;
    case 'analysis-ready':
      return state.phase === 'analyzing' && requestMatches(state, action.requestId) && action.plan.requestId === action.requestId
        ? withPlan(state, 'ready', action.plan, null)
        : state;
    case 'analysis-empty':
      return state.phase === 'analyzing' && requestMatches(state, action.requestId)
        ? { ...state, phase: 'empty', requestId: action.requestId, message: action.message }
        : state;
    case 'analysis-unsupported':
      return state.phase === 'analyzing' && requestMatches(state, action.requestId)
        ? { ...state, phase: 'unsupported', requestId: action.requestId, message: action.message }
        : state;
    case 'analysis-cancelled':
      return state.phase === 'analyzing' && requestMatches(state, action.requestId)
        ? { ...state, phase: 'cancelled', requestId: action.requestId, message: action.message }
        : state;
    case 'analysis-failed':
      return state.phase === 'analyzing' && requestMatches(state, action.requestId)
        ? { ...state, phase: 'failed', requestId: action.requestId, message: action.message }
        : state;
    case 'source-stale':
      return { ...state, phase: 'stale', selectedActionIds: new Set(), message: action.message };
    case 'operation-rejected':
      return state.plan === null
        ? state
        : { ...state, phase: state.returnPhase, execution: null, result: null, message: action.message };
    case 'toggle-category':
      return { ...state, expandedCategories: toggleId(state.expandedCategories, action.category) as ReadonlySet<SmartCleanupCategory> };
    case 'toggle-safe-action': {
      if (state.phase !== 'ready' && state.phase !== 'partial') return state;
      if (!isSafeAction(state, action.actionId)) return state;
      if (!state.selectedActionIds.has(action.actionId) && state.selectedActionIds.size >= SMART_CLEANUP_MAX_ACTIONS) return state;
      return { ...state, selectedActionIds: toggleId(state.selectedActionIds, action.actionId) };
    }
    case 'review-action': {
      if (state.phase !== 'ready' && state.phase !== 'partial') return state;
      const recommendation = recommendationFor(state, action.actionId);
      if (recommendation?.confidence !== 'review') return state;
      const reviewedActionIds = new Set(state.reviewedActionIds);
      reviewedActionIds.add(action.actionId);
      return { ...state, reviewedActionIds };
    }
    case 'toggle-reviewed-action': {
      if (state.phase !== 'ready' && state.phase !== 'partial') return state;
      const recommendation = recommendationFor(state, action.actionId);
      if (recommendation?.confidence !== 'review' || !state.reviewedActionIds.has(action.actionId)) return state;
      const selected = state.selectedActionIds.has(action.actionId);
      if (!selected && state.selectedActionIds.size >= SMART_CLEANUP_MAX_ACTIONS) return state;
      return {
        ...state,
        selectedActionIds: toggleId(state.selectedActionIds, action.actionId),
      };
    }
    case 'select-all-safe': {
      if (state.plan === null || (state.phase !== 'ready' && state.phase !== 'partial')) return state;
      return { ...state, selectedActionIds: defaultSafeSelection(state.plan) };
    }
    case 'clear-selection':
      return state.phase === 'ready' || state.phase === 'partial' ? { ...state, selectedActionIds: new Set() } : state;
    case 'show-confirmation':
      return state.plan !== null && (state.phase === 'ready' || state.phase === 'partial') && state.selectedActionIds.size > 0
        ? { ...state, phase: 'confirming', returnPhase: state.phase }
        : state;
    case 'keep-dependency': {
      if (
        state.phase !== 'confirming' ||
        recommendationFor(state, action.actionId) === undefined ||
        !state.selectedActionIds.has(action.actionId)
      ) return state;
      const selectedActionIds = new Set(state.selectedActionIds);
      selectedActionIds.delete(action.actionId);
      return selectedActionIds.size === 0
        ? { ...state, phase: state.returnPhase, selectedActionIds }
        : { ...state, selectedActionIds };
    }
    case 'back-to-review':
      return state.phase === 'confirming' ? { ...state, phase: state.returnPhase } : state;
    case 'execution-started':
      return state.phase === 'confirming'
        ? { ...state, phase: 'executing', execution: { completed: 0, total: action.total, currentLabel: action.currentLabel } }
        : state;
    case 'execution-progress':
      return state.phase === 'executing'
        ? {
            ...state,
            execution: {
              completed: Math.min(action.completed, action.total),
              total: action.total,
              currentLabel: action.currentLabel,
            },
          }
        : state;
    case 'rollback-started':
      return state.phase === 'executing'
        ? { ...state, phase: 'rolling-back', message: action.message }
        : state;
    case 'execution-complete':
      return { ...state, phase: 'complete', execution: null, result: action.result, message: null };
    case 'execution-incomplete':
      return { ...state, phase: 'incomplete', execution: null, result: action.result, message: action.message };
    case 'execution-cancelled-and-restored':
      return { ...state, phase: 'cancelled-rolled-back', execution: null, result: action.result, message: null };
    case 'reset':
      return createSmartCleanupState(state.projectName);
  }
}

export function selectedSmartCleanupRecommendations(
  state: SmartCleanupState
): readonly SmartCleanupRemovalRecommendation[] {
  if (state.plan === null) return [];
  return state.plan.recommendations.filter((recommendation) => state.selectedActionIds.has(recommendation.id));
}

export function selectedSmartCleanupDedupeAction(state: SmartCleanupState): SmartCleanupDedupeAction | null {
  const action = state.plan?.dedupeAction ?? null;
  return action !== null && state.selectedActionIds.has(action.id) ? action : null;
}

export function canCloseSmartCleanup(state: SmartCleanupState): boolean {
  return state.phase !== 'executing' && state.phase !== 'rolling-back';
}

export function smartCleanupAnalysisIsActionable(state: SmartCleanupState): boolean {
  return state.phase === 'ready' || state.phase === 'partial';
}
