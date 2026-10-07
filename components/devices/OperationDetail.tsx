"use client";

import { Ban, Send } from "lucide-react";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { memberOutcome, type MemberOutcome } from "@/lib/devices/jobs";
import type { DeviceOperationManager, DeviceOperationSnapshot, OperationRiskBinding } from "@/lib/devices/operations";
import { CopyButton } from "./CopyButton";
import { OutcomeIcon } from "./job-icons";
import { durationText, protocolName, whenText } from "./job-text";
import { isTerminalState } from "./OperationList";
import { Button, inputStyle, Notice, sectionHeadingStyle } from "./ui";

/** How many log lines the sheet writes out before it offers the earlier ones: a backup's log is long and the end is what matters. */
export const LOG_TAIL_LINES = 200;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OUTCOME_KEY: Record<MemberOutcome, string> = {
  succeeded: "devices.operationStateSucceeded",
  failed: "devices.operationStateFailed",
  stopped: "devices.jobState.stopped",
  cancelled: "devices.operationStateCancelled",
  declined: "devices.jobState.declined",
  active: "devices.operationStateRunning",
  waiting: "deviceTrust.stateAwaiting",
  countdown: "deviceTrust.stateCountdown",
};

const sectionStyle = { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 } as const;

/** The action an operation said it was about to take, while it counts down or from its log afterwards. */
export function declaredBinding(operation: DeviceOperationSnapshot): OperationRiskBinding | undefined {
  return operation.countdown?.binding ?? operation.events.findLast((event) => event.type === "declared")?.declared;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <dt style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</dt>
      <dd style={{ margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}

/** What the person reads when they want to know exactly what an operation did: the result, what it declared, its hashes and its log. */
export function OperationDetail({ manager, operation, deviceLabel }: { manager: DeviceOperationManager | null; operation: DeviceOperationSnapshot; deviceLabel: string }): React.ReactElement {
  const { t, locale } = useI18n();
  const [monitorInput, setMonitorInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [allLines, setAllLines] = useState(false);
  const finished = isTerminalState(operation.state);
  const outcome = memberOutcome(operation);
  const declared = declaredBinding(operation);
  const lines = operation.output.map((entry) => entry.line);
  const shown = allLines ? lines : lines.slice(-LOG_TAIL_LINES);
  const { request, result } = operation;
  const subject = request.target ?? request.command;
  const details = result?.details && Object.keys(result.details).length > 0 ? JSON.stringify(result.details, null, 2) : null;

  const sendMonitor = async (): Promise<void> => {
    if (!manager) return;
    try {
      await manager.sendUser(operation.id, monitorInput);
      setMonitorInput("");
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 13 }}>
        <OutcomeIcon outcome={outcome} size={16} />
        <strong style={{ color: "var(--text)" }}>{t(OUTCOME_KEY[outcome])}</strong>
        <span style={{ color: "var(--text-muted)" }}>
          {whenText(operation.createdAt, locale)}
          {finished ? ` · ${t("devices.sheet.took", { time: durationText(operation.updatedAt - operation.createdAt, t) })}` : ""}
        </span>
      </div>

      {operation.error && <Notice tone={outcome === "cancelled" || outcome === "stopped" ? "warning" : "error"} role="alert">{operation.error}</Notice>}
      {error && <Notice tone="error" role="alert">{error}</Notice>}

      {result && (
        <section aria-label={t("devices.operationResult")} style={sectionStyle}>
          <h4 style={sectionHeadingStyle}>{t("devices.operationResult")}</h4>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>{result.summary}</p>
          {result.verified !== undefined && <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("devices.operationVerified")}: {result.verified ? t("devices.yes") : t("devices.no")}</p>}
        </section>
      )}

      {declared && (
        <section aria-label={t("devices.sheet.declared")} style={sectionStyle}>
          <h4 style={sectionHeadingStyle}>{t("devices.sheet.declared")}</h4>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}><code>{declared.action} - {declared.target}</code></p>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{declared.backup}</p>
          {declared.details && <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{declared.details}</p>}
        </section>
      )}

      <section aria-label={t("devices.sheet.technical")} style={sectionStyle}>
        <h4 style={sectionHeadingStyle}>{t("devices.sheet.technical")}</h4>
        <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <Fact label={t("devices.fact.device")}>{deviceLabel}</Fact>
          <Fact label={t("devices.fact.operation")}>{protocolName(request.protocol, t)} · {request.action}</Fact>
          {subject && <Fact label={t("devices.fact.target")}><code>{subject}</code></Fact>}
          <Fact label={t("devices.fact.startedBy")}>{t(operation.origin === "user" ? "devices.fact.byPerson" : "devices.fact.byAgent")}</Fact>
          {result?.sha256 && (
            <Fact label={t("devices.operationResultHash")}><code>{result.sha256}</code><CopyButton text={result.sha256} label={t("devices.sheet.copy")} ariaLabel={t("devices.sheet.copyNamed", { what: t("devices.operationResultHash") })} /></Fact>
          )}
          {result?.fileId && (
            <Fact label={t("devices.operationResultFile")}><code>{result.fileId}</code><CopyButton text={result.fileId} label={t("devices.sheet.copy")} ariaLabel={t("devices.sheet.copyNamed", { what: t("devices.operationResultFile") })} /></Fact>
          )}
          <Fact label={t("devices.fact.operationId")}><code>{operation.id}</code></Fact>
        </dl>
      </section>

      <section aria-label={t("devices.sheet.log")} style={sectionStyle}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h4 style={sectionHeadingStyle}>{t("devices.sheet.log")}</h4>
          {lines.length > 0 && <CopyButton text={lines.join("\n")} label={t("devices.sheet.copyLog")} />}
        </div>
        {lines.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>{t("devices.sheet.logEmpty")}</p>
        ) : (
          <>
            {shown.length < lines.length && <Button tone="quiet" onClick={() => setAllLines(true)}>{t("devices.sheet.logEarlier", { count: lines.length - shown.length })}</Button>}
            <pre className="dv-log" aria-label={t("devices.operationOutput")}>{shown.join("\n")}</pre>
          </>
        )}
      </section>

      {details && (
        <details className="dv-disclosure" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
          <summary className="ui-focus-ring" style={{ display: "flex", alignItems: "center", minHeight: 44, padding: "0 12px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--text)", listStyle: "none" }}>{t("devices.sheet.raw")}</summary>
          <pre className="dv-log" aria-label={t("devices.operationResultDetails")} style={{ margin: "0 12px 12px" }}>{details}</pre>
        </details>
      )}

      {request.action === "monitor" && operation.state === "running" && manager && (
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

      {!finished && operation.state !== "cancelling" && manager && (
        <div>
          <Button tone="danger" icon={<Ban size={16} />} onClick={() => { try { manager.cancel(operation.id); } catch (caught) { setError(errorText(caught)); } }}>{t("devices.cancelOperation")}</Button>
        </div>
      )}
    </div>
  );
}
