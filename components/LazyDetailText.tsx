"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { lazyDetailUrl, parseLazyPage, type LazyDetailRef, type LazyPage } from "@/lib/lazy-blocks";
import { createLazyPager, INITIAL_LAZY_PAGER_STATE, type LazyPager, type LazyPagerState } from "@/lib/lazy-pager";

/** One page of an oversized block from the detail route (lib/lazy-blocks.ts). Nothing is cached here. */
export async function fetchLazyPage(ref: LazyDetailRef, page: number, signal?: AbortSignal): Promise<LazyPage> {
  const response = await fetch(lazyDetailUrl(ref, page), { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = parseLazyPage(await response.json());
  if (!result) throw new Error("Not a detail page");
  return result;
}

const FOOTER_BUTTON: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "6px 10px",
  border: "none",
  borderTop: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--accent)",
  cursor: "pointer",
  fontSize: 12,
  textAlign: "left",
  fontFamily: "inherit",
};

const FOOTER_NOTE: CSSProperties = {
  padding: "6px 10px",
  borderTop: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text-dim)",
  fontSize: 12,
};

const NAV_BUTTON: CSSProperties = {
  padding: "2px 8px",
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "none",
  color: "var(--accent)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
};

/**
 * One page of an open block at a time, with first / previous / next / last. The page lives only in the pager;
 * unmounting (the card collapses, the viewer is hidden, the row leaves) aborts the request and drops the text.
 */
function useLazyPager(ref: LazyDetailRef): { pager: LazyPager | null; state: LazyPagerState } {
  const { sessionId, entryId, kind, blockIndex, pointer } = ref;
  const [pager, setPager] = useState<LazyPager | null>(null);
  const [state, setState] = useState(INITIAL_LAZY_PAGER_STATE);
  useEffect(() => {
    const next = createLazyPager((page, signal) => fetchLazyPage({ sessionId, entryId, kind, blockIndex, pointer }, page, signal));
    const unsubscribe = next.subscribe(() => setState(next.getState()));
    setPager(next);
    setState(next.getState());
    next.go(0);
    return () => {
      unsubscribe();
      next.dispose();
    };
  }, [sessionId, entryId, kind, blockIndex, pointer]);
  return { pager, state };
}

/**
 * The paged text of one oversized block. `bodyStyle` is the caller's text styling.
 */
export function LazyDetailText({ detailRef, bodyStyle, mono = false }: {
  detailRef: LazyDetailRef;
  bodyStyle?: CSSProperties;
  mono?: boolean;
}) {
  const { t, locale } = useI18n();
  const { pager, state } = useLazyPager(detailRef);
  const format = (value: number) => value.toLocaleString(locale);
  return (
    <div data-testid="lazy-detail">
      {state.text !== "" && (
        <div
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflow: "auto",
            overscrollBehavior: "contain",
            maxHeight: 400,
            ...(mono ? { fontFamily: "var(--font-mono)" } : {}),
            ...bodyStyle,
          }}
        >
          {state.text}
        </div>
      )}
      {state.loading && <div style={FOOTER_NOTE}>{t("messageView.lazyLoading")}</div>}
      {state.failed && !state.loading && (
        <div role="alert" style={{ ...FOOTER_NOTE, color: "var(--status-error)", display: "flex", gap: 8, alignItems: "center" }}>
          <span>{t("messageView.lazyLoadFailed")}</span>
          <button type="button" onClick={() => pager?.retry()} style={NAV_BUTTON}>{t("messageView.lazyRetry")}</button>
        </div>
      )}
      {state.pages > 1 && (
        <div style={{ ...FOOTER_NOTE, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <button type="button" disabled={state.page === 0} onClick={() => pager?.first()} style={NAV_BUTTON}>{t("messageView.lazyFirst")}</button>
          <button type="button" disabled={state.page === 0} onClick={() => pager?.previous()} style={NAV_BUTTON}>{t("messageView.lazyPrevious")}</button>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{t("messageView.lazyPage", { page: format(state.page + 1), pages: format(state.pages) })}</span>
          <button type="button" disabled={state.page + 1 >= state.pages} onClick={() => pager?.next()} style={NAV_BUTTON}>{t("messageView.lazyNext")}</button>
          <button type="button" disabled={state.page + 1 >= state.pages} onClick={() => pager?.last()} style={NAV_BUTTON}>{t("messageView.lazyLast")}</button>
        </div>
      )}
    </div>
  );
}

/**
 * A stub the reader can open: the preview (when the caller wants one shown)
 * plus a "show full" step; opening mounts LazyDetailText, "hide" unmounts it
 * and with it the page it holds. Without a session to ask, it says so.
 */
export function LazyStub({ detailRef, chars, preview, field, previewStyle, bodyStyle, mono }: {
  detailRef: LazyDetailRef | null;
  chars: number;
  /** Shown while closed (tool-result text); omitted for arguments, whose preview is already in the JSON. */
  preview?: string;
  /** Names the argument for the button ("content"); omitted for results. */
  field?: string;
  previewStyle?: CSSProperties;
  bodyStyle?: CSSProperties;
  mono?: boolean;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const label = field === undefined
    ? t("messageView.lazyShowFull", { total: chars.toLocaleString(locale) })
    : t("messageView.lazyShowFullField", { field, total: chars.toLocaleString(locale) });
  return (
    <div data-testid="lazy-stub">
      {open && detailRef ? (
        <>
          <LazyDetailText detailRef={detailRef} bodyStyle={bodyStyle ?? previewStyle} mono={mono} />
          <button type="button" onClick={() => setOpen(false)} style={FOOTER_BUTTON}>{t("messageView.lazyHide")}</button>
        </>
      ) : (
        <>
          {preview !== undefined && <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", ...(mono ? { fontFamily: "var(--font-mono)" } : {}), ...previewStyle }}>{preview}</div>}
          {detailRef
            ? <button type="button" onClick={() => setOpen(true)} style={FOOTER_BUTTON}>{label}</button>
            : <div style={FOOTER_NOTE}>{t("messageView.lazyUnavailable")}</div>}
        </>
      )}
    </div>
  );
}
