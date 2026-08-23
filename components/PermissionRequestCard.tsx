"use client";

import { useRef, useState } from "react";
import { Ban, Check, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  describeToolCall,
  isAllowChoice,
  isDurableChoice,
  type AgentPermissionKind,
  type AgentPermissionOption,
  type AgentPermissionRequest,
} from "@/lib/permission-request";

/**
 * One approval the agent is blocked on, rendered INLINE in the transcript —
 * deliberately not a modal. The request arrives mid-stream, and the answer
 * usually depends on what the agent just said, so the user has to be able to
 * read the conversation while deciding. A modal would cover exactly that.
 *
 * The buttons are the AGENT's options, in the order it sent them. Cody never
 * invents Allow/Deny, never reorders, never groups: `optionId` is the
 * identity, `name` is the label, and `kind` is only a styling hint. Two
 * options may legitimately carry the SAME kind and mean different things
 * (Hermes sends "Allow for session" and "Allow always", both `allow_always`),
 * so the NAME is the prominent element on every button — the styling can only
 * ever say "this is a grant" and "this one outlives the request", never which
 * grant it is.
 */

/** ACP's ToolKind vocabulary → its label key. Anything outside this map is an
 * agent-specific kind and renders verbatim rather than as a missing key. */
const TOOL_KIND_KEYS: Record<string, string> = {
  read: "permissionRequest.kindRead",
  edit: "permissionRequest.kindEdit",
  delete: "permissionRequest.kindDelete",
  move: "permissionRequest.kindMove",
  search: "permissionRequest.kindSearch",
  execute: "permissionRequest.kindExecute",
  think: "permissionRequest.kindThink",
  fetch: "permissionRequest.kindFetch",
  switch_mode: "permissionRequest.kindSwitchMode",
  other: "permissionRequest.kindOther",
};

const OPTION_ICONS: Record<AgentPermissionKind, typeof Check> = {
  allow_once: Check,
  allow_always: ShieldCheck,
  reject_once: X,
  reject_always: Ban,
};

interface OptionTone {
  border: string;
  background: string;
  hoverBackground: string;
  color: string;
}

/**
 * How each kind reads, and why:
 *  - `allow_once` is the ordinary approval, so it is the one filled, primary
 *    button — the thing a user's eye lands on and can safely click.
 *  - `allow_always` is a DURABLE grant. It stays accent-coloured (it is still
 *    an approval) but is outlined rather than filled, so it can never be
 *    mistaken for its one-shot sibling at a glance, and it carries the
 *    "Remembered" badge below.
 *  - `reject_once` is the safe answer and reads as the quiet secondary
 *    control: refusing costs nothing but a re-ask.
 *  - `reject_always` is a refusal that outlives the request, so it takes the
 *    same quiet frame tinted with the error colour plus the same badge —
 *    warned about, but never dressed up as the dangerous choice, because
 *    denying is not the dangerous choice.
 */
function optionTone(kind: AgentPermissionKind): OptionTone {
  switch (kind) {
    case "allow_once":
      return {
        border: "var(--accent)",
        background: "var(--accent)",
        hoverBackground: "var(--accent-hover)",
        color: "var(--on-accent)",
      };
    case "allow_always":
      return {
        border: "color-mix(in srgb, var(--accent) 55%, var(--border))",
        background: "color-mix(in srgb, var(--accent) 8%, var(--bg))",
        hoverBackground: "color-mix(in srgb, var(--accent) 18%, var(--bg))",
        color: "var(--accent)",
      };
    case "reject_always":
      return {
        border: "color-mix(in srgb, var(--status-error) 40%, var(--border))",
        background: "var(--bg)",
        hoverBackground: "color-mix(in srgb, var(--status-error) 10%, var(--bg))",
        color: "var(--status-error)",
      };
    case "reject_once":
    default:
      return {
        border: "var(--border)",
        background: "var(--bg)",
        hoverBackground: "var(--bg-hover)",
        color: "var(--text-muted)",
      };
  }
}

export function PermissionRequestCard({
  request,
  onRespond,
}: {
  request: AgentPermissionRequest;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  const { t } = useI18n();
  // The answer settles a JSON-RPC request the agent is blocked on; a second
  // one is at best ignored and at worst answers a DIFFERENT request that has
  // since taken the same slot. One click is all this card ever sends.
  //
  // The REF is the actual latch, not the state: two clicks dispatched inside a
  // single task both read the pre-render state, and `disabled` only lands on
  // the DOM after React commits. Measured — a synthetic triple-click sent
  // three answers through a state-only guard. The state exists to re-render
  // the settled look; the ref is what makes the guard true at the first click.
  const answeredRef = useRef<string | null>(null);
  const [answeredWith, setAnsweredWith] = useState<string | null>(null);
  const summary = describeToolCall(request.toolCall);

  const kindLabel = summary.kind
    ? (summary.kindKnown ? t(TOOL_KIND_KEYS[summary.kind]) : summary.kind)
    : null;

  return (
    <div
      role="group"
      aria-label={t("permissionRequest.heading")}
      className="chat-block-in"
      style={{
        marginBottom: 8,
        padding: "10px 12px",
        border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
        borderRadius: "var(--radius-card)",
        background: "color-mix(in srgb, var(--accent) 5%, var(--bg-panel))",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <ShieldQuestion aria-hidden size={14} style={{ flexShrink: 0, color: "var(--accent)" }} />
        <span style={{ color: "var(--accent)", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
          {t("permissionRequest.heading")}
        </span>
        {kindLabel && (
          <span
            style={{
              marginLeft: "auto",
              flexShrink: 0,
              padding: "1px 7px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-dim)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              maxWidth: "45%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {kindLabel}
          </span>
        )}
      </div>

      <div
        style={{
          color: summary.title ? "var(--text)" : "var(--text-muted)",
          fontSize: 13,
          lineHeight: 1.5,
          fontStyle: summary.title ? "normal" : "italic",
          fontFamily: summary.title ? "var(--font-mono)" : undefined,
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
        }}
      >
        {summary.title ?? t("permissionRequest.untitled")}
      </div>

      <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        {request.options.map((option) => (
          <PermissionOptionButton
            key={option.optionId}
            option={option}
            disabled={answeredWith !== null}
            chosen={answeredWith === option.optionId}
            durableLabel={t("permissionRequest.durable")}
            onClick={() => {
              if (answeredRef.current !== null) return;
              answeredRef.current = option.optionId;
              setAnsweredWith(option.optionId);
              onRespond(request.requestId, option.optionId);
            }}
          />
        ))}
      </div>

      {answeredWith !== null && (
        <div role="status" style={{ marginTop: 8, color: "var(--text-dim)", fontSize: 11 }}>
          {t("permissionRequest.sending")}
        </div>
      )}
    </div>
  );
}

function PermissionOptionButton({
  option,
  disabled,
  chosen,
  durableLabel,
  onClick,
}: {
  option: AgentPermissionOption;
  disabled: boolean;
  chosen: boolean;
  durableLabel: string;
  onClick: () => void;
}) {
  const tone = optionTone(option.kind);
  const Icon = OPTION_ICONS[option.kind];
  const durable = isDurableChoice(option.kind);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 10px",
        borderRadius: "var(--radius-control)",
        border: `1px solid ${tone.border}`,
        background: tone.background,
        color: tone.color,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        // A settled card stays legible — the user needs to see which option
        // they picked while the answer is in flight — but reads as inert.
        opacity: disabled && !chosen ? 0.45 : 1,
        transition: "background-color var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = tone.hoverBackground; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = tone.background; }}
    >
      <Icon aria-hidden size={14} style={{ flexShrink: 0 }} />
      {/* The agent's own wording, never translated and never abbreviated: it
          is the only thing separating two options that share a kind. */}
      <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{option.name}</span>
      {durable && (
        <span
          style={{
            marginLeft: "auto",
            flexShrink: 0,
            padding: "1px 6px",
            borderRadius: 999,
            border: `1px solid ${isAllowChoice(option.kind) ? "color-mix(in srgb, var(--status-warning) 55%, transparent)" : "var(--border)"}`,
            color: isAllowChoice(option.kind) ? "var(--status-warning)" : "var(--text-dim)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
          }}
        >
          {durableLabel}
        </span>
      )}
    </button>
  );
}
