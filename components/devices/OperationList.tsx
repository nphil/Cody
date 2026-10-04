"use client";

import { Ban, Check, CircleAlert, Clock, Loader2, Send, ShieldAlert, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager, DeviceOperationSnapshot, OperationApproval, OperationRiskBinding, OperationState } from "@/lib/devices/operations";
import { Button, inputStyle, Notice, Segmented } from "./ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateKey(state: OperationState): string {
  switch (state) {
    case "starting": return "devices.operationStateStarting";
    case "running": return "devices.operationStateRunning";
    case "awaiting-confirmation": return "devices.operationStateAwaitingConfirmation";
    case "armed": return "devices.operationStateArmed";
    case "cancelling": return "devices.operationStateCancelling";
    case "succeeded": return "devices.operationStateSucceeded";
    case "failed": return "devices.operationStateFailed";
    case "cancelled": return "devices.operationStateCancelled";
  }
}

export function isTerminalState(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function backupUnavailable(backup: string): boolean {
  const value = backup.toLowerCase();
  return value.includes("backup unavailable") || value.includes("backup not available") || value.startsWith("unavailable:");
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

/** The device an approval is for, so approving it is approving THIS device (its label, and the USB identity when it has one). */
interface ApprovalDevice {
  label: string;
  identity?: string;
}

function RiskRows({ binding, device }: { binding: OperationRiskBinding; device: ApprovalDevice }): React.ReactElement {
  const { t } = useI18n();
  // Long values (hashes, free text) take a full row; short ones pair up when there is room.
  const rows: Array<[string, string, boolean]> = [
    [t("devices.confirmDevice"), device.identity ? `${device.label} (${device.identity})` : device.label, true],
    [t("devices.confirmAction"), binding.action, false],
    [t("devices.confirmTarget"), binding.target, false],
    ...(binding.sha256 ? [[t("devices.confirmPayloadHash"), binding.sha256, true] satisfies [string, string, boolean]] : []),
    ...(binding.offset !== undefined ? [[t("devices.confirmPayloadOffset"), String(binding.offset), false] satisfies [string, string, boolean]] : []),
    ...(binding.length !== undefined ? [[t("devices.confirmPayloadLength"), String(binding.length), false] satisfies [string, string, boolean]] : []),
    ...(binding.programSha256 ? [[t("devices.confirmProgramHash"), binding.programSha256, true] satisfies [string, string, boolean]] : []),
    ...(binding.programOffset !== undefined ? [[t("devices.confirmProgramOffset"), String(binding.programOffset), false] satisfies [string, string, boolean]] : []),
    ...(binding.programLength !== undefined ? [[t("devices.confirmProgramLength"), String(binding.programLength), false] satisfies [string, string, boolean]] : []),
    ...(binding.details ? [[t("devices.confirmDetails"), binding.details, true] satisfies [string, string, boolean]] : []),
    [t("devices.confirmProtectedOverride"), binding.protectedOverride ?? t("devices.none"), false],
    [t("devices.confirmBackup"), binding.backup, true],
  ];
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: 6, margin: 0, fontSize: 12, lineHeight: 1.4 }}>
      {rows.map(([label, value, wide]) => (
        <div key={label} style={{ minWidth: 0, gridColumn: wide ? "1 / -1" : undefined, padding: "6px 8px", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
          <dt style={{ color: "var(--text-dim)", fontSize: 11 }}>{label}</dt>
          <dd style={{ minWidth: 0, margin: 0, overflowWrap: "anywhere", color: "var(--text)" }}><code>{value}</code></dd>
        </div>
      ))}
    </dl>
  );
}

/** The waits the person can pick between approving and the command going out; the one the agent asked for is added when it is not among them. */
const SEND_DELAY_CHOICES: readonly number[] = [0, 10, 30, 60];

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

function ConfirmationCard({ manager, operation, device }: { manager: DeviceOperationManager; operation: DeviceOperationSnapshot; device: ApprovalDevice }): React.ReactElement | null {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [typedOverride, setTypedOverride] = useState("");
  const confirmation = operation.confirmation;
  const requestedDelay = confirmation?.sendDelaySeconds;
  const [sendDelay, setSendDelay] = useState(requestedDelay ?? 0);
  const card = useRef<HTMLElement>(null);
  const confirmationId = confirmation?.id;
  // A confirmation is the one thing the user must not miss; bring it into view when it appears.
  useEffect(() => {
    if (confirmationId) card.current?.scrollIntoView({ block: "nearest" });
  }, [confirmationId]);
  if (!confirmation) return null;
  const unavailable = backupUnavailable(confirmation.binding.backup);
  const override = confirmation.binding.protectedOverride;
  const choices = requestedDelay !== undefined && !SEND_DELAY_CHOICES.includes(requestedDelay)
    ? [...SEND_DELAY_CHOICES, requestedDelay].sort((left, right) => left - right)
    : SEND_DELAY_CHOICES;

  return (
    <section
      ref={card}
      role="alertdialog"
      aria-label={t("devices.confirmTitle")}
      style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, border: "2px solid color-mix(in srgb, var(--status-warning) 70%, var(--border))", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--status-warning)", fontSize: 14, fontWeight: 700 }}>
        <ShieldAlert size={18} aria-hidden="true" />{t("devices.confirmTitle")}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.confirmExactBinding")}</div>
      <RiskRows binding={confirmation.binding} device={{ label: device.label, identity: confirmation.device.identity ?? device.identity }} />
      {unavailable && <Notice tone="error" role="alert" icon={<CircleAlert size={14} />}>{t("devices.backupUnavailable")}</Notice>}
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {override && (
        <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
          <span>{t("devices.confirmTypeToEnable")} <code style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{override}</code></span>
          <input
            aria-label={t("devices.confirmProtectedOverride")}
            className="ui-focus-ring"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={typedOverride}
            onChange={(event) => setTypedOverride(event.target.value)}
            style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
          />
        </label>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Segmented
          label={t("devices.sendTimingLabel")}
          value={String(sendDelay)}
          options={choices.map((seconds) => ({ value: String(seconds), label: seconds === 0 ? t("devices.sendNow") : t("devices.sendInSeconds", { seconds }) }))}
          onChange={(value) => setSendDelay(Number(value))}
        />
        <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>
          {t("devices.sendTimingHint")}
          {requestedDelay !== undefined && <> {t("devices.sendTimingRequested", { seconds: requestedDelay })}</>}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <div style={{ flex: "1 1 140px" }}>
          <Button tone="danger" full icon={<X size={16} />} onClick={() => { try { manager.cancel(operation.id); } catch (caught) { setError(errorText(caught)); } }}>{t("devices.cancelOperation")}</Button>
        </div>
        <div style={{ flex: "1 1 140px" }}>
          <Button
            tone="primary"
            full
            icon={<Check size={16} />}
            disabled={Boolean(override && typedOverride !== override)}
            onClick={() => { try { manager.confirm(operation.id, confirmation.id, confirmation.binding, typedOverride, { sendDelaySeconds: sendDelay }); setError(null); } catch (caught) { setError(errorText(caught)); } }}
          >
            {sendDelay === 0 ? t("devices.confirmOperation") : t("devices.confirmOperationIn", { seconds: sendDelay })}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Approved, not sent yet: the exact action, a live countdown, and a Cancel that stops it before anything goes out. */
function ArmedCard({ manager, operation, approval }: { manager: DeviceOperationManager; operation: DeviceOperationSnapshot; approval: OperationApproval }): React.ReactElement {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const seconds = useSecondsUntil(approval.releaseAt);
  return (
    <section
      aria-label={t("devices.armedTitle", { seconds })}
      style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, border: "2px solid color-mix(in srgb, var(--accent) 70%, var(--border))", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--accent)", fontSize: 14, fontWeight: 700 }}>
        <Clock size={18} aria-hidden="true" />{t("devices.armedTitle", { seconds })}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text)", overflowWrap: "anywhere" }}><code>{approval.binding.action} · {approval.binding.target}</code></div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.armedBody")}</div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-dim)" }}>{t("devices.armedExpires", { time: new Date(approval.expiresAt).toLocaleTimeString() })}</div>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      <Button tone="danger" full icon={<X size={16} />} onClick={() => { try { manager.cancel(operation.id); } catch (caught) { setError(errorText(caught)); } }}>{t("devices.armedCancel")}</Button>
    </section>
  );
}

/** One operation: its state, progress, the approval it is waiting for or has given, and what came of it. `deviceLabel` names the device an approval is for. */
export function OperationCard({ manager, operation, deviceLabel }: { manager: DeviceOperationManager; operation: DeviceOperationSnapshot; deviceLabel: string }): React.ReactElement {
  const { t } = useI18n();
  const [monitorInput, setMonitorInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const finished = isTerminalState(operation.state);
  const progress = finished ? undefined : operation.progress;
  const percent = progress?.completed !== undefined && progress.total !== undefined ? Math.round((progress.completed / progress.total) * 100) : null;
  // The confirmation and countdown cards carry their own Cancel; a second one under them would be noise.
  const canCancel = !finished && operation.state !== "cancelling" && !operation.confirmation && !operation.armed;
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
      {operation.confirmation && <ConfirmationCard key={operation.confirmation.id} manager={manager} operation={operation} device={{ label: deviceLabel }} />}
      {operation.armed && <ArmedCard manager={manager} operation={operation} approval={operation.armed} />}
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
