"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { formatToolElapsed, helperToolStart } from "@/lib/live-tool-output";

/**
 * A running clock (`7s`, `1m 05s`) with its own one-second tick. It is always a
 * plain sibling of changing text, never inside a StatusTextCrossfade: a
 * per-second change there re-animates the whole line. The tick stops at `until`
 * (a finished job shows its final time) and while nothing needs it.
 */
export function ElapsedClock({ since, until, minMs = 0, style }: { since: number; until?: number; minMs?: number; style?: CSSProperties }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until !== undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  const elapsed = (until ?? now) - since;
  if (elapsed < minMs) return null;
  return <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0, ...style }}>{formatToolElapsed(elapsed)}</span>;
}

/** The clock of a helper's current command. omp stamps the start (`currentToolStartMs`, the engine host's
 * clock); `helperToolStart` decides whether this device may trust it. A new command (another tool or
 * start stamp) restarts the clock. */
export function HelperToolClock({ tool, startMs, minMs = 0, style }: { tool: string; startMs?: number; minMs?: number; style?: CSSProperties }) {
  const key = `${tool}:${startMs ?? ""}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- first sight of THIS command; the key is its identity
  const firstSeen = useMemo(() => Date.now(), [key]);
  return <ElapsedClock since={helperToolStart(startMs, firstSeen)} minMs={minMs} style={style} />;
}
