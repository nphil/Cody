"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";

export interface DeviceTerminalProps {
  manager: DeviceOperationManager;
  deviceId: string;
  label: string;
  interfaceNumber?: number;
  alternateSetting?: number;
}
const control: React.CSSProperties = { minHeight: 48, padding: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)" };

/** A user-owned terminal. Agent access is a separate grant, never a Start side effect. */
export function DeviceTerminal({ manager, deviceId, label, interfaceNumber, alternateSetting }: DeviceTerminalProps) {
  const { t } = useI18n();
  const [operation, setOperation] = useState<DeviceOperationSnapshot>();
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  useEffect(() => manager.subscribe((snapshot) => {
    if (snapshot.id === operation?.id) setOperation(snapshot);
  }), [manager, operation?.id]);
  const active = operation && !["succeeded", "failed", "cancelled"].includes(operation.state);
  const ready = operation?.progress?.phase === "monitoring" && operation.state === "running";
  const start = () => {
    try {
      const result = manager.startUser({ deviceId, protocol: "adb", action: "monitor", interfaceNumber, alternateSetting });
      setOperation(manager.status(result.id));
      setError("");
    } catch (caught) { setError(String(caught)); }
  };
  const send = async (text: string) => {
    try {
      await manager.sendUser(operation!.id, text);
      setInput("");
      setError("");
    } catch (caught) { setError(String(caught)); }
  };
  return <section aria-label={t("devices.adbTerminal", { device: label })} style={{ display: "grid", minWidth: 0, gap: 8 }}>
    <strong>{t("devices.adbTerminal", { device: label })}</strong>
    <button className="ui-focus-ring" type="button" style={control} onClick={() => active ? manager.cancel(operation.id) : start()}>{t(active ? "devices.terminalStop" : "devices.terminalStart")}</button>
    {operation && <>
      <pre aria-label={t("devices.operationOutput")} tabIndex={0} style={{ margin: 0, maxHeight: 240, minHeight: 80, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 8, background: "var(--bg)", color: "var(--text)", fontSize: 13 }}>{operation.output.map((item) => item.line).join("\n")}</pre>
      <form onSubmit={(event) => { event.preventDefault(); if (ready) void send(input + "\n"); }} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <label style={{ flex: "1 1 160px", minWidth: 0 }}>{t("devices.terminalInput")}<input aria-label={t("devices.terminalInput")} value={input} onChange={(event) => setInput(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ ...control, width: "100%", fontSize: 16 }} /></label>
        <button className="ui-focus-ring" type="submit" disabled={!ready} style={control}>{t("devices.terminalSend")}</button>
        <button className="ui-focus-ring" type="button" disabled={!ready} style={control} onClick={() => void send("\x03")}>Ctrl+C</button>
      </form>
      <span role="status">{operation.error || operation.result?.summary || operation.progress?.message}</span>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
