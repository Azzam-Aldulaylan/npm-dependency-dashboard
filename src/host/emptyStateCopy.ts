/**
 * The empty-table headline when a summary-card/dependency-type combination
 * (no search involved) narrows the table to zero rows. Search-empty and
 * truly-empty-project copy is simple enough to stay inline in App.tsx; this
 * one earns its own pure function because it has to combine two
 * independent filters into one sentence, and because a "0 vulnerabilities"
 * or "0 needs attention" result is a *good* outcome that should read that
 * way rather than as a dead end.
 */

import type { DependencyTypeFilter } from './dependencyTypeFilter.js';
import type { SummaryFilterId } from './summaryMetrics.js';

const CARD_EMPTY_TITLE: Record<SummaryFilterId, string> = {
  all: 'No dependencies match this filter',
  updates: 'Everything is up to date',
  vulnerabilities: 'No vulnerable dependencies',
  attention: 'Nothing needs attention',
};

const TYPE_LABEL: Record<'prod' | 'dev', string> = {
  prod: 'production',
  dev: 'dev',
};

export function filterEmptyStateTitle(filter: SummaryFilterId, dependencyType: DependencyTypeFilter): string {
  if (filter === 'all' && dependencyType !== 'all') {
    return `No ${TYPE_LABEL[dependencyType]} dependencies`;
  }
  return CARD_EMPTY_TITLE[filter];
}
