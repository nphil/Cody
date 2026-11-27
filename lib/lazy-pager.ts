/**
 * The state of one open "full text" view over a paged detail (lib/lazy-blocks.ts), without any UI framework:
 * the viewer component binds it, the tests drive it directly.
 *
 * Exactly one page of text is held at a time. Moving to another page keeps the page on screen until the new
 * one arrives, then replaces it; nothing earlier is kept, so a 100 MB result costs one page of memory and every
 * page of it stays reachable (next, previous, first, last, retry). `dispose` aborts the request in flight and
 * drops the text and the listeners; a disposed pager ignores every later call.
 */
import type { LazyPage } from "./lazy-blocks";

export interface LazyPagerState {
  /** The page on screen; 0 before anything loaded. */
  page: number;
  /** Page count; 0 until the first page has arrived. */
  pages: number;
  /** The text's length in UTF-16 units; 0 until the first page has arrived. */
  total: number;
  /** The shown page's text; "" until the first page has arrived. */
  text: string;
  loading: boolean;
  /** The last request failed; the text on screen (if any) is still the previous page. */
  failed: boolean;
}

export type LazyPageFetcher = (page: number, signal: AbortSignal) => Promise<LazyPage>;

export interface LazyPager {
  getState(): LazyPagerState;
  subscribe(listener: () => void): () => void;
  /** Ask for page `page`; ignored when it is outside a known page range. */
  go(page: number): void;
  next(): void;
  previous(): void;
  first(): void;
  /** The last page; ignored until the page count is known. */
  last(): void;
  /** Ask again for the page whose request failed (or the first page when nothing ever loaded). */
  retry(): void;
  dispose(): void;
}

export const INITIAL_LAZY_PAGER_STATE: LazyPagerState = { page: 0, pages: 0, total: 0, text: "", loading: true, failed: false };

export function createLazyPager(fetchPage: LazyPageFetcher): LazyPager {
  let state = INITIAL_LAZY_PAGER_STATE;
  let controller: AbortController | null = null;
  let wanted = 0;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (next: LazyPagerState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const go = (page: number) => {
    if (disposed || !Number.isSafeInteger(page) || page < 0 || (state.pages > 0 && page >= state.pages)) return;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    wanted = page;
    set({ ...state, loading: true, failed: false });
    fetchPage(page, mine.signal).then(
      (result) => {
        if (mine.signal.aborted) return;
        set({ page: result.page, pages: result.pages, total: result.total, text: result.text, loading: false, failed: false });
      },
      () => {
        if (mine.signal.aborted) return;
        set({ ...state, loading: false, failed: true });
      },
    );
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    go,
    next: () => { if (state.pages > 0) go(state.page + 1); },
    previous: () => go(state.page - 1),
    first: () => go(0),
    last: () => { if (state.pages > 0) go(state.pages - 1); },
    retry: () => go(wanted),
    dispose() {
      disposed = true;
      controller?.abort();
      controller = null;
      listeners.clear();
      state = { ...INITIAL_LAZY_PAGER_STATE, loading: false };
    },
  };
}
