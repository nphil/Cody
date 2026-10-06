"use client";

import { Cable } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useDeviceBridge } from "@/hooks/useDeviceBridge";
import { ActivityFeed } from "@/components/devices/ActivityFeed";
import { ArtifactPanel } from "@/components/devices/ArtifactPanel";
import { ConnectCard } from "@/components/devices/ConnectCard";
import { DeviceCard } from "@/components/devices/DeviceCard";
import { useOperations } from "@/components/devices/OperationList";
import { Disclosure, Notice, sectionHeadingStyle } from "@/components/devices/ui";
import { deviceArtifacts } from "@/lib/devices/artifacts";
import { groupActivity } from "@/lib/devices/activity-groups";

export interface DevicePanelProps {
  sessionId: string | null;
}

/** The "Devices" right-panel tool: lets the user grant this browser's Web
 * Serial/WebUSB/Web Bluetooth hardware to the agent (device_list, device_open,
 * device_write, device_read, device_close, ble_gatt) and drive it by hand.
 *
 * The panel reads top to bottom as the job does: connect something, see the
 * device you connected with its mode, then use the actions that mode has.
 *
 * Always mounted once a session exists (see AppShell) so a device granted
 * earlier stays attached — and usable by the agent — even while the user is
 * looking at a different tab; there is no "pause" state tied to this panel's
 * own visibility. */
export function DevicePanel({ sessionId }: DevicePanelProps): React.ReactElement {
  const { t } = useI18n();
  const { capabilities, devices, activity, attached, error, connect, disconnect, operationManager } = useDeviceBridge(sessionId);
  const [selectedInputId, setSelectedInputId] = useState<string | null>(null);
  const operations = useOperations(operationManager);

  useEffect(() => setSelectedInputId(null), [sessionId]);

  const input = sessionId && selectedInputId ? deviceArtifacts.list(sessionId).find((artifact) => artifact.id === selectedInputId) : undefined;
  const byDevice = useMemo(() => {
    const grouped = new Map<string, typeof operations[number][]>();
    for (const operation of operations) grouped.set(operation.request.deviceId, [...(grouped.get(operation.request.deviceId) ?? []), operation]);
    return grouped;
  }, [operations]);
  const connectedIds = useMemo(() => new Set(devices.map((device) => device.id)), [devices]);
  const orphanedDevices = useMemo(() => [...byDevice].filter(([deviceId]) => !connectedIds.has(deviceId)), [byDevice, connectedIds]);
  const orphanedCount = useMemo(() => orphanedDevices.reduce((total, [, deviceOperations]) => total + deviceOperations.length, 0), [orphanedDevices]);

  const chooseFile = () => {
    const target = document.getElementById("device-files-choose");
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  };

  return (
    <section
      aria-label={t("devices.title")}
      className="device-panel"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg)" }}
    >
      <div
        className="workspace-subtitle-bar"
        style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("devices.title")}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, padding: 12 }}>
        {error && <Notice tone="error" role="alert">{error}</Notice>}

        {!sessionId ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13, textAlign: "center" }}>
            {t("devices.noSession")}
          </div>
        ) : (
          <>
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>
              <span
                aria-hidden="true"
                style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: attached ? "var(--status-success)" : "var(--text-dim)" }}
              />
              {attached ? t("devices.bridgeConnected") : t("devices.bridgeReconnecting")}
            </div>

            <ConnectCard capabilities={capabilities} connect={connect} compact={devices.length > 0} />

            <section aria-label={t("devices.yourDevices")} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <h3 style={sectionHeadingStyle}>{t("devices.yourDevices")}</h3>
              {devices.length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "20px 12px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", textAlign: "center", color: "var(--text-muted)" }}>
                  <Cable size={24} aria-hidden="true" />
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("devices.emptyTitle")}</div>
                  <div style={{ fontSize: 12, lineHeight: 1.45 }}>{t("devices.empty")}</div>
                </div>
              ) : (
                <>
                  {devices.map((device) => (
                    <DeviceCard
                      key={device.id}
                      sessionId={sessionId}
                      manager={operationManager}
                      device={device}
                      activity={activity[device.id]}
                      operations={byDevice.get(device.id) ?? []}
                      selectedInputId={selectedInputId}
                      input={input}
                      onChooseFile={chooseFile}
                      onDisconnect={() => void disconnect(device.id)}
                    />
                  ))}
                  <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-dim)" }}>{t("devices.agentHint")}</div>
                </>
              )}
            </section>

            <ArtifactPanel sessionId={sessionId} selectedInputId={selectedInputId} onSelectInput={setSelectedInputId} />

            {operationManager && orphanedCount > 0 && (
              <Disclosure summary={t("devices.orphanedActivity", { count: orphanedCount })}>
                {orphanedDevices.map(([deviceId, deviceOperations]) => (
                  <ActivityFeed key={deviceId} manager={operationManager} entries={groupActivity(deviceOperations)} />
                ))}
              </Disclosure>
            )}
          </>
        )}
      </div>
    </section>
  );
}
