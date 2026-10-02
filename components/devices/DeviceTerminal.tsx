"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";
import type { SerialSignals } from "@/lib/devices/serial-monitor";
import { HardwareTerminalView } from "./HardwareTerminalView";

export interface DeviceTerminalProps {
  manager: DeviceOperationManager;
  deviceId: string;
  label: string;
  protocol?: "adb" | "serial";
  interfaceNumber?: number;
  alternateSetting?: number;
}
const control: React.CSSProperties = { minHeight: 48, padding: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)" };
const endings = { LF: "\n", CR: "\r", CRLF: "\r\n", None: "" };

/** User terminal ownership never implicitly grants the agent ADB shell authority. */
export function DeviceTerminal({ manager, deviceId, label, protocol = "adb", interfaceNumber, alternateSetting }: DeviceTerminalProps) {
  const { t } = useI18n();
  const [operation, setOperation] = useState<DeviceOperationSnapshot>();
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [baudRate, setBaudRate] = useState("115200");
  const [ending, setEnding] = useState<keyof typeof endings>("LF");
  const [signals, setSignals] = useState<SerialSignals>({ dtr: true, rts: false, brk: false });
  useEffect(() => manager.subscribe(snapshot => {
    if (snapshot.id === operation?.id) setOperation(snapshot);
  }), [manager, operation?.id]);
  const active = operation && !["succeeded", "failed", "cancelled"].includes(operation.state);
  const ready = operation?.progress?.phase === "monitoring" && operation.state === "running";
  const title = t(protocol === "adb" ? "devices.adbTerminal" : "devices.serialTerminal", { device: label });
  const start = () => {
    try {
      const result = manager.startUser({ deviceId, protocol, action: "monitor", interfaceNumber, alternateSetting,
        ...(protocol === "serial" ? { baudRate: Number(baudRate), options: { signals } } : {}) });
      setOperation(manager.status(result.id));
      setError("");
    } catch (caught) { setError(String(caught)); }
  };
  const send = async (text: string) => {
    try { await manager.sendUser(operation!.id, text); setInput(""); setError(""); }
    catch (caught) { setError(String(caught)); }
  };
  const setSignal = async (key: keyof SerialSignals, value: boolean) => {
    try {
      if (active) await manager.setSignalsUser(operation.id, { [key]: value });
      setSignals(current => ({ ...current, [key]: value }));
      setError("");
    } catch (caught) { setError(String(caught)); }
  };
  return <section aria-label={title} style={{ display: "grid", minWidth: 0, gap: 8 }}>
    <strong>{title}</strong>
    {protocol === "serial" && <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <label>{t("devices.operationBaudRate")}<input type="number" min="1" value={baudRate} disabled={!!active} onChange={event => setBaudRate(event.target.value)} style={{ ...control, display: "block", width: 140, fontSize: 16 }} /></label>
      {(["dtr", "rts", "brk"] as const).map(key => <label key={key} style={{ ...control, display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={!!signals[key]} disabled={!!active && !ready} onChange={event => void setSignal(key, event.target.checked)} />{key === "brk" ? "Break" : key.toUpperCase()}</label>)}
    </div>}
    <button className="ui-focus-ring" type="button" style={control} onClick={() => active ? manager.cancel(operation.id) : start()}>{t(active ? "devices.terminalStop" : "devices.terminalStart")}</button>
    {operation && <>
      <HardwareTerminalView manager={manager} operationId={operation.id} label={t("devices.operationOutput")} onError={setError} />
      <form onSubmit={event => { event.preventDefault(); if (ready && (input || endings[ending])) void send(input + endings[ending]); }} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <label style={{ flex: "1 1 160px", minWidth: 0 }}>{t("devices.terminalInput")}<input value={input} onChange={event => setInput(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ ...control, width: "100%", fontSize: 16 }} /></label>
        <label>{t("devices.terminalEnding")}<select value={ending} onChange={event => setEnding(event.target.value as keyof typeof endings)} style={{ ...control, display: "block" }}>{Object.keys(endings).map(key => <option key={key}>{key}</option>)}</select></label>
        <button className="ui-focus-ring" type="submit" disabled={!ready} style={control}>{t("devices.terminalSend")}</button>
      </form>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{[["Ctrl+C", "\x03"], ["Esc", "\x1b"], ["Tab", "\t"], ["↑", "\x1b[A"], ["↓", "\x1b[B"]].map(([key, data]) => <button key={key} className="ui-focus-ring" type="button" disabled={!ready} style={control} onClick={() => void send(data)}>{key}</button>)}</div>
      <span role="status">{operation.state === "cancelled" ? t("devices.operationStateCancelled") : operation.error || operation.result?.summary || operation.progress?.message}</span>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
