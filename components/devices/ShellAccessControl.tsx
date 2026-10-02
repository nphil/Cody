"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager } from "@/lib/devices/operations";

export function ShellAccessControl({ manager, deviceId, label }: { manager: DeviceOperationManager; deviceId: string; label: string }) {
  const { t } = useI18n();
  const [allowed, setAllowed] = useState(() => manager.hasShellAccess(deviceId));
  useEffect(() => {
    const sync = () => setAllowed(manager.hasShellAccess(deviceId));
    sync();
    return manager.subscribeShellAccess(sync);
  }, [manager, deviceId]);
  return <div style={{ display: "grid", gap: 8 }}>
    <button type="button" className="ui-focus-ring" onClick={() => manager.setShellAccess(deviceId, !allowed)} style={{ minHeight: 48, padding: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: allowed ? "var(--status-warning)" : "var(--text)", textAlign: "left" }}>
      {t(allowed ? "devices.shellRevoke" : "devices.shellAllow", { device: label })}
    </button>
    <span role="status" style={{ fontSize: 12, color: "var(--text-muted)" }}>{t(allowed ? "devices.shellGranted" : "devices.shellRestricted")}</span>
  </div>;
}
