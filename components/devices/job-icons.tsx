"use client";

import { Ban, Check, CircleAlert, Clock, Loader2, MessageCircleQuestion, ShieldOff, TriangleAlert } from "lucide-react";
import type { JobPhase, MemberOutcome } from "@/lib/devices/jobs";

/**
 * One glyph and one colour per state. The glyph is decoration: the state is always also written next to it, so nothing
 * here is the only thing that says "failed".
 */
const PHASE_COLOR: Record<JobPhase, string> = {
  waiting: "var(--status-warning)",
  countdown: "var(--accent)",
  running: "var(--accent)",
  done: "var(--status-success)",
  failed: "var(--status-error)",
  stopped: "var(--status-warning)",
  cancelled: "var(--text-dim)",
  declined: "var(--text-dim)",
};

const OUTCOME_PHASE: Record<MemberOutcome, JobPhase> = {
  succeeded: "done",
  failed: "failed",
  stopped: "stopped",
  cancelled: "cancelled",
  declined: "declined",
  active: "running",
  waiting: "waiting",
  countdown: "countdown",
};

export function phaseColor(phase: JobPhase): string {
  return PHASE_COLOR[phase];
}

export function PhaseIcon({ phase, size = 16 }: { phase: JobPhase; size?: number }): React.ReactElement {
  const common = { size, "aria-hidden": true, style: { flexShrink: 0, color: PHASE_COLOR[phase] } } as const;
  switch (phase) {
    case "waiting": return <MessageCircleQuestion {...common} />;
    case "countdown": return <Clock {...common} />;
    case "running": return <Loader2 {...common} className="icon-spin" />;
    case "done": return <Check {...common} />;
    case "failed": return <CircleAlert {...common} />;
    case "stopped": return <TriangleAlert {...common} />;
    case "cancelled": return <Ban {...common} />;
    case "declined": return <ShieldOff {...common} />;
  }
}

/** The glyph of one operation inside a job (a partition in the list of fifty-eight). */
export function OutcomeIcon({ outcome, size = 14 }: { outcome: MemberOutcome; size?: number }): React.ReactElement {
  return <PhaseIcon phase={OUTCOME_PHASE[outcome]} size={size} />;
}
