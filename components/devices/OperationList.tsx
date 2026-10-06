"use client";

import { Ban, Clock, Loader2, Send, TerminalSquare, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager, DeviceOperationSnapshot, OperationCountdown, OperationState } from "@/lib/devices/operations";
import { Button, inputStyle, Notice } from "./ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateKey(state: OperationState): string {
  switch (state) {
    case "starting": return "devices.operationStateStarting";
    case "running": return "devices.operationStateRunning";
    case "awaiting-trust": return "deviceTrust.stateAwaiting";
    case "countdown": return "deviceTrust.stateCountdown";
    case "cancelling": return "devices.operationStateCancelling";
    case "succeeded": return "devices.operationStateSucceeded";
    case "failed": return "devices.operationStateFailed";
    case "cancelled": return "devices.operationStateCancelled";
  }
}

export function isTerminalState(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** Every operation the manager remembers for this session, kept current while mounted. */
export function useOperations(manager: DeviceOperationManager | null): readonly DeviceOperationSnapshot[] {
  const [operations, setOperations] = useState<readonly DeviceOperationSnapshot[]>([]);
  useEffect(() => {
    if (!manager) {
      setOperations([]);
      return;
    }
    const sync = () => setOperations(manager.snapshots());
    sync();
    return manager.subscribe(sync);
  }, [manager]);
  return operations;
}

const outputStyle: React.CSSProperties = {
  maxHeight: 160,
  overflow: "auto",
  margin: 0,
  padding: 8,
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text-muted)",
  fontSize: 12,
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

/** Whole seconds left until `timestamp`, ticking while mounted. */
function useSecondsUntil(timestamp: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [timestamp]);
  return Math.max(0, Math.ceil((timestamp - now) / 1000));
}

/** Not sent yet: the exact action, a live countdown, and a Cancel that stops it before anything goes out. */
function CountdownCard({ manager, operation, countdown }: { manager: DeviceOperationManager; operation: DeviceOperationSnapshot; countdown: OperationCountdown }): React.ReactElement {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const seconds = useSecondsUntil(countdown.releaseAt);
  return (
    <section
      aria-label={t("deviceTrust.countdownTitle", { seconds })}
      style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, border: "2px solid color-mix(in srgb, var(--accent) 70%, var(--border))", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--accent)", fontSize: 14, fontWeight: 700 }}>
        <Clock size={18} aria-hidden="true" />{t("deviceTrust.countdownTitle", { seconds })}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text)", overflowWrap: "anywhere" }}><code>{countdown.binding.action} - {countdown.binding.target}</code></div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("deviceTrust.countdownBody")}</div>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      <Button tone="danger" full icon={<X size={16} />} onClick={() => { try { manager.cancel(operation.id); } catch (caught) { setError(errorText(caught)); } }}>{t("deviceTrust.countdownCancel")}</Button>
    </section>
  );
}

/** One operation: its state, progress, the countdown it is in before sending, and what came of it. */
export function OperationCard({ manager, operation }: { manager: DeviceOperationManager; operation: DeviceOperationSnapshot }): React.ReactElement {
  const { t } = useI18n();
  const [monitorInput, setMonitorInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const finished = isTerminalState(operation.state);
  const progress = finished ? undefined : operation.progress;
  const percent = progress?.completed !== undefined && progress.total !== undefined ? Math.round((progress.completed / progress.total) * 100) : null;
  // The countdown card carries its own Cancel; a second one under it would be noise.
  const canCancel = !finished && operation.state !== "cancelling" && !operation.countdown;
  const sendMonitor = async () => {
    try {
      await manager.sendUser(operation.id, monitorInput);
      setMonitorInput("");
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  const subject = operation.request.command ?? operation.request.target;

  return (
    <article style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {finished ? <TerminalSquare size={16} aria-hidden="true" /> : <Loader2 size={16} aria-hidden="true" className="icon-spin" />}
        <span style={{ minWidth: 0, flex: 1, color: "var(--text)", fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>{operation.request.protocol} · {operation.request.action}</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t(stateKey(operation.state))}</span>
      </div>
      {subject && <code title={subject} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text-muted)" }}>{subject}</code>}
      {progress && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
            <span>{progress.message || progress.phase}</span>
            {percent !== null && <span>{percent}%</span>}
          </div>
          {percent !== null && (
            <div aria-label={t("devices.operationProgress", { percent })} style={{ height: 6, overflow: "hidden", borderRadius: 99, background: "var(--border)" }}>
              <div style={{ width: `${percent}%`, height: "100%", background: "var(--accent)" }} />
            </div>
          )}
        </div>
      )}
      {operation.state === "awaiting-trust" && <Notice tone="info" role="status">{t("deviceTrust.awaitingBody")}</Notice>}
      {operation.countdown && <CountdownCard manager={manager} operation={operation} countdown={operation.countdown} />}
      {operation.error && <Notice tone={operation.state === "cancelled" ? "warning" : "error"} role="alert">{operation.error}</Notice>}
      {operation.result && (
        <section aria-label={t("devices.operationResult")} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
          <strong style={{ fontSize: 13 }}>{operation.result.summary}</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
            {operation.result.verified !== undefined && <span>{t("devices.operationVerified")}: {operation.result.verified ? t("devices.yes") : t("devices.no")}</span>}
            {operation.result.sha256 && <span>{t("devices.operationResultHash")}: {operation.result.sha256}</span>}
            {operation.result.fileId && <span>{t("devices.operationResultFile")}: {operation.result.fileId}</span>}
          </div>
          {operation.result.details && Object.keys(operation.result.details).length > 0 && (
            <pre aria-label={t("devices.operationResultDetails")} style={outputStyle}>{JSON.stringify(operation.result.details, null, 2)}</pre>
          )}
        </section>
      )}
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {operation.output.length > 0 && <pre aria-label={t("devices.operationOutput")} style={outputStyle}>{operation.output.map((output) => output.line).join("\n")}</pre>}
      {operation.request.action === "monitor" && operation.state === "running" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <label className="sr-only" htmlFor={`monitor-${operation.id}`}>{t("devices.monitorInput")}</label>
          <input
            id={`monitor-${operation.id}`}
            className="ui-focus-ring"
            value={monitorInput}
            onChange={(event) => setMonitorInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && monitorInput) void sendMonitor(); }}
            placeholder={t("devices.monitorInput")}
            style={{ ...inputStyle, flex: "1 1 160px", width: "auto", minWidth: 0 }}
          />
          <Button disabled={!monitorInput} icon={<Send size={16} />} onClick={() => void sendMonitor()}>{t("devices.sendMonitor")}</Button>
        </div>
      )}
      {canCancel && (
        <div>
          <Button tone="danger" icon={<Ban size={16} />} onClick={() => { try { manager.cancel(operation.id); } catch (caught) { setError(errorText(caught)); } }}>{t("devices.cancelOperation")}</Button>
        </div>
      )}
    </article>
  );
}
