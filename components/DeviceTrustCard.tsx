"use client";

import { useId, useRef, useState, type CSSProperties } from "react";
import { Check, ShieldQuestion, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { DeviceTrustRequest } from "@/lib/devices/trust";

/**
 * The one question that replaces every device approval: "Let the agent control <device>?", rendered in the chat's
 * input dock. Allow lets the agent run its commands on that device (flashes included) until it is unplugged or the
 * page is reloaded; "Remember this device" makes that last, for devices that can be told apart (a serial number).
 * Deny refuses the agent until the device is disconnected and connected again.
 *
 * Neither button carries `data-input-choice`: the dock focuses and number/Enter-activates the first such element,
 * and a consent to control hardware must never be given by a stray Enter or digit key. Both buttons are plain
 * tab stops.
 */

const buttonBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  flex: "1 1 120px",
  minWidth: 0,
  minHeight: 48,
  padding: "8px 12px",
  borderRadius: "var(--radius-control)",
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  overflowWrap: "anywhere",
};

export function DeviceTrustCard({
  request,
  onRespond,
}: {
  request: DeviceTrustRequest;
  onRespond: (allow: boolean, remember: boolean) => void;
}) {
  const { t } = useI18n();
  const hintId = useId();
  const canRemember = Boolean(request.key);
  const [ticked, setTicked] = useState(true);
  // One click is all this card ever sends: a second answer would at best be refused and at worst answer the NEXT
  // question this device asks. The REF is the latch, not the state: clicks dispatched inside one task all read the
  // pre-render state, and `disabled` only reaches the DOM after React commits. The state exists to re-render the
  // settled look.
  const answeredRef = useRef(false);
  const [answered, setAnswered] = useState(false);
  const title = t("deviceTrust.title", { device: request.label });

  const answer = (allow: boolean) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    setAnswered(true);
    onRespond(allow, ticked && canRemember);
  };

  return (
    <div
      role="group"
      aria-label={title}
      className="chat-block-in"
      style={{
        marginBottom: 0,
        padding: "10px 12px",
        border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
        borderRadius: "var(--radius-card)",
        background: "color-mix(in srgb, var(--accent) 5%, var(--bg-panel))",
        boxShadow: "var(--shadow-card)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <ShieldQuestion aria-hidden size={16} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
        <h3 style={{ margin: 0, minWidth: 0, color: "var(--text)", fontSize: 14, fontWeight: 700, lineHeight: 1.4, overflowWrap: "anywhere" }}>
          {title}
        </h3>
      </div>

      <p style={{ margin: "6px 0 0", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
        {t("deviceTrust.risk")}
      </p>

      {request.waiting > 1 && (
        <p style={{ margin: "6px 0 0", color: "var(--text-dim)", fontSize: 12, lineHeight: 1.5 }}>
          {t("deviceTrust.waiting", { count: request.waiting })}
        </p>
      )}

      {canRemember && (
        <div style={{ marginTop: 8 }}>
          <label
            style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 48, color: "var(--text)", fontSize: 13, cursor: answered ? "default" : "pointer" }}
          >
            <input
              type="checkbox"
              checked={ticked}
              disabled={answered}
              aria-describedby={hintId}
              onChange={(event) => setTicked(event.target.checked)}
              style={{ width: 18, height: 18, accentColor: "var(--accent)", flexShrink: 0 }}
            />
            {t("deviceTrust.remember")}
          </label>
          <div id={hintId} style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5, paddingLeft: 28 }}>
            {t("deviceTrust.rememberHint")}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={() => answer(true)}
          disabled={answered}
          style={{
            ...buttonBase,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "var(--on-accent)",
            cursor: answered ? "default" : "pointer",
            opacity: answered ? 0.6 : 1,
          }}
        >
          <Check aria-hidden size={15} style={{ flexShrink: 0 }} />
          {t("deviceTrust.allow")}
        </button>
        <button
          type="button"
          onClick={() => answer(false)}
          disabled={answered}
          style={{
            ...buttonBase,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            cursor: answered ? "default" : "pointer",
            opacity: answered ? 0.6 : 1,
          }}
        >
          <X aria-hidden size={15} style={{ flexShrink: 0 }} />
          {t("deviceTrust.deny")}
        </button>
      </div>

      {answered && (
        <div role="status" style={{ marginTop: 8, color: "var(--text-dim)", fontSize: 11 }}>
          {t("deviceTrust.sending")}
        </div>
      )}
    </div>
  );
}
