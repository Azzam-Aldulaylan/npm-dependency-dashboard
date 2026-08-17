import type { ReactElement } from 'react';

import { PAGE_SIZES, compactPageNumbers } from '../../../src/host/pagination.js';
import type { PageSize } from '../../../src/host/pagination.js';
import { IconChevronRight } from '../icons.js';

/**
 * Pure display/interaction — every number it renders is derived from props
 * the caller already computed via src/host/pagination.ts. This never
 * decides page contents itself, only how the "Showing X–Y of Z" summary
 * and the compact page-number row react to a click.
 */
export function Pagination({
  currentPage,
  totalPages,
  totalRows,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  currentPage: number;
  totalPages: number;
  totalRows: number;
  pageSize: PageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
}): ReactElement {
  const start = totalRows === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalRows);
  const tokens = compactPageNumbers(currentPage, totalPages);

  return (
    <div className="pagination">
      <p className="pagination__summary">
        {totalRows === 0 ? 'Showing 0 of 0' : `Showing ${start}–${end} of ${totalRows}`}
      </p>
      <div className="pagination__controls">
        <label className="pagination__page-size">
          Per page
          <select
            className="pagination__page-size-select"
            value={pageSize}
            onChange={(event) => {
              onPageSizeChange(Number(event.target.value) as PageSize);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        {totalPages > 1 ? (
          <nav className="pagination__pages" aria-label="Table pages">
            <button
              type="button"
              className="pagination__nav"
              disabled={currentPage <= 1}
              aria-label="Previous page"
              onClick={() => {
                onPageChange(currentPage - 1);
              }}
            >
              <IconChevronRight className="pagination__nav-icon pagination__nav-icon--prev" />
            </button>
            {tokens.map((token, index) =>
              token === 'ellipsis' ? (
                <span key={`ellipsis-${index}`} className="pagination__ellipsis" aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={token}
                  type="button"
                  className="pagination__page"
                  aria-current={token === currentPage ? 'page' : undefined}
                  data-selected={token === currentPage ? 'true' : undefined}
                  onClick={() => {
                    onPageChange(token);
                  }}
                >
                  {token}
                </button>
              )
            )}
            <button
              type="button"
              className="pagination__nav"
              disabled={currentPage >= totalPages}
              aria-label="Next page"
              onClick={() => {
                onPageChange(currentPage + 1);
              }}
            >
              <IconChevronRight className="pagination__nav-icon" />
            </button>
          </nav>
        ) : null}
      </div>
    </div>
  );
}
