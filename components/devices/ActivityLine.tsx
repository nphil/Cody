"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import type { DeviceActivity, DeviceOpName } from "@/lib/devices/protocol";
import { useI18n } from "@/lib/i18n";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function activityOperationLabel(op: DeviceOpName, t: Translate): string {
  switch (op) {
    case "serial.open": return t("devices.operationSerialOpen");
    case "serial.write": return t("devices.operationSerialWrite");
    case "serial.baud": return t("devices.operationSerialBaud");
    case "serial.signals": return t("devices.operationSerialSignals");
    case "close": return t("devices.operationClose");
    case "ble.connect": return t("devices.operationBleConnect");
    case "ble.services":
    case "ble.gatt": return t("devices.operationBleServices");
    case "ble.trace": return t("devices.operationBleTrace");
    case "ble.read": return t("devices.operationBleRead");
    case "ble.write": return t("devices.operationBleWrite");
    case "ble.subscribe": return t("devices.operationBleSubscribe");
    case "usb.open": return t("devices.operationUsbOpen");
    case "usb.control": return t("devices.operationUsbControl");
    case "usb.transfer": return t("devices.operationUsbTransfer");
  }
}

function hasActivity(activity: DeviceActivity): boolean {
  return activity.bytesIn > 0 || activity.bytesOut > 0 || activity.ops > 0 || activity.inFlight !== null
    || activity.lastActivityAt !== null || activity.buffered > 0 || activity.dropped > 0 || activity.lastError !== null;
}

function useElapsedSeconds(timestamp: number | null, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking || timestamp === null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [timestamp, ticking]);

  return timestamp === null ? 0 : Math.max(0, Math.floor((now - timestamp) / 1_000));
}

/** Live traffic for one device: what is in flight, bytes per second, and the last failure. */
export function ActivityLine({ activity }: { activity: DeviceActivity }) {
  const { t } = useI18n();
  const hasRates = activity.rateIn > 0 || activity.rateOut > 0;
  const active = activity.inFlight !== null || hasRates;
  const seconds = useElapsedSeconds(activity.inFlight?.startedAt ?? activity.lastActivityAt, activity.inFlight !== null || !active);

  if (!hasActivity(activity)) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, lineHeight: 1.4, color: "var(--text-muted)" }}>
      {active ? (
        <>
          {activity.inFlight && <span>{t("devices.inFlight", { operation: activityOperationLabel(activity.inFlight.op, t), seconds })}</span>}
          {hasRates && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><ArrowUp size={12} aria-hidden="true" />{t("devices.rateOut", { bytes: formatBytes(activity.rateOut) })}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><ArrowDown size={12} aria-hidden="true" />{t("devices.rateIn", { bytes: formatBytes(activity.rateIn) })}</span>
            </div>
          )}
        </>
      ) : (
        <span>{t("devices.activityTotals", { sent: formatBytes(activity.bytesOut), received: formatBytes(activity.bytesIn), seconds })}</span>
      )}
      {(activity.buffered > 0 || activity.dropped > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {activity.buffered > 0 && <span>{t("devices.buffered", { bytes: formatBytes(activity.buffered) })}</span>}
          {activity.dropped > 0 && <span style={{ color: "var(--status-error)" }}>{t("devices.dropped", { bytes: formatBytes(activity.dropped) })}</span>}
        </div>
      )}
      {activity.lastError && <span style={{ color: "var(--status-error)", overflowWrap: "anywhere" }}>{t("devices.lastError", { detail: activity.lastError })}</span>}
    </div>
  );
}
