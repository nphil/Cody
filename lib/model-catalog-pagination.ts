export interface ModelPageWindow {
  pageIndex: number;
  pageCount: number;
  start: number;
  end: number;
}

/**
 * Clamps a requested page to the current result set and returns its slice.
 * Empty results still have one logical page so the caller can render a
 * stable page indicator without special-case arithmetic.
 */
export function getModelPageWindow(total: number, requestedPage: number, pageSize: number): ModelPageWindow {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 1;
  const pageCount = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const requested = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0;
  const pageIndex = Math.min(Math.max(0, requested), pageCount - 1);
  const start = pageIndex * safePageSize;

  return {
    pageIndex,
    pageCount,
    start,
    end: Math.min(safeTotal, start + safePageSize),
  };
}
