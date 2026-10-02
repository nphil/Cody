"use client";

import { ArrowDown, ArrowUp, Bluetooth, Cable, TriangleAlert, Unplug, Usb } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useDeviceBridge } from "@/hooks/useDeviceBridge";
import { formatBytes } from "@/lib/format-bytes";
import type { DeviceActivity, DeviceCapabilities, DeviceInfo, DeviceKind, DeviceOpName } from "@/lib/devices/protocol";
import { ArtifactPanel } from "@/components/devices/ArtifactPanel";
import { OperationPanel } from "@/components/devices/OperationPanel";
import { DeviceTerminals } from "@/components/devices/DeviceTerminals";

export interface DevicePanelProps {
  sessionId: string | null;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function toolbarButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
    height: 22,
    padding: "0 7px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg-panel)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
    opacity: disabled ? 0.6 : 1,
    transition: "background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
  };
}

function hoverIn(event: React.MouseEvent<HTMLButtonElement>) {
  if (event.currentTarget.disabled) return;
  event.currentTarget.style.background = "var(--bg-selected)";
}

function hoverOut(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = "var(--bg-panel)";
}

const sectionHeadingStyle: React.CSSProperties = {
  marginBottom: 4,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

/** Every reason named here is real: each checks exactly the capability flag
 * that would let the button work, so a disabled row never hides behind a
 * generic "not supported" — see lib/devices/protocol.ts's own table of
 * which browser/platform combination has which API. */
function serialDisabledReason(capabilities: DeviceCapabilities, t: Translate): string | null {
  if (!capabilities.secureContext) return t("devices.reasonInsecureContext");
  if (capabilities.serial || capabilities.serialViaUsb) return null;
  return t("devices.reasonNoSerial");
}

function usbDisabledReason(capabilities: DeviceCapabilities, t: Translate): string | null {
  if (!capabilities.secureContext) return t("devices.reasonInsecureContext");
  if (capabilities.usb) return null;
  return t("devices.reasonNoUsb");
}

function bluetoothDisabledReason(capabilities: DeviceCapabilities, t: Translate): string | null {
  if (!capabilities.secureContext) return t("devices.reasonInsecureContext");
  if (capabilities.bluetooth) return null;
  return t("devices.reasonNoBluetooth");
}

function ConnectRow({ icon, label, buttonLabel, disabledReason, onClick }: {
  icon: React.ReactNode;
  label: string;
  buttonLabel: string;
  disabledReason: string | null;
  onClick: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "flex", color: "var(--text-muted)", flexShrink: 0 }} aria-hidden="true">{icon}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)" }}>{label}</span>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={onClick}
          disabled={disabledReason !== null}
          title={disabledReason ?? buttonLabel}
          aria-label={disabledReason ?? buttonLabel}
          style={toolbarButtonStyle(disabledReason !== null)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {buttonLabel}
        </button>
      </div>
      {disabledReason !== null && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, paddingLeft: 22, fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)" }}>
          <TriangleAlert size={11} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <span style={{ minWidth: 0 }}>{disabledReason}</span>
        </div>
      )}
    </div>
  );
}

function kindIcon(kind: DeviceKind): React.ReactNode {
  if (kind === "serial") return <Cable size={14} aria-hidden="true" />;
  if (kind === "usb") return <Usb size={14} aria-hidden="true" />;
  return <Bluetooth size={14} aria-hidden="true" />;
}

function kindLabel(kind: DeviceKind, t: Translate): string {
  if (kind === "serial") return t("devices.kindSerial");
  if (kind === "usb") return t("devices.kindUsb");
  return t("devices.kindBluetooth");
}

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
    case "ble.trace": return "Bluetooth trace";
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

function DeviceActivityLine({ activity, t }: { activity: DeviceActivity; t: Translate }) {
  const hasRates = activity.rateIn > 0 || activity.rateOut > 0;
  const active = activity.inFlight !== null || hasRates;
  const seconds = useElapsedSeconds(activity.inFlight?.startedAt ?? activity.lastActivityAt, activity.inFlight !== null || !active);

  if (!hasActivity(activity)) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4, fontSize: 11, lineHeight: 1.35, color: "var(--text-muted)" }}>
      {active ? (
        <>
          {activity.inFlight && <span>{t("devices.inFlight", { operation: activityOperationLabel(activity.inFlight.op, t), seconds })}</span>}
          {hasRates && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><ArrowUp size={11} aria-hidden="true" />{t("devices.rateOut", { bytes: formatBytes(activity.rateOut) })}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><ArrowDown size={11} aria-hidden="true" />{t("devices.rateIn", { bytes: formatBytes(activity.rateIn) })}</span>
            </div>
          )}
        </>
      ) : (
        <span>{t("devices.activityTotals", { sent: formatBytes(activity.bytesOut), received: formatBytes(activity.bytesIn), seconds })}</span>
      )}
      {(activity.buffered > 0 || activity.dropped > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {activity.buffered > 0 && <span>{t("devices.buffered", { bytes: formatBytes(activity.buffered) })}</span>}
          {activity.dropped > 0 && <span style={{ color: "var(--status-error)" }}>{t("devices.dropped", { bytes: formatBytes(activity.dropped) })}</span>}
        </div>
      )}
      {activity.lastError && <span style={{ color: "var(--status-error)", overflowWrap: "anywhere" }}>{t("devices.lastError", { detail: activity.lastError })}</span>}
    </div>
  );
}

function DeviceRow({ device, activity, t, onDisconnect }: { device: DeviceInfo; activity: DeviceActivity | undefined; t: Translate; onDisconnect: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ display: "flex", flexShrink: 0, marginTop: 2, color: device.open ? "var(--status-success)" : "var(--text-dim)" }} aria-hidden="true">
        {kindIcon(device.kind)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{device.label}</div>
        <div style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
          <span>{kindLabel(device.kind, t)}</span>
          <span aria-hidden="true">·</span>
          <span>{device.open ? t("devices.statusOpen") : t("devices.statusClosed")}</span>
        </div>
        {activity && <DeviceActivityLine activity={activity} t={t} />}
      </div>
      <button
        type="button"
        className="ui-focus-ring"
        onClick={onDisconnect}
        title={t("devices.disconnectLabel", { label: device.label })}
        aria-label={t("devices.disconnectLabel", { label: device.label })}
        style={toolbarButtonStyle(false)}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
      >
        <Unplug size={12} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The "Devices" right-panel tool: lets the user grant this browser's Web
 * Serial/WebUSB/Web Bluetooth hardware to the agent (device_list, device_open,
 * device_write, device_read, device_close, ble_gatt). Always mounted once a
 * session exists (see AppShell) so a device granted earlier stays attached
 * — and usable by the agent — even while the user is looking at a different
 * tab; there is no "pause" state tied to this panel's own visibility. */
export function DevicePanel({ sessionId }: DevicePanelProps): React.ReactElement {
  const { t } = useI18n();
  const { capabilities, devices, activity, attached, error, connect, disconnect, operationManager } = useDeviceBridge(sessionId);
  const [selectedInputId, setSelectedInputId] = useState<string | null>(null);
  const [bleOptionalServices, setBleOptionalServices] = useState("");

  useEffect(() => setSelectedInputId(null), [sessionId]);
  return (
    <section
      aria-label={t("devices.title")}
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
        {error && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              padding: "6px 8px",
              border: "1px solid color-mix(in srgb, var(--status-error) 55%, var(--border))",
              borderRadius: "var(--radius-control)",
              background: "var(--bg-panel)",
              fontSize: 11,
              lineHeight: 1.4,
              color: "var(--status-error)",
              overflowWrap: "anywhere",
            }}
          >
            <TriangleAlert size={12} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <span style={{ minWidth: 0 }}>{error}</span>
          </div>
        )}

        {!sessionId ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
            {t("devices.noSession")}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
              <span
                aria-hidden="true"
                style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: attached ? "var(--status-success)" : "var(--text-dim)" }}
              />
              {attached ? t("devices.bridgeConnected") : t("devices.bridgeReconnecting")}
            </div>

            <div>
              <div style={sectionHeadingStyle}>{t("devices.title")}</div>
              <ConnectRow
                icon={<Cable size={14} aria-hidden="true" />}
                label={t("devices.kindSerial")}
                buttonLabel={t("devices.connectSerial")}
                disabledReason={serialDisabledReason(capabilities, t)}
                onClick={() => void connect("serial")}
              />
              <ConnectRow
                icon={<Usb size={14} aria-hidden="true" />}
                label={t("devices.kindUsb")}
                buttonLabel={t("devices.connectUsb")}
                disabledReason={usbDisabledReason(capabilities, t)}
                onClick={() => void connect("usb")}
              />
              <div style={{ display: "grid", gap: 6, paddingTop: 8 }}>
                <label htmlFor="ble-optional-services" style={{ fontSize: 11, color: "var(--text-muted)" }}>Additional GATT service UUIDs (comma or space separated)</label>
                <input
                  id="ble-optional-services"
                  className="ui-focus-ring"
                  value={bleOptionalServices}
                  onChange={(event) => setBleOptionalServices(event.target.value)}
                  placeholder="e.g. 18f0, fff0, ffe0"
                  style={{ width: "100%", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", padding: "6px 8px", font: "11px var(--font-mono)" }}
                />
                <div style={{ fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)" }}>
                  Web Bluetooth has no wildcard or unrestricted scan. These services are requested with the browser picker; changing them requires reselecting the device. Baseline access keeps common standard, Nordic UART, 18F0, FFF0 and FFE0 hints.
                </div>
                <ConnectRow
                  icon={<Bluetooth size={14} aria-hidden="true" />}
                  label={t("devices.kindBluetooth")}
                  buttonLabel={t("devices.connectBluetooth")}
                  disabledReason={bluetoothDisabledReason(capabilities, t)}
                  onClick={() => void connect("ble", bleOptionalServices.split(/[\s,]+/).filter(Boolean))}
                />
              </div>
              <div aria-label="Bluetooth capability matrix" style={{ display: "grid", gap: 3, paddingTop: 8, fontSize: 11, color: "var(--text-dim)" }}>
                {([
                  ["Browser GATT", capabilities.bluetoothGatt, capabilities.bluetoothReasons?.bluetoothGatt],
                  ["Advertisement watching", capabilities.bluetoothAdvertisements, capabilities.bluetoothReasons?.bluetoothAdvertisements],
                  ["Native BLE companion", capabilities.nativeBluetooth, capabilities.bluetoothReasons?.nativeBluetooth],
                  ["Bluetooth Classic", capabilities.classicBluetooth, capabilities.bluetoothReasons?.classicBluetooth],
                  ["Local HCI", capabilities.localHci, capabilities.bluetoothReasons?.localHci],
                  ["OTA sniffer", capabilities.bluetoothOta, capabilities.bluetoothReasons?.bluetoothOta],
                ] as const).map(([name, available, reason]) => (
                  <div key={name}><strong style={{ color: available ? "var(--status-success)" : "var(--text-muted)" }}>{name}: {available ? "available" : "unavailable"}</strong>{!available && reason ? " — " + reason : ""}</div>
                ))}
              </div>
            </div>

            {devices.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("devices.empty")}</div>
            ) : (
              <div>
                {devices.map((device) => (
                  <DeviceRow key={device.id} device={device} activity={activity[device.id]} t={t} onDisconnect={() => void disconnect(device.id)} />
                ))}
                <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)" }}>{t("devices.agentHint")}</div>
              </div>
            )}

            <DeviceTerminals manager={operationManager} devices={devices} />
            <ArtifactPanel sessionId={sessionId} selectedInputId={selectedInputId} onSelectInput={setSelectedInputId} />
            <OperationPanel sessionId={sessionId} manager={operationManager} devices={devices} selectedInputId={selectedInputId} />
          </>
        )}
      </div>
    </section>
  );
}
