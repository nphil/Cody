"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Ban, Check, Clock, ExternalLink, Loader2, Lock, Minus, ShieldX, TimerOff, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useI18n } from "@/lib/i18n";
import {
  EMPTY_APPROVAL_INDEX,
  HOMELABBER_DEFAULT_BASE,
  approvalDeepLink,
  approvalPhase,
  approvalTone,
  approvalWebUrl,
  buildApprovalIndex,
  deadlineCheckDelay,
  formatCountdown,
  homelabberBaseFromMcpUrl,
  parseHomelabberApproval,
  reuseApprovalIndex,
  type ApprovalIndex,
  type ApprovalItemOutcome,
  type ApprovalPhase,
  type ApprovalState,
  type ApprovalTone,
} from "@/lib/homelabber-approval";
import { isRecord } from "@/lib/type-guards";
import type { AgentMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";

/**
 * HomeLabber approvals in the chat.
 *
 * A HomeLabber tool that needs Nitin's Face ID answers with a pending request
 * (flagged as an error by the MCP layer) and the agent then polls it with
 * `approval_wait`. `ToolCallBlock` draws the gated call as a card whose state
 * follows the request: the status row here while it waits, then approved,
 * done, denied, expired or failed as later `approval_wait` calls report it.
 * The parsing lives in `lib/homelabber-approval.ts`; this file is the React
 * half: the transcript-wide index, the per-call hook, the row, and the link base.
 */

// ── Latest state of every request in the transcript ─────────────────────────

export const ApprovalIndexContext = createContext<ApprovalIndex>(EMPTY_APPROVAL_INDEX);

/** Reads the transcript's HomeLabber calls once per change and shares the
 *  result by context. A card renders in the message that made the call, which
 *  `MessageView`'s memo does not re-render when a LATER message (the
 *  `approval_wait` that says "approved") arrives — context is what reaches it.
 *  The index keeps its identity while nothing about any request changed, so a
 *  chat without approvals, which is nearly every chat, never re-renders for it. */
export function HomelabberApprovalProvider({ messages, toolResults, children }: {
  messages: readonly AgentMessage[];
  toolResults: ReadonlyMap<string, ToolResultMessage>;
  children: ReactNode;
}) {
  const lastIndex = useRef<ApprovalIndex>(EMPTY_APPROVAL_INDEX);
  const index = useMemo(() => {
    const next = reuseApprovalIndex(lastIndex.current, buildApprovalIndex(messages, toolResults));
    lastIndex.current = next;
    return next;
  }, [messages, toolResults]);
  return <ApprovalIndexContext.Provider value={index}>{children}</ApprovalIndexContext.Provider>;
}

// ── One call → one card ─────────────────────────────────────────────────────

export interface ApprovalCard extends ApprovalState {
  /** `request`: the gated call, which draws the full card. `wait`: one
   *  `approval_wait` poll, which only labels itself. */
  role: "request" | "wait";
  /** The HomeLabber tool this call went to. */
  tool: string;
  /** Steps in an `approval_request_plan` call. */
  steps: number | null;
  phase: ApprovalPhase;
}

/** True once `deadline` (epoch ms) has passed. One timer, armed for the
 *  deadline itself: the card changes state once, with no per-second render of
 *  the block. A deadline that has already passed arms nothing — re-reading the
 *  clock there is how a closed window becomes an endless re-render. */
export function useDeadlinePassed(deadline: number | null): boolean {
  const [seenAt, setSeenAt] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const delay = deadlineCheckDelay(deadline, seenAt, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(() => setSeenAt(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [deadline, seenAt]);
  return deadline !== null && seenAt >= deadline;
}

/** The HomeLabber approval a tool call stands for, or null for every other
 *  tool call. A request shows the LATEST state of its id (the poll that says
 *  "done" comes later in the transcript); a poll shows only what it itself saw. */
export function useApprovalCard(block: ToolCallContent, result: ToolResultMessage | undefined): ApprovalCard | null {
  const index = useContext(ApprovalIndexContext);
  const observed = useMemo(() => parseHomelabberApproval(block, result), [block, result]);
  const state: ApprovalState | null = observed === null ? null
    : (observed.source === "request" ? index.get(observed.id) : undefined) ?? observed;
  const lapsed = useDeadlinePassed(observed?.source === "request" && state?.status === "pending" ? state.expiresAt : null);
  return useMemo(() => (observed === null || state === null ? null : {
    id: state.id,
    status: state.status,
    expiresAt: state.expiresAt,
    expiresClock: state.expiresClock,
    items: state.items,
    message: state.message,
    role: observed.source,
    tool: observed.tool,
    steps: observed.steps,
    phase: approvalPhase(state.status, lapsed),
  }), [observed, state, lapsed]);
}

// ── Look ────────────────────────────────────────────────────────────────────

export const TONE_COLOR: Record<ApprovalTone, string> = {
  warning: "var(--status-warning)",
  accent: "var(--accent)",
  success: "var(--status-success)",
  error: "var(--status-error)",
  neutral: "var(--text-dim)",
};

/** The tool card's frame per tone. `success` and `error` are the card's own
 *  two looks, unchanged; the rest are the same recipe in the other tokens. */
export const TONE_FRAME: Record<ApprovalTone, { border: string; background: string; rule: string }> = {
  success: {
    border: "1px solid color-mix(in srgb, var(--status-success) 25%, transparent)",
    background: "color-mix(in srgb, var(--status-success) 4%, transparent)",
    rule: "1px solid color-mix(in srgb, var(--status-success) 20%, transparent)",
  },
  error: {
    border: "1px solid color-mix(in srgb, var(--status-error) 45%, transparent)",
    background: "color-mix(in srgb, var(--status-error) 5%, transparent)",
    rule: "1px solid color-mix(in srgb, var(--status-error) 25%, transparent)",
  },
  warning: {
    border: "1px solid color-mix(in srgb, var(--status-warning) 45%, transparent)",
    background: "color-mix(in srgb, var(--status-warning) 6%, transparent)",
    rule: "1px solid color-mix(in srgb, var(--status-warning) 28%, transparent)",
  },
  accent: {
    border: "1px solid color-mix(in srgb, var(--accent) 38%, transparent)",
    background: "color-mix(in srgb, var(--accent) 5%, transparent)",
    rule: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
  },
  neutral: {
    border: "1px solid color-mix(in srgb, var(--text-dim) 32%, transparent)",
    background: "color-mix(in srgb, var(--text-dim) 4%, transparent)",
    rule: "1px solid color-mix(in srgb, var(--text-dim) 20%, transparent)",
  },
};

const PHASE_KEYS: Record<ApprovalPhase, { label: string; chip: string }> = {
  waiting: { label: "homelabberApproval.waiting", chip: "homelabberApproval.chip.waiting" },
  approved: { label: "homelabberApproval.approved", chip: "homelabberApproval.chip.approved" },
  done: { label: "homelabberApproval.done", chip: "homelabberApproval.chip.done" },
  failed: { label: "homelabberApproval.failed", chip: "homelabberApproval.chip.failed" },
  denied: { label: "homelabberApproval.denied", chip: "homelabberApproval.chip.denied" },
  expired: { label: "homelabberApproval.expired", chip: "homelabberApproval.chip.expired" },
  cancelled: { label: "homelabberApproval.cancelled", chip: "homelabberApproval.chip.cancelled" },
  lapsed: { label: "homelabberApproval.lapsed", chip: "homelabberApproval.chip.lapsed" },
};

const ITEM_KEYS: Record<ApprovalItemOutcome["status"], string> = {
  executed: "homelabberApproval.item.executed",
  failed: "homelabberApproval.item.failed",
  skipped: "homelabberApproval.item.skipped",
  pending: "homelabberApproval.item.pending",
};

const PHASE_ICON: Record<ApprovalPhase, LucideIcon> = {
  approved: Loader2,
  waiting: Lock,
  done: Check,
  failed: TriangleAlert,
  denied: ShieldX,
  expired: TimerOff,
  cancelled: Ban,
  lapsed: Clock,
};

const ITEM_ICON: Record<ApprovalItemOutcome["status"], { Icon: LucideIcon; color: string }> = {
  executed: { Icon: Check, color: "var(--status-success)" },
  failed: { Icon: X, color: "var(--status-error)" },
  skipped: { Icon: Minus, color: "var(--text-dim)" },
  pending: { Icon: Clock, color: "var(--text-dim)" },
};

/** The header's short state word, in the card's tone (the slot where an
 *  ordinary call shows `error`). */
export function ApprovalChip({ phase }: { phase: ApprovalPhase }) {
  const { t } = useI18n();
  return (
    <span style={{ color: TONE_COLOR[approvalTone(phase)], fontFamily: "var(--font-mono)", fontSize: 11, flexShrink: 0 }}>
      {t(PHASE_KEYS[phase].chip)}
    </span>
  );
}

// ── Where the backup-code page lives ────────────────────────────────────────

let resolvedBase: string | null = null;
let pendingBase: Promise<string> | null = null;

/** The web origin of HomeLabber, asked of the server once per page: it knows the
 *  configured `homelabber` MCP server's address and says only its origin. */
function loadHomelabberBase(): Promise<string> {
  pendingBase ??= fetch("/api/homelabber", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((body: unknown) => {
      const base = isRecord(body) ? homelabberBaseFromMcpUrl(body.base) : null;
      return base ?? HOMELABBER_DEFAULT_BASE;
    })
    .catch(() => HOMELABBER_DEFAULT_BASE)
    .then((base) => {
      resolvedBase = base;
      return base;
    });
  return pendingBase;
}

function useHomelabberBase(enabled: boolean): string {
  const [base, setBase] = useState(resolvedBase ?? HOMELABBER_DEFAULT_BASE);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadHomelabberBase().then((value) => {
      if (alive) setBase(value);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return base;
}

// ── The row ─────────────────────────────────────────────────────────────────

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function ApprovalItems({ items }: { items: readonly ApprovalItemOutcome[] }) {
  const { t } = useI18n();
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: "0 10px 7px 31px", display: "grid", gap: 3 }}>
      {items.map((item) => {
        const { Icon, color } = ITEM_ICON[item.status];
        return (
          <li key={item.seq} style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, fontSize: 11.5 }}>
            <Icon aria-label={t(ITEM_KEYS[item.status])} role="img" size={11} strokeWidth={2} style={{ color, flexShrink: 0, alignSelf: "center" }} />
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{item.tool ?? `#${item.seq + 1}`}</span>
            {item.message && (
              <span title={item.message} style={{ color: "var(--text-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.message}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What a gated call is doing right now, under its header. While Nitin has not
 *  answered it is the only thing the card needs to say, plus the two ways to
 *  answer: the HomeLabber app (the link opens it when Cody is open on the
 *  phone) and the web page that shows it in full (approving happens on the phone). */
export function ApprovalStatusRow({ card }: { card: ApprovalCard }) {
  const { t, tn } = useI18n();
  const coarse = useIsCoarsePointer();
  const waiting = card.phase === "waiting";
  const base = useHomelabberBase(waiting);
  const now = useNow(waiting && card.expiresAt !== null);
  const tone = approvalTone(card.phase);
  const color = TONE_COLOR[tone];
  const showItems = card.items.length > 0 && (card.phase === "approved" || card.phase === "done" || card.phase === "failed");
  const showMessage = card.message !== null && (card.phase === "failed" || card.phase === "cancelled");
  const PhaseIcon = PHASE_ICON[card.phase];

  const buttonBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    minHeight: coarse ? 36 : 26,
    padding: "0 10px",
    borderRadius: "var(--radius-control)",
    fontSize: 12,
    fontWeight: 600,
    textDecoration: "none",
    whiteSpace: "nowrap",
    touchAction: "manipulation",
  };

  return (
    <div role="group" aria-label={t("homelabberApproval.region")} style={{ borderTop: TONE_FRAME[tone].rule }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", padding: "7px 10px" }}>
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 15rem", minWidth: 0 }}>
          {/* Approved-and-running is the one phase still in motion: its icon turns. */}
          <PhaseIcon aria-hidden size={14} strokeWidth={2} className={card.phase === "approved" ? "icon-spin" : undefined} style={{ color, flexShrink: 0 }} />
          <span style={{ color: "var(--text)", fontWeight: 500, minWidth: 0, overflowWrap: "anywhere" }}>{t(PHASE_KEYS[card.phase].label)}</span>
          {card.steps !== null && card.steps > 0 && (
            <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{tn("homelabberApproval.steps", card.steps)}</span>
          )}
          {waiting && card.expiresAt !== null && (
            <span role="timer" style={{ color: "var(--status-warning)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {t("homelabberApproval.timeLeft", { time: formatCountdown(card.expiresAt - now) })}
            </span>
          )}
          {waiting && card.expiresAt === null && card.expiresClock !== null && (
            <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {t("homelabberApproval.expiresAt", { time: card.expiresClock })}
            </span>
          )}
        </div>
        {waiting && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px", marginLeft: "auto" }}>
            <a
              href={approvalDeepLink(card.id)}
              className="ui-focus-ring"
              title={t("homelabberApproval.openTitle")}
              style={{
                ...buttonBase,
                border: "1px solid var(--accent)",
                background: coarse ? "var(--accent)" : "color-mix(in srgb, var(--accent) 8%, var(--bg))",
                color: coarse ? "var(--on-accent)" : "var(--accent)",
              }}
            >
              <ExternalLink aria-hidden size={12} strokeWidth={2} />
              {t("homelabberApproval.open")}
            </a>
            <a
              href={approvalWebUrl(base, card.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="ui-focus-ring"
              title={t("homelabberApproval.detailsTitle")}
              style={{ ...buttonBase, padding: "0 2px", fontWeight: 500, color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: 2 }}
            >
              {t("homelabberApproval.details")}
            </a>
          </div>
        )}
      </div>
      {showMessage && (
        <div style={{ padding: "0 10px 7px 31px", color: "var(--text-dim)", fontSize: 11.5, overflowWrap: "anywhere" }}>{card.message}</div>
      )}
      {showItems && <ApprovalItems items={card.items} />}
    </div>
  );
}
