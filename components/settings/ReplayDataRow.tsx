"use client";

/**
 * Settings › System › Disk › Old chat data: asks omp (`omp gc --strip`, via
 * `/api/disk/replay-data`) how much provider replay data sits in chats that
 * have been idle for a while, and frees it on request. Checking is a button,
 * not automatic, because omp has to read every idle chat to answer. Chats keep
 * working on any model afterwards. English-only, like the rest of the dialog.
 */
import { Check, Eraser, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/ui/toast";
import { formatBytes } from "@/lib/format-bytes";
import { ApiError, ErrorNote, requestJson, smallButtonStyle } from "./account-controls";
import { dimLineStyle } from "./EngineRoster";

const ROUTE = "/api/disk/replay-data";

interface StripAnswer {
  apply: boolean;
  candidates: number;
  stripped: number;
  bytes: number;
  skippedLive: number;
  errors: string[];
}

type Phase = "idle" | "checking" | "freeing";

export function ReplayDataRow() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<StripAnswer | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (apply: boolean) => {
    setPhase(apply ? "freeing" : "checking");
    setError(null);
    void requestJson<StripAnswer>(ROUTE, { method: apply ? "POST" : "GET" })
      .then((answer) => {
        if (!apply) {
          setPreview(answer);
          return;
        }
        setPreview(null);
        toast.success(
          answer.stripped === 0 ? "Nothing to free" : `Freed ${formatBytes(answer.bytes)} of old chat data`,
          answer.errors.length > 0 ? `${answer.errors.length} chats could not be cleaned.` : undefined,
        );
      })
      .catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.code === "unsupported") setUnsupported(true);
        else setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => setPhase("idle"));
  };

  const busy = phase !== "idle";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>Old chat data</div>
      <span style={dimLineStyle}>
        Chats nobody has opened for a while still carry hidden data that only speeds up continuing on the same model. Removing it frees space and the chats still open and continue on any model.
      </span>
      {unsupported
        ? <span style={dimLineStyle}>This server&apos;s omp is too old to do this (it needs 18.18.2 or newer).</span>
        : (
          <>
            {preview && (
              <span style={{ fontSize: 12 }} role="status">
                {preview.candidates === 0
                  ? "Nothing to free right now."
                  : `${formatBytes(preview.bytes)} can be freed from ${preview.candidates} idle ${preview.candidates === 1 ? "chat file" : "chat files"}.`}
              </span>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="ui-focus-ring" onClick={() => run(false)} disabled={busy} aria-busy={phase === "checking"} style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}>
                {phase === "checking" ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                Check how much can be freed
              </button>
              {preview && preview.candidates > 0 && (
                <button type="button" className="ui-focus-ring" onClick={() => run(true)} disabled={busy} aria-busy={phase === "freeing"} style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}>
                  {phase === "freeing" ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Eraser size={13} aria-hidden="true" />}
                  Free it
                </button>
              )}
            </div>
          </>
        )}
      <ErrorNote message={error} />
    </div>
  );
}
