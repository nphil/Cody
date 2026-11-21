"use client";

import { memo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { asyncFinished } from "@/lib/live-tool-output";
import { useLiveToolOutput } from "@/hooks/useLiveToolOutput";
import { ElapsedClock } from "@/components/ElapsedClock";

const LINE_PX = 16;
const ROWS_COLLAPSED = 4;
const ROWS_EXPANDED = 14;
const BOX_PADDING_PX = 12;

/**
 * The last lines a running call prints (a build, a test run, a worker job),
 * under its card header. The box has a FIXED height so the transcript never
 * jumps as lines arrive: 4 rows, 14 once expanded, newest line at the bottom.
 * It exists only while the call runs and for at least 1.2 s (quick commands
 * never flash it); a finished background job keeps its last lines. The text
 * lives in the per-chat store (lib/live-tool-output.ts), not in the
 * transcript: the model never sees it and a reload does not need it.
 * The clock is its own span with its own timer, not part of the text.
 */
export const LiveToolTail = memo(function LiveToolTail({ toolCallId, toolName }: { toolCallId: string; toolName: string }) {
  const { t } = useI18n();
  const entry = useLiveToolOutput(toolCallId);
  const [open, setOpen] = useState(false);
  if (!entry || !entry.shown || entry.lines.length === 0) return null;

  const finished = entry.async ? asyncFinished(entry.async) : false;
  const rows = open ? ROWS_EXPANDED : ROWS_COLLAPSED;
  const visible = entry.lines.slice(-rows);
  let label = t("liveTool.label");
  if (entry.async) {
    if (finished) label = t(entry.async.state === "completed" ? "liveTool.jobFinished" : "liveTool.jobEnded");
    else label = entry.async.jobId ? t("liveTool.job", { job: entry.async.jobId }) : t("liveTool.jobRunning");
  } else if (entry.headline) {
    label = entry.headline;
  }

  return (
    <div
      role="group"
      aria-label={t("liveTool.regionLabel", { name: toolName })}
      style={{ borderTop: "1px solid var(--border)", background: "var(--bg-subtle)" }}
    >
      <div
        role="log"
        aria-live="off"
        style={{
          height: rows * LINE_PX + BOX_PADDING_PX,
          boxSizing: "border-box",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          padding: `${BOX_PADDING_PX / 2}px 10px`,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: `${LINE_PX}px`,
          color: "var(--text-muted)",
          userSelect: "text",
        }}
      >
        {visible.map((line, index) => (
          <div key={index} style={{ flexShrink: 0, height: LINE_PX, whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>
            {line}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? t("liveTool.collapse") : t("liveTool.expand")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          minHeight: 28,
          padding: "4px 10px",
          background: "none",
          border: "none",
          borderTop: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          color: "var(--text-dim)",
          fontSize: 11,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        {!finished && <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: "auto" }}>{label}</span>
        <ElapsedClock since={entry.startedAt} until={entry.endedAt} />
        <ChevronDown
          size={12}
          strokeWidth={1.6}
          aria-hidden
          style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
        />
      </button>
    </div>
  );
});
