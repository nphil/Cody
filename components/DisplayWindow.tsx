"use client";

import { useEffect, useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useDisplayRequests } from "@/hooks/useDisplayRequests";
import { StreamedDisplay } from "./StreamedDisplay";
import { ToastProvider } from "./ui/toast";
import type { DisplayRequestV1 } from "@/lib/display/types";

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

  const request = live ?? initial ?? null;

  return (
    <ToastProvider>
      {/* Fixed rather than absolute: this is the whole viewport, and it is also
          the containing block the streamed surface positions against. */}
      <main style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--bg)" }}>
        {request ? (
          <StreamedDisplay key={request.id} sessionId={sessionId} request={request} active />
        ) : (
          <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 12 }}>
            <div>
              {initial === undefined && <Loader2 size={20} aria-hidden="true" style={{ display: "block", margin: "0 auto 10px", animation: "spin 0.8s linear infinite" }} />}
              {t(initial === undefined ? "preview.connecting" : "preview.windowNoRequest")}
            </div>
          </div>
        )}
      </main>
    </ToastProvider>
  );
}
