"use client";

import { Cable } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { useDeviceBridge, type UseDeviceBridgeResult } from "@/hooks/useDeviceBridge";
import { activityView, groupActivity, planBefore, quietUntil } from "@/lib/devices/activity-groups";
import { jobArtifactIds, SERIES_LINGER_MS, type Job } from "@/lib/devices/jobs";
import type { DeviceOperationSnapshot } from "@/lib/devices/operations";
import type { ActivityContext, DetailSubject, JobFiles } from "@/components/devices/activity-context";
import { History, LiveJobs, NeedsYou } from "@/components/devices/ActivityFeed";
import { ArtifactPanel, type RevealRequest } from "@/components/devices/ArtifactPanel";
import { ConnectCard } from "@/components/devices/ConnectCard";
import { DetailSheet } from "@/components/devices/DetailSheet";
import { DeviceCard } from "@/components/devices/DeviceCard";
import { useAcknowledged, useNow } from "@/components/devices/hooks";
import { isTerminalState, useOperations } from "@/components/devices/OperationList";
import { Notice, sectionHeadingStyle } from "@/components/devices/ui";
import { useArtifacts } from "@/components/devices/useArtifacts";

export interface DevicePanelProps {
  sessionId: string | null;
}

/** The title bar, the one scrolling column, and, over it, the detail sheet when one is open (the column is inert behind it). */
function PanelShell({ children, sheet }: { children: ReactNode; sheet: ReactNode }): React.ReactElement {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("devices.title")}
      className="device-panel"
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg)" }}
    >
      <div
        className="workspace-subtitle-bar"
        style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("devices.title")}
        </span>
      </div>
      <div id="device-panel-scroll" className="dv-scroll" inert={sheet !== null} style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, padding: 12 }}>
        {children}
      </div>
      {sheet}
    </section>
  );
}

export type DevicePanelViewProps = Pick<UseDeviceBridgeResult, "capabilities" | "devices" | "activity" | "attached" | "error" | "connect" | "disconnect" | "operationManager"> & { sessionId: string };

/**
 * Everything the panel shows for a session that exists, from what the bridge reports. It reads top to bottom by how much
 * it needs the person: what waits for an answer (pinned), what is running, then the way to connect, the devices and
 * their actions, what already happened by day, and the files it made.
 */
export function DevicePanelView({ sessionId, capabilities, devices, activity, attached, error, connect, disconnect, operationManager }: DevicePanelViewProps): React.ReactElement {
  const { t, locale } = useI18n();
  const operations = useOperations(operationManager);
  const library = useArtifacts(sessionId);
  const { acknowledged, acknowledge } = useAcknowledged(sessionId);
  const [selectedInputId, setSelectedInputId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailSubject | null>(null);
  const [reveal, setReveal] = useState<RevealRequest | undefined>(undefined);

  useEffect(() => {
    setSelectedInputId(null);
    setDetail(null);
  }, [sessionId]);

  const input = selectedInputId ? library.artifacts.find((artifact) => artifact.id === selectedInputId) : undefined;
  const byDevice = useMemo(() => {
    const grouped = new Map<string, DeviceOperationSnapshot[]>();
    for (const operation of operations) grouped.set(operation.request.deviceId, [...(grouped.get(operation.request.deviceId) ?? []), operation]);
    return grouped;
  }, [operations]);

  // A user terminal shows its own output on the device's Terminal tab; listing it here would repeat every line.
  const activityOperations = useMemo(() => operations.filter((operation) => !(operation.origin === "user" && operation.request.action === "monitor")), [operations]);
  const lastTouched = operations.reduce((latest, operation) => Math.max(latest, operation.updatedAt), 0);
  const wakeAt = activityOperations.flatMap((operation) => { const at = quietUntil(operation); return at === undefined ? [] : [at]; });
  // Tick while anything runs, and a little past the last change, so a series between two steps still reads as running.
  const now = useNow({ active: operations.some((operation) => !isTerminalState(operation.state)), until: lastTouched + SERIES_LINGER_MS + 2_000, wakeAt });

  const entriesByDevice = useMemo(() => {
    const grouped = new Map<string, DeviceOperationSnapshot[]>();
    for (const operation of activityOperations) grouped.set(operation.request.deviceId, [...(grouped.get(operation.request.deviceId) ?? []), operation]);
    return [...grouped].map(([deviceId, deviceOperations]) => ({ deviceId, entries: groupActivity(deviceOperations, { now }) }));
  }, [activityOperations, now]);
  const view = useMemo(() => activityView(entriesByDevice, { now, acknowledged, transfers: library.transfers }), [entriesByDevice, now, acknowledged, library.transfers]);
  const jobs = useMemo(() => {
    const byId = new Map<string, Job>();
    for (const { entries } of entriesByDevice) for (const entry of entries) if (entry.kind === "job") byId.set(entry.id, entry);
    return byId;
  }, [entriesByDevice]);

  const labels = useMemo(() => {
    const names = new Map(devices.map((device) => [device.id, device.label]));
    for (const artifact of library.artifacts) {
      const origin = artifact.provenance;
      if (origin?.label && !names.has(origin.deviceId)) names.set(origin.deviceId, origin.label);
    }
    return names;
  }, [devices, library.artifacts]);
  const deviceLabel = (deviceId: string): string => labels.get(deviceId) ?? t("devices.unknownDevice");

  const artifactsById = useMemo(() => new Map(library.artifacts.map((artifact) => [artifact.id, artifact])), [library.artifacts]);
  const verified = useMemo(() => new Map(operations.flatMap((operation) => (operation.result?.verified === undefined ? [] : [[operation.id, operation.result.verified] as const]))), [operations]);
  const setOf = (artifactId: string): string | undefined => library.sets.find((set) => set.artifactIds.includes(artifactId))?.id;
  const filesOf = (job: Job): JobFiles | undefined => {
    const ids = jobArtifactIds(job, library.artifacts);
    const setId = ids[0] === undefined ? undefined : setOf(ids[0]);
    return setId === undefined ? undefined : { setId, count: ids.length, bytes: ids.reduce((sum, id) => sum + (artifactsById.get(id)?.size ?? 0), 0) };
  };
  const busySetIds = new Set(view.live.flatMap((job) => jobArtifactIds(job, library.artifacts).flatMap((id) => setOf(id) ?? [])));

  const ctx: ActivityContext = {
    manager: operationManager,
    now,
    locale,
    showDevice: devices.length > 1 || entriesByDevice.length > 1,
    deviceLabel,
    connected: (deviceId) => devices.some((device) => device.id === deviceId),
    planFor: (job) => planBefore(activityOperations, job),
    filesOf,
    openDetails: setDetail,
    showFiles: (setId) => {
      setDetail(null);
      setReveal({ setId, token: Date.now() });
    },
    acknowledge,
  };

  const chooseFile = (): void => {
    const target = document.getElementById("device-files-choose");
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  };

  return (
    <PanelShell
      sheet={detail ? (
        <DetailSheet subject={detail} jobs={jobs} operations={operations} artifacts={library.artifacts} ctx={ctx} onSubject={setDetail} onClose={() => setDetail(null)} />
      ) : null}
    >
      {error && <Notice tone="error" role="alert">{error}</Notice>}

      <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: attached ? "var(--status-success)" : "var(--text-dim)" }} />
        {attached ? t("devices.bridgeConnected") : t("devices.bridgeReconnecting")}
      </div>

      <NeedsYou items={view.needsYou} ctx={ctx} />
      <LiveJobs jobs={view.live} ctx={ctx} />

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

      <History groups={view.history} ctx={ctx} />

      <ArtifactPanel
        sessionId={sessionId}
        library={library}
        selectedInputId={selectedInputId}
        onSelectInput={setSelectedInputId}
        deviceLabel={deviceLabel}
        verifiedBy={(operationId) => verified.get(operationId)}
        busySetIds={busySetIds}
        onDetails={(artifactId) => setDetail({ kind: "file", artifactId })}
        reveal={reveal}
        acknowledged={acknowledged}
        acknowledge={acknowledge}
      />
    </PanelShell>
  );
}

/** The "Devices" right-panel tool: lets the user grant this browser's Web
 * Serial/WebUSB/Web Bluetooth hardware to the agent (device_list, device_open,
 * device_write, device_read, device_close, ble_gatt) and drive it by hand.
 *
 * Always mounted once a session exists (see AppShell) so a device granted
 * earlier stays attached — and usable by the agent — even while the user is
 * looking at a different tab; there is no "pause" state tied to this panel's
 * own visibility. */
export function DevicePanel({ sessionId }: DevicePanelProps): React.ReactElement {
  const { t } = useI18n();
  const bridge = useDeviceBridge(sessionId);
  if (!sessionId) {
    return (
      <PanelShell sheet={null}>
        {bridge.error && <Notice tone="error" role="alert">{bridge.error}</Notice>}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13, textAlign: "center" }}>
          {t("devices.noSession")}
        </div>
      </PanelShell>
    );
  }
  return <DevicePanelView sessionId={sessionId} {...bridge} />;
}
