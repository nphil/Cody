"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";
import type { SerialSignals } from "@/lib/devices/serial-monitor";
import { HardwareTerminalView } from "./HardwareTerminalView";
import { Button, inputStyle, Notice, TOUCH } from "./ui";

export interface DeviceTerminalProps {
  manager: DeviceOperationManager;
  deviceId: string;
  label: string;
  protocol?: "adb" | "serial";
  interfaceNumber?: number;
  alternateSetting?: number;
  /** Shown above the terminal; only needed when one device has several. */
  showTitle?: boolean;
}
const endings = { LF: "\n", CR: "\r", CRLF: "\r\n", None: "" };
const SPECIAL_KEYS: readonly (readonly [string, string])[] = [["Ctrl+C", "\x03"], ["Esc", "\x1b"], ["Tab", "\t"], ["↑", "\x1b[A"], ["↓", "\x1b[B"]];

/** User terminal ownership never implicitly grants the agent ADB shell authority. */
export function DeviceTerminal({ manager, deviceId, label, protocol = "adb", interfaceNumber, alternateSetting, showTitle = false }: DeviceTerminalProps) {
  const { t } = useI18n();
  const inputId = useId();
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
  return <section aria-label={title} style={{ display: "grid", minWidth: 0, gap: 10 }}>
    {showTitle && <strong style={{ fontSize: 13 }}>{title}</strong>}
    {protocol === "serial" && <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
      <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{t("devices.operationBaudRate")}
        <input type="number" min="1" inputMode="numeric" className="ui-focus-ring" value={baudRate} disabled={!!active} onChange={event => setBaudRate(event.target.value)} style={{ ...inputStyle, width: 140 }} />
      </label>
      {(["dtr", "rts", "brk"] as const).map(key => <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: TOUCH, padding: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", fontSize: 13, cursor: "pointer" }}>
        <input type="checkbox" checked={!!signals[key]} disabled={!!active && !ready} onChange={event => void setSignal(key, event.target.checked)} style={{ width: 20, height: 20 }} />{key === "brk" ? "Break" : key.toUpperCase()}
      </label>)}
    </div>}
    <div>
      <Button tone={active ? "normal" : "primary"} onClick={() => active ? manager.cancel(operation.id) : start()}>{t(active ? "devices.terminalStop" : "devices.terminalStart")}</Button>
    </div>
    {operation && <>
      <HardwareTerminalView manager={manager} operationId={operation.id} label={t("devices.operationOutput")} onError={setError} />
      <form onSubmit={event => { event.preventDefault(); if (ready && (input || endings[ending])) void send(input + endings[ending]); }} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
        <label htmlFor={inputId} style={{ flex: "1 1 160px", minWidth: 0, display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{t("devices.terminalInput")}
          <input id={inputId} className="ui-focus-ring" value={input} onChange={event => setInput(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{t("devices.terminalEnding")}
          <select className="ui-focus-ring" value={ending} onChange={event => setEnding(event.target.value as keyof typeof endings)} style={{ ...inputStyle, width: "auto", background: "var(--bg-panel)" }}>{Object.keys(endings).map(key => <option key={key}>{key}</option>)}</select>
        </label>
        <Button type="submit" tone="primary" disabled={!ready}>{t("devices.terminalSend")}</Button>
      </form>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{SPECIAL_KEYS.map(([key, data]) => <Button key={key} disabled={!ready} onClick={() => void send(data)}>{key}</Button>)}</div>
      <span role="status" style={{ fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{operation.state === "cancelled" ? t("devices.operationStateCancelled") : operation.error || operation.result?.summary || operation.progress?.message}</span>
    </>}
    {error && <Notice tone="error" role="alert">{error}</Notice>}
  </section>;
}
