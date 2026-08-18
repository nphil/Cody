"use client";

import { useEffect, useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useDisplayRequests } from "@/hooks/useDisplayRequests";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { codecLabelFor, StreamedDisplay, type StreamRenderMode } from "./StreamedDisplay";
import { ToastProvider } from "./ui/toast";
import type { DisplayRequestV1 } from "@/lib/display/types";

/** Lifetime of the render-mode pill, matching the panel's: the
 *  preview-mode-notice keyframe fades itself out over the same span. */
const MODE_NOTICE_MS = 2_000;

/** The streamed surface alone, filling a window of its own. Opened from the
 *  Preview panel's pop-out button and reachable at /display/<sessionId>; it runs
 *  the same authenticated display socket as the panel, so the only difference is
 *  size — and size is the point. A full window measures larger, reports that
 *  size and its device scale over `resize`, and the remote surface renders at
 *  it natively instead of being upscaled from a sidebar-sized panel. */
export function DisplayWindow({ sessionId }: { sessionId: string }): ReactElement {
  const { t } = useI18n();
  // The request bus is the live channel: when an agent publishes a new surface
  // the server disposes the previous provider, so a window pinned to the old
  // request id would simply go dark. Following the bus re-targets it instead.
  const live = useDisplayRequests(sessionId, () => undefined);
  // The bus reports "nothing published yet" and "not connected yet" as the same
  // null, and a chrome-less window has to say which. One GET settles it.
  const [initial, setInitial] = useState<DisplayRequestV1 | null | undefined>(undefined);
  /** What the surface is actually presenting, from the streamed client itself. */
  const [mode, setMode] = useState<StreamRenderMode | null>(null);
  /** Bumped per mode change so the pill re-triggers its fade. */
  const [modeNotice, setModeNotice] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  // This window has no chrome to hold a persistent badge, so the active rung
  // goes in the two places a bare window still has: the title, which is
  // permanent, and a pill that makes a CHANGE noticeable. A silent drop from
  // H.264 to JPEG stills must not be invisible just because there is no bar.
  useEffect(() => {
    if (!mode) return;
    document.title = `${codecLabelFor(mode, t)} · Cody`;
    setModeNotice((value) => value + 1);
    const timer = window.setTimeout(() => setModeNotice(0), MODE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [mode, t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/display`, { cache: "no-store" });
        const body = await response.json().catch(() => null) as { request?: DisplayRequestV1 | null } | null;
        if (!cancelled) setInitial(response.ok ? body?.request ?? null : null);
      } catch {
        if (!cancelled) setInitial(null);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // globals.css reserves a permanent scrollbar gutter on <html> so the app's
  // layout never shifts. Here that gutter is a fidelity bug, not a cosmetic
  // one: this window's whole job is to report its real size, and the reserved
  // strip both shows a scrollbar the surface can never use and shrinks the
  // viewport the remote surface renders at. Scoped to this route, restored on
  // unmount, so the app-wide behaviour is untouched.
  useEffect(() => {
    const root = document.documentElement;
    const gutter = root.style.scrollbarGutter;
    const overflow = root.style.overflow;
    root.style.scrollbarGutter = "auto";
    root.style.overflow = "hidden";
    return () => { root.style.scrollbarGutter = gutter; root.style.overflow = overflow; };
  }, []);

  const request = live ?? initial ?? null;

  return (
    <ToastProvider>
      {/* Fixed rather than absolute: this is the whole viewport, and it is also
          the containing block the streamed surface positions against. */}
      <main style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--bg)" }}>
        {request ? (
          <StreamedDisplay key={request.id} sessionId={sessionId} request={request} active onRenderMode={(_requestId, next) => setMode(next)} />
        ) : (
          <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 12 }}>
            <div>
              {initial === undefined && <Loader2 size={20} aria-hidden="true" style={{ display: "block", margin: "0 auto 10px", animation: "spin 0.8s linear infinite" }} />}
              {t(initial === undefined ? "preview.connecting" : "preview.windowNoRequest")}
            </div>
          </div>
        )}
        {/* pointer-events off: it can never swallow a click meant for the
            remote surface underneath it. */}
        {modeNotice > 0 && mode && (
          <div key={modeNotice} role="status" style={{ position: "absolute", top: 8, left: 0, right: 0, width: "fit-content", maxWidth: "calc(100% - 20px)", margin: "0 auto", zIndex: 1, pointerEvents: "none", padding: "3px 9px", border: "1px solid var(--border)", borderRadius: 999, background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)", boxShadow: "var(--shadow-card)", color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap", animation: reducedMotion ? undefined : `preview-mode-notice ${MODE_NOTICE_MS}ms var(--ease-out-warm) forwards` }}>
            {t("preview.modeStreamedVia", { mode: t("preview.modeStreamed"), codec: codecLabelFor(mode, t) })}
          </div>
        )}
      </main>
    </ToastProvider>
  );
}
