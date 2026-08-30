import type { CleanupAction } from './types.js';

export const MAX_SMART_CLEANUP_ACTIONS = 150;

const CONFIDENCE_RANK: Record<CleanupAction['confidence'], number> = {
  'low-risk': 0,
  'review-required': 1,
};

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

/** Stable business ordering, independent of analyzer completion order. */
export function rankCleanupActions(actions: readonly CleanupAction[]): CleanupAction[] {
  return [...actions].sort((left, right) =>
    CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence] ||
    compareText(left.packageName, right.packageName) ||
    compareText(left.id, right.id)
  );
}

export interface CleanupActionBatch {
  actions: CleanupAction[];
  totalCount: number;
  overflowCount: number;
}

/** The same deterministic first-150 boundary must govern UI and execution. */
export function canonicalCleanupActionBatch(actions: readonly CleanupAction[]): CleanupActionBatch {
  const ranked = rankCleanupActions(actions);
  return {
    actions: ranked.slice(0, MAX_SMART_CLEANUP_ACTIONS),
    totalCount: ranked.length,
    overflowCount: Math.max(0, ranked.length - MAX_SMART_CLEANUP_ACTIONS),
  };
}

/** Only low-risk actions are opted in without a deliberate user decision. */
export function defaultCleanupActionIds(actions: readonly CleanupAction[]): string[] {
  return canonicalCleanupActionBatch(actions).actions
    .filter((action) => action.confidence === 'low-risk')
    .map((action) => action.id);
}

export type CleanupSelectionResult =
  | { ok: true; actions: CleanupAction[] }
  | {
      ok: false;
      code: 'DUPLICATE_ACTION_ID' | 'UNKNOWN_ACTION_ID' | 'DUPLICATE_REQUESTED_ID';
      actionId: string;
    };

/**
 * Validates a requested selection against the canonical executable batch.
 * Unknown/overflow ids fail closed; the returned actions use host-owned plan
 * values in canonical order rather than any webview-supplied action content.
 */
export function resolveCleanupSelection(
  actions: readonly CleanupAction[],
  requestedActionIds: readonly string[]
): CleanupSelectionResult {
  const allIds = new Set<string>();
  for (const action of actions) {
    if (allIds.has(action.id)) {
      return { ok: false, code: 'DUPLICATE_ACTION_ID', actionId: action.id };
    }
    allIds.add(action.id);
  }

  const batch = canonicalCleanupActionBatch(actions).actions;
  const byId = new Map<string, CleanupAction>();
  for (const action of batch) {
    byId.set(action.id, action);
  }

  const requested = new Set<string>();
  for (const id of requestedActionIds) {
    if (requested.has(id)) return { ok: false, code: 'DUPLICATE_REQUESTED_ID', actionId: id };
    requested.add(id);
    if (!byId.has(id)) return { ok: false, code: 'UNKNOWN_ACTION_ID', actionId: id };
  }

  return { ok: true, actions: batch.filter((action) => requested.has(action.id)) };
}
