"use client";

import { Ban, Check, ChevronDown, CircleAlert, Loader2, Send, ShieldAlert, TerminalSquare, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Select } from "@/components/ui/Select";
import { adbFlasher } from "@/lib/devices/adb";
import { dfuFlasher } from "@/lib/devices/dfu";
import { espFlasher } from "@/lib/devices/esp";
import { fastbootFlasher } from "@/lib/devices/fastboot";
import { geckoFlasher } from "@/lib/devices/gecko";
import { stk500Flasher } from "@/lib/devices/stk500";
import { stm32Flasher } from "@/lib/devices/stm32";
import { useI18n } from "@/lib/i18n";
import { deviceArtifacts } from "@/lib/devices/artifacts";
import type { DeviceInfo } from "@/lib/devices/protocol";
import type { HardwareAction, HardwareProtocol } from "@/lib/devices/flasher";
import type { DeviceOperationManager, DeviceOperationSnapshot, OperationRiskBinding, OperationState } from "@/lib/devices/operations";

interface OperationPanelProps {
  sessionId: string;
  manager: DeviceOperationManager | null;
  devices: readonly DeviceInfo[];
  selectedInputId: string | null;
}

interface OperationStartFormProps extends Omit<OperationPanelProps, "manager"> {
  manager: DeviceOperationManager;
}

function actionStyle(tone: "normal" | "danger" = "normal"): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 24,
    padding: "0 7px",
    border: `1px solid ${tone === "danger" ? "color-mix(in srgb, var(--status-error) 55%, var(--border))" : "var(--border)"}`,
    borderRadius: "var(--radius-control)",
    background: "var(--bg-panel)",
    color: tone === "danger" ? "var(--status-error)" : "var(--text)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateKey(state: OperationState): string {
  switch (state) {
    case "starting": return "devices.operationStateStarting";
    case "running": return "devices.operationStateRunning";
    case "awaiting-confirmation": return "devices.operationStateAwaitingConfirmation";
    case "cancelling": return "devices.operationStateCancelling";
    case "succeeded": return "devices.operationStateSucceeded";
    case "failed": return "devices.operationStateFailed";
    case "cancelled": return "devices.operationStateCancelled";
  }
}

function terminal(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function backupUnavailable(backup: string): boolean {
  const value = backup.toLowerCase();
  return value.includes("backup unavailable") || value.includes("backup not available") || value.startsWith("unavailable:");
}

const SHIPPED_FLASHERS = [espFlasher, adbFlasher, fastbootFlasher, geckoFlasher, stm32Flasher, stk500Flasher, dfuFlasher] as const;

/** The same protocol declarations used by the page operation delegate. Geometry-dependent actions remain unavailable until protocol detection can bind an intrinsic plan. */
const ACTIONS_BY_PROTOCOL = Object.fromEntries(SHIPPED_FLASHERS.map((flasher) => [
  flasher.protocol,
  flasher.actions,
])) as Readonly<Record<HardwareProtocol, readonly HardwareAction[]>>;

function OperationStartForm({ manager, devices, selectedInputId, sessionId }: OperationStartFormProps): React.ReactElement {
  const { t } = useI18n();
  const [deviceId, setDeviceId] = useState(() => devices[0]?.id ?? "");
  const [protocol, setProtocol] = useState<HardwareProtocol>("esp");
  const [action, setAction] = useState<HardwareAction>("detect");
  const [target, setTarget] = useState("");
  const [offset, setOffset] = useState("");
  const [length, setLength] = useState("");
  const [baudRate, setBaudRate] = useState("");
  const [command, setCommand] = useState("");
  const [expectedChip, setExpectedChip] = useState("");
  const [protectedOverride, setProtectedOverride] = useState("");
  const selectedDevice = devices.find((device) => device.id === deviceId);
  const needsTarget = action === "flash" || action === "dump" || action === "push" || action === "pull";
  const needsRange = action === "flash" || action === "dump";
  const needsCommand = action === "exec";
  const needsBaudRate = action === "monitor" && selectedDevice?.kind === "serial";
  const protocolCandidates = useMemo(() => selectedDevice?.protocolCandidates?.filter((candidate) => candidate.protocol === protocol) ?? [], [protocol, selectedDevice]);
  const [candidateKey, setCandidateKey] = useState("");
  const selectedCandidate = protocolCandidates.find((candidate) => `${candidate.interfaceNumber}:${candidate.alternateSetting}` === candidateKey);
  const [error, setError] = useState<string | null>(null);
  const input = selectedInputId ? deviceArtifacts.list(sessionId).find((artifact) => artifact.id === selectedInputId) : undefined;
  const inputRequired = action === "flash" || action === "push" || action === "sideload";

  useEffect(() => {
    if (!devices.some((device) => device.id === deviceId)) setDeviceId(devices[0]?.id ?? "");
  }, [deviceId, devices]);
  useEffect(() => {
    if (protocolCandidates.length === 1) {
      const [candidate] = protocolCandidates;
      setCandidateKey(`${candidate.interfaceNumber}:${candidate.alternateSetting}`);
      return;
    }
    if (!protocolCandidates.some((candidate) => `${candidate.interfaceNumber}:${candidate.alternateSetting}` === candidateKey)) setCandidateKey("");
  }, [candidateKey, protocolCandidates]);

  const start = () => {
    try {
      if (!deviceId) throw new Error(t("devices.operationNoDevices"));
      if (protocolCandidates.length > 1 && !selectedCandidate) throw new Error(t("devices.operationInterfaceRequired"));
      if (inputRequired && !input) throw new Error(t("devices.operationInputRequired"));
      if (needsTarget && !target.trim()) throw new Error(t("devices.operationTargetRequired"));
      if (needsCommand && !command.trim()) throw new Error(t("devices.operationCommandRequired"));
      const parsedOffset = offset.trim() ? Number(offset) : undefined;
      const parsedLength = length.trim() ? Number(length) : undefined;
      const parsedBaudRate = baudRate.trim() ? Number(baudRate) : undefined;
      for (const [value, label, minimum] of [[parsedOffset, "offset", 0], [parsedLength, "length", 1], [parsedBaudRate, "baud rate", 1]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) throw new Error(`${label} must be a safe integer of at least ${minimum}.`);
      }
      if (action === "dump" && (parsedOffset === undefined || parsedLength === undefined)) throw new Error(t("devices.operationRangeRequired"));
      const options: Record<string, string> = {};
      if (expectedChip.trim()) options.expectedChip = expectedChip.trim();
      if (protectedOverride) options.protectedOverride = protectedOverride;
      manager.startUser({
        deviceId, protocol, action,
        ...(selectedCandidate ? { interfaceNumber: selectedCandidate.interfaceNumber } : {}),
        ...(selectedCandidate ? { alternateSetting: selectedCandidate.alternateSetting } : {}),
        ...(needsTarget ? { target: target.trim() } : {}),
        ...(needsRange && parsedOffset !== undefined ? { offset: parsedOffset } : {}),
        ...(needsRange && parsedLength !== undefined ? { length: parsedLength } : {}),
        ...(needsBaudRate && parsedBaudRate !== undefined ? { baudRate: parsedBaudRate } : {}),
        ...(needsCommand ? { command: command.trim() } : {}),
        ...(inputRequired && input ? { fileId: input.id, sha256: input.sha256 } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      });
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); start(); }} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.35 }}>{t("devices.operationSetup")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 5 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationDevice")}<Select aria-label={t("devices.operationDevice")} value={deviceId || null} onChange={setDeviceId} options={devices.map((device) => ({ value: device.id, label: device.label }))} size="sm" /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationProtocol")}<Select aria-label={t("devices.operationProtocol")} value={protocol} onChange={(next) => { setProtocol(next); setAction(ACTIONS_BY_PROTOCOL[next][0]); }} options={(Object.keys(ACTIONS_BY_PROTOCOL) as HardwareProtocol[]).filter((value) => ACTIONS_BY_PROTOCOL[value].length > 0).map((value) => ({ value, label: value }))} size="sm" /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationAction")}<Select aria-label={t("devices.operationAction")} value={action} onChange={setAction} options={ACTIONS_BY_PROTOCOL[protocol].map((value) => ({ value, label: value }))} size="sm" /></label>
        {protocolCandidates.length > 1 && <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationInterface")}<Select aria-label={t("devices.operationInterface")} value={candidateKey || null} onChange={setCandidateKey} placeholder={t("devices.operationInterfaceRequired")} options={protocolCandidates.map((candidate) => ({ value: `${candidate.interfaceNumber}:${candidate.alternateSetting}`, label: t("devices.operationInterfaceTuple", { interfaceNumber: candidate.interfaceNumber, alternateSetting: candidate.alternateSetting }) }))} size="sm" /></label>}
        {needsTarget && <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationTarget")}<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={t("devices.operationTargetPlaceholder")} style={{ height: 24, minWidth: 0, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }} /></label>}
        {needsRange && <><label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationOffset")}<input type="number" min="0" value={offset} onChange={(event) => setOffset(event.target.value)} style={{ height: 24, minWidth: 0, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }} /></label><label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationLength")}<input type="number" min="1" value={length} onChange={(event) => setLength(event.target.value)} style={{ height: 24, minWidth: 0, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }} /></label></>}
        {needsBaudRate && <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationBaudRate")}<input type="number" min="1" value={baudRate} onChange={(event) => setBaudRate(event.target.value)} style={{ height: 24, minWidth: 0, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }} /></label>}
        {needsCommand && <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationCommand")}<input value={command} onChange={(event) => setCommand(event.target.value)} style={{ height: 24, minWidth: 0, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }} /></label>}
        {action === "flash" && <><label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationExpectedChip")}<input value={expectedChip} onChange={(event) => setExpectedChip(event.target.value)} style={{ height: 24, minWidth: 0, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }} /></label><label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>{t("devices.operationProtectedOverride")}<Select aria-label={t("devices.operationProtectedOverride")} value={protectedOverride || "none"} onChange={(value) => setProtectedOverride(value === "none" ? "" : value)} options={[{ value: "none", label: t("devices.none") }, { value: "allow-preloader", label: "allow-preloader" }, { value: "allow-lk", label: "allow-lk" }, { value: "allow-tee", label: "allow-tee" }, { value: "allow-fuses", label: "allow-fuses" }, { value: "allow-bootloader", label: "allow-bootloader" }, { value: "allow-spi-boot", label: "allow-spi-boot" }, ...(protocol === "fastboot" ? [{ value: "allow-unknown", label: t("devices.operationUnknownOverride"), description: t("devices.operationUnknownOverrideDescription") }] : [])]} size="sm" /></label></>}
      </div>
      {inputRequired && <div style={{ fontSize: 10, lineHeight: 1.35, color: input ? "var(--text-muted)" : "var(--status-warning)", overflowWrap: "anywhere" }}>{input ? `${t("devices.operationSelectedInput")}: ${input.name} (${input.id})` : t("devices.operationInputRequired")}</div>}
      {error && <div role="alert" style={{ fontSize: 11, color: "var(--status-error)", overflowWrap: "anywhere" }}>{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}><button type="submit" className="ui-focus-ring" disabled={devices.length === 0} style={{ ...actionStyle(), opacity: devices.length === 0 ? 0.6 : 1, cursor: devices.length === 0 ? "default" : "pointer" }}>{t("devices.startOperation")}</button></div>
    </form>
  );
}

function RiskRows({ binding }: { binding: OperationRiskBinding }): React.ReactElement {
  const { t } = useI18n();
  const rows: Array<[string, string]> = [
    [t("devices.confirmAction"), binding.action],
    [t("devices.confirmTarget"), binding.target],
    ...(binding.sha256 ? [[t("devices.confirmPayloadHash"), binding.sha256] satisfies [string, string]] : []),
    ...(binding.offset !== undefined ? [[t("devices.confirmPayloadOffset"), String(binding.offset)] satisfies [string, string]] : []),
    ...(binding.length !== undefined ? [[t("devices.confirmPayloadLength"), String(binding.length)] satisfies [string, string]] : []),
    ...(binding.programSha256 ? [[t("devices.confirmProgramHash"), binding.programSha256] satisfies [string, string]] : []),
    ...(binding.programOffset !== undefined ? [[t("devices.confirmProgramOffset"), String(binding.programOffset)] satisfies [string, string]] : []),
    ...(binding.programLength !== undefined ? [[t("devices.confirmProgramLength"), String(binding.programLength)] satisfies [string, string]] : []),
    ...(binding.details ? [[t("devices.confirmDetails"), binding.details] satisfies [string, string]] : []),
    [t("devices.confirmProtectedOverride"), binding.protectedOverride ?? t("devices.none")],
    [t("devices.confirmBackup"), binding.backup],
  ];
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "minmax(74px, auto) minmax(0, 1fr)", gap: "3px 8px", margin: 0, fontSize: 11, lineHeight: 1.35 }}>
      {rows.map(([label, value]) => <div key={label} style={{ display: "contents" }}><dt style={{ color: "var(--text-dim)" }}>{label}</dt><dd style={{ minWidth: 0, margin: 0, overflowWrap: "anywhere", color: "var(--text)" }}><code>{value}</code></dd></div>)}
    </dl>
  );
}

function ConfirmationCard({ manager, operation }: { manager: DeviceOperationManager; operation: DeviceOperationSnapshot }): React.ReactElement | null {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [typedOverride, setTypedOverride] = useState("");
  const confirmation = operation.confirmation;
  if (!confirmation) return null;
  const unavailable = backupUnavailable(confirmation.binding.backup);

  return (
    <section role="alertdialog" aria-label={t("devices.confirmTitle")} style={{ display: "flex", flexDirection: "column", gap: 7, padding: 8, border: "1px solid color-mix(in srgb, var(--status-warning) 60%, var(--border))", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--status-warning)", fontSize: 12, fontWeight: 700 }}><ShieldAlert size={14} aria-hidden="true" />{t("devices.confirmTitle")}</div>
      <div style={{ fontSize: 11, lineHeight: 1.4, color: "var(--text-muted)" }}>{t("devices.confirmExactBinding")}</div>
      <RiskRows binding={confirmation.binding} />
      {unavailable && <div role="alert" style={{ display: "flex", gap: 5, alignItems: "flex-start", fontSize: 11, lineHeight: 1.35, color: "var(--status-error)" }}><CircleAlert size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />{t("devices.backupUnavailable")}</div>}
      {error && <div role="alert" style={{ fontSize: 11, color: "var(--status-error)", overflowWrap: "anywhere" }}>{error}</div>}
      {confirmation.binding.protectedOverride && <label style={{ display: "grid", gap: 4 }}>{t("devices.confirmProtectedOverride")}: <code>{confirmation.binding.protectedOverride}</code><input aria-label={t("devices.confirmProtectedOverride")} autoComplete="off" autoCapitalize="off" spellCheck={false} value={typedOverride} onChange={(event) => setTypedOverride(event.target.value)} style={{ minHeight: 48, fontSize: 16, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} /></label>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button type="button" className="ui-focus-ring" style={actionStyle("danger")} onClick={() => { try { manager.cancel(operation.id); } catch (caught) { setError(errorText(caught)); } }}><X size={12} aria-hidden="true" />{t("devices.cancelOperation")}</button>
        <button type="button" className="ui-focus-ring" disabled={Boolean(confirmation.binding.protectedOverride && typedOverride !== confirmation.binding.protectedOverride)} style={actionStyle()} onClick={() => { try { manager.confirm(operation.id, confirmation.id, confirmation.binding, typedOverride); setError(null); } catch (caught) { setError(errorText(caught)); } }}><Check size={12} aria-hidden="true" />{t("devices.confirmOperation")}</button>
      </div>
    </section>
  );
}

function OperationCard({ manager, operation }: { manager: DeviceOperationManager; operation: DeviceOperationSnapshot }): React.ReactElement {
  const { t } = useI18n();
  const [monitorInput, setMonitorInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const progress = terminal(operation.state) ? undefined : operation.progress;
  const percent = progress?.completed !== undefined && progress.total !== undefined ? Math.round((progress.completed / progress.total) * 100) : null;
  const canCancel = !terminal(operation.state) && operation.state !== "cancelling";
  const sendMonitor = async () => {
    try {
      await manager.sendUser(operation.id, monitorInput);
      setMonitorInput("");
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  return (
    <article style={{ display: "flex", flexDirection: "column", gap: 7, padding: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {terminal(operation.state) ? <TerminalSquare size={14} aria-hidden="true" /> : <Loader2 size={14} aria-hidden="true" className="icon-spin" />}
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 11, fontWeight: 700 }}>{operation.request.protocol} · {operation.request.action}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{t(stateKey(operation.state))}</span>
      </div>
      {progress && <div style={{ display: "flex", flexDirection: "column", gap: 3 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: "var(--text-muted)" }}><span>{progress.message || progress.phase}</span>{percent !== null && <span>{percent}%</span>}</div>{percent !== null && <div aria-label={t("devices.operationProgress", { percent })} style={{ height: 4, overflow: "hidden", borderRadius: 99, background: "var(--border)" }}><div style={{ width: `${percent}%`, height: "100%", background: "var(--accent)" }} /></div>}</div>}
      {operation.confirmation && <ConfirmationCard manager={manager} operation={operation} />}
      {operation.error && <div role="alert" style={{ fontSize: 11, color: "var(--status-error)", overflowWrap: "anywhere" }}>{operation.error}</div>}
      {operation.result && <section aria-label={t("devices.operationResult")} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 7, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}><strong style={{ fontSize: 11 }}>{operation.result.summary}</strong><div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 10, color: "var(--text-muted)" }}>{operation.result.verified !== undefined && <span>{t("devices.operationVerified")}: {operation.result.verified ? t("devices.yes") : t("devices.no")}</span>}{operation.result.sha256 && <span>{t("devices.operationResultHash")}: {operation.result.sha256}</span>}{operation.result.fileId && <span>{t("devices.operationResultFile")}: {operation.result.fileId}</span>}</div>{operation.result.details && Object.keys(operation.result.details).length > 0 && <pre aria-label={t("devices.operationResultDetails")} style={{ maxHeight: 100, overflow: "auto", margin: 0, padding: 6, borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 10, lineHeight: 1.4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(operation.result.details, null, 2)}</pre>}</section>}
      {error && <div role="alert" style={{ fontSize: 11, color: "var(--status-error)", overflowWrap: "anywhere" }}>{error}</div>}
      {operation.output.length > 0 && <pre aria-label={t("devices.operationOutput")} style={{ maxHeight: 130, overflow: "auto", margin: 0, padding: 6, borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 10, lineHeight: 1.4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{operation.output.map((output) => output.line).join("\n")}</pre>}
      {operation.request.action === "monitor" && operation.state === "running" && <div style={{ display: "flex", gap: 5 }}><label className="sr-only" htmlFor={`monitor-${operation.id}`}>{t("devices.monitorInput")}</label><input id={`monitor-${operation.id}`} value={monitorInput} onChange={(event) => setMonitorInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && monitorInput) void sendMonitor(); }} placeholder={t("devices.monitorInput")} style={{ minWidth: 0, flex: 1, height: 24, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }} /><button type="button" className="ui-focus-ring" disabled={!monitorInput} onClick={() => void sendMonitor()} style={{ ...actionStyle(), opacity: monitorInput ? 1 : 0.6, cursor: monitorInput ? "pointer" : "default" }}><Send size={12} aria-hidden="true" />{t("devices.sendMonitor")}</button></div>}
      {canCancel && <div style={{ display: "flex", justifyContent: "flex-end" }}><button type="button" className="ui-focus-ring" onClick={() => { try { manager.cancel(operation.id); } catch (caught) { setError(errorText(caught)); } }} style={actionStyle("danger")}><Ban size={12} aria-hidden="true" />{t("devices.cancelOperation")}</button></div>}
    </article>
  );
}

/** Real-time operation stream. The manager retains the authoritative bounded
 * transcript; this panel only subscribes and offers visible user actions. */
export function OperationPanel({ sessionId, manager, devices, selectedInputId }: OperationPanelProps): React.ReactElement {
  const { t } = useI18n();
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

  return (
    <section aria-label={t("devices.operations")} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)" }}><ChevronDown size={12} aria-hidden="true" />{t("devices.operations")}</div>
      {!manager ? <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("devices.operationsUnavailable")}</div> : <>
        <OperationStartForm manager={manager} sessionId={sessionId} devices={devices} selectedInputId={selectedInputId} />
        {operations.length === 0 ? <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("devices.operationsEmpty")}</div> : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{operations.map((operation) => <OperationCard key={operation.id} manager={manager} operation={operation} />)}</div>}
      </>}
    </section>
  );
}
