"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";
import type { DeviceArtifact } from "@/lib/devices/artifacts";
import { Button, Notice, TextField } from "./ui";

export interface FastbootCommandProps {
  manager: DeviceOperationManager;
  deviceId: string;
  label: string;
  interfaceNumber?: number;
  alternateSetting?: number;
  input?: DeviceArtifact;
  /** Shown above the box; only needed when one device has several. */
  showTitle?: boolean;
}

export function FastbootCommand({ manager, deviceId, label, interfaceNumber, alternateSetting, input, showTitle = false }: FastbootCommandProps) {
  const { t } = useI18n();
  const [command, setCommand] = useState("getvar all");
  const [operation, setOperation] = useState<DeviceOperationSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => manager.subscribe(snapshot => { if (snapshot.id === operation?.id) setOperation(snapshot); }), [manager, operation?.id]);
  const active = operation && !["succeeded", "failed", "cancelled"].includes(operation.state);
  const start = () => {
    try {
      const usesImage = /^(?:boot|download|flash)(?:$|[:\s])/.test(command.trim().replace(/^fastboot\s+/, ""));
      const result = manager.startUser({ deviceId, protocol: "fastboot", action: "exec", command, interfaceNumber, alternateSetting,
        ...(input && usesImage ? { fileId: input.id, sha256: input.sha256 } : {}) });
      setOperation(manager.status(result.id));
      setError("");
    } catch (caught) { setError(String(caught)); }
  };
  const title = t("devices.fastbootTerminal", { device: label });
  return <section aria-label={title} style={{ display: "grid", minWidth: 0, gap: 10 }}>
    {showTitle && <strong style={{ fontSize: 13 }}>{title}</strong>}
    <form onSubmit={event => { event.preventDefault(); if (!active) start(); }} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
      <div style={{ flex: "1 1 180px", minWidth: 0 }}>
        <TextField label={t("devices.operationCommand")} value={command} onChange={event => setCommand(event.target.value)} mono />
      </div>
      <Button type="submit" tone="primary" disabled={!!active}>{t("devices.terminalSend")}</Button>
      {active && <Button tone="danger" onClick={() => manager.cancel(operation.id)}>{t("devices.cancelOperation")}</Button>}
    </form>
    {input && <small style={{ overflowWrap: "anywhere", color: "var(--text-muted)" }}>{t("devices.operationSelectedInput")}: {input.name} — SHA-256 {input.sha256}</small>}
    {operation && <pre aria-label={t("devices.operationOutput")} style={{ margin: 0, padding: 8, maxHeight: 240, overflow: "auto", borderRadius: "var(--radius-control)", background: "var(--bg)", fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{operation.output.map(item => item.line).join("\n")}
{operation.error || operation.result?.summary || operation.progress?.message}</pre>}
    {error && <Notice tone="error" role="alert">{error}</Notice>}
  </section>;
}
