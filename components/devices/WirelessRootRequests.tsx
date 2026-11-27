"use client";

import { ShieldAlert } from "lucide-react";
import type { WirelessRootRequest } from "@/lib/devices/wireless-types";
import { useI18n } from "@/lib/i18n";
import { useSecondsUntil } from "./hooks";
import { Button, cardStyle, Notice } from "./ui";

function RootRequest({ request, busy, onAnswer }: { request: WirelessRootRequest; busy: boolean; onAnswer: (requestId: string, decision: "approve" | "deny") => void }) {
  const { t } = useI18n();
  const seconds = useSecondsUntil(request.expiresAt);
  const expired = seconds === 0;
  const approved = request.state === "approved";
  const { elevated } = request;
  const title = t(elevated ? "devices.wirelessRootTitle" : "devices.wirelessApprovalTitle");
  return (
    <div
      role="group"
      aria-label={title}
      style={{ ...cardStyle, borderColor: "color-mix(in srgb, var(--status-warning) 60%, var(--border))" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, color: "var(--status-warning)" }}><ShieldAlert size={18} /></span>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", minWidth: 0 }}>{title}</h3>
      </div>
      {request.reason && <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{request.reason}</p>}
      {/* The exact command, character for character: approving it is approving these words and nothing else. */}
      <pre
        tabIndex={0}
        dir="ltr"
        aria-label={t(elevated ? "devices.wirelessRootCommand" : "devices.wirelessShellCommand")}
        style={{ margin: 0, padding: "8px 10px", maxHeight: 160, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {request.command}
      </pre>
      {approved ? (
        <Notice tone="info" role="status">{t(elevated ? "devices.wirelessRootApproved" : "devices.wirelessApprovalApproved")}</Notice>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t(elevated ? "devices.wirelessRootWhy" : "devices.wirelessApprovalWhy")}</p>
          {!elevated && <Notice tone="warning">{t("devices.wirelessCommandRisk")}</Notice>}
          <span style={{ fontSize: 12, color: expired ? "var(--status-error)" : "var(--text-dim)" }}>
            {expired ? t("devices.wirelessRootExpired") : t("devices.wirelessRootExpires", { seconds })}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button onClick={() => onAnswer(request.id, "deny")} disabled={busy} style={{ flex: "1 1 120px" }}>{t("devices.wirelessRootDeny")}</Button>
            <Button tone="warning" onClick={() => onAnswer(request.id, "approve")} disabled={busy || expired} style={{ flex: "1 1 120px" }}>{t("devices.wirelessRootApprove")}</Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Exact commands the agent wants to run on the paired tablet, with or without root.
 * The server keeps the command and expires or consumes each request; the page sends only the decision.
 */
export function WirelessRootRequests({ requests, busy, error, onAnswer }: { requests: readonly WirelessRootRequest[]; busy: boolean; error?: string; onAnswer: (requestId: string, decision: "approve" | "deny") => void }): React.ReactElement | null {
  if (requests.length === 0) return null;
  return (
    <section aria-live="polite" aria-relevant="additions" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {requests.map((request) => <RootRequest key={request.id} request={request} busy={busy} onAnswer={onAnswer} />)}
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </section>
  );
}
