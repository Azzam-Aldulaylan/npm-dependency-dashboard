/**
 * Client-side pagination — slicing only. Whatever produced `rows` has
 * already applied every filter, the dependency-type toggle, search, and
 * sorting; this never re-derives any of that and never triggers a fetch of
 * any kind, matching the rest of src/host's pure, local helpers.
 */

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

export interface Page<T> {
  pageRows: T[];
  /** Always >= 1, even for zero rows, so "page 1 of 1" is a valid, renderable state. */
  totalPages: number;
  /** The page actually rendered — clamped into [1, totalPages], not necessarily the page requested. */
  currentPage: number;
  totalRows: number;
}

/**
 * `requestedPage` is clamped rather than trusted — a filter/search change
 * can shrink `rows` out from under whatever page the caller last showed,
 * and this is the one place that reconciles the two instead of every
 * caller having to remember to.
 */
export function paginate<T>(rows: readonly T[], requestedPage: number, pageSize: number): Page<T> {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    pageRows: rows.slice(start, start + pageSize),
    totalPages,
    currentPage,
    totalRows: rows.length,
  };
}

export type PageToken = number | 'ellipsis';

/**
 * The compact `1 2 3 … 12` page-number sequence — always includes the
 * first and last page, the current page, and its immediate neighbours;
 * every other gap collapses to a single `'ellipsis'` token rather than a
 * button per page, which would be unusable well before 140 dependencies at
 * even the smallest page size reaches double-digit pages.
 */
/** Below this, every page fits on one row — collapsing would save no space, only readability. */
const COLLAPSE_THRESHOLD = 7;

export function compactPageNumbers(currentPage: number, totalPages: number): PageToken[] {
  if (totalPages <= COLLAPSE_THRESHOLD) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages = new Set<number>([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  const tokens: PageToken[] = [];
  let previous: number | null = null;
  for (const page of sorted) {
    if (previous !== null && page - previous > 1) tokens.push('ellipsis');
    tokens.push(page);
    previous = page;
  }
  return tokens;
}
