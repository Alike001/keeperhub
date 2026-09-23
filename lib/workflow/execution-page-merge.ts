/**
 * Client-side bookkeeping for the paginated executions list: the runs panel
 * keeps every page it has loaded and re-fetches only the first one while
 * polling, so these fold a fresh page into what is already on screen.
 */
export type ExecutionPage<T> = {
  executions: T[];
  nextCursor: string | null;
  total: number;
};

export const EMPTY_EXECUTION_PAGE: ExecutionPage<never> = {
  executions: [],
  nextCursor: null,
  total: 0,
};

/**
 * Fold a freshly fetched first page into the loaded list.
 *
 * Rows the page covers replace their loaded counterparts (status and progress
 * move on while a run is in flight) and rows new since the last fetch land at
 * the top. Rows the page no longer covers are kept in place: they are the older
 * pages the viewer has loaded, plus whatever the newest runs pushed past the
 * first-page boundary. The stored cursor still points at the tail of that
 * retained list, so it survives; only when nothing was retained is the page's
 * own cursor the tail.
 *
 * A page without a `nextCursor` is the complete list, so nothing outside it is
 * kept. That is what empties the panel after the runs are purged.
 */
export function mergeFirstPage<T extends { id: string }>(
  loaded: ExecutionPage<T>,
  page: ExecutionPage<T>
): ExecutionPage<T> {
  if (page.nextCursor === null) {
    return page;
  }
  const covered = new Set(page.executions.map((execution) => execution.id));
  const retained = loaded.executions.filter(
    (execution) => !covered.has(execution.id)
  );
  return {
    executions: [...page.executions, ...retained],
    nextCursor: retained.length > 0 ? loaded.nextCursor : page.nextCursor,
    total: page.total,
  };
}

/** Append an older page fetched with the stored cursor. */
export function appendPage<T extends { id: string }>(
  loaded: ExecutionPage<T>,
  page: ExecutionPage<T>
): ExecutionPage<T> {
  const seen = new Set(loaded.executions.map((execution) => execution.id));
  const fresh = page.executions.filter((execution) => !seen.has(execution.id));
  return {
    executions: [...loaded.executions, ...fresh],
    nextCursor: page.nextCursor,
    total: page.total,
  };
}
