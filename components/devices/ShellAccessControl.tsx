"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager } from "@/lib/devices/operations";
import { Button, Notice } from "./ui";

export function ShellAccessControl({ manager, deviceId, label }: { manager: DeviceOperationManager; deviceId: string; label: string }) {
  const { t } = useI18n();
  const [allowed, setAllowed] = useState(() => manager.hasShellAccess(deviceId));
  useEffect(() => {
    const sync = () => setAllowed(manager.hasShellAccess(deviceId));
    sync();
    return manager.subscribeShellAccess(sync);
  }, [manager, deviceId]);
  return <div style={{ display: "grid", gap: 8 }}>
    <Button tone={allowed ? "warning" : "normal"} pressed={allowed} full onClick={() => manager.setShellAccess(deviceId, !allowed)}>
      {t(allowed ? "devices.shellRevoke" : "devices.shellAllow", { device: label })}
    </Button>
    <Notice tone={allowed ? "warning" : "info"} role="status">{t(allowed ? "devices.shellGranted" : "devices.shellRestricted")}</Notice>
  </div>;
}
