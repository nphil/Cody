"use client";

import { Bluetooth, Cable, Check, Usb, X } from "lucide-react";
import { useState } from "react";
import type { DeviceCapabilities, DeviceKind } from "@/lib/devices/protocol";
import { useI18n } from "@/lib/i18n";
import { cardStyle, Chip, Disclosure, Notice, sectionHeadingStyle, TextField } from "./ui";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Every reason named here checks exactly the capability flag that would let the button work, so a disabled tile never hides behind a generic "not supported". */
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

function ConnectTile({ icon, label, hint, unavailableLabel, buttonLabel, disabledReason, onClick, compact }: {
  compact: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  /** Short words for the tile when this method cannot work here; the full reason is the accessible name and is listed under the tiles. */
  unavailableLabel: string;
  buttonLabel: string;
  disabledReason: string | null;
  onClick: () => void;
}) {
  const disabled = disabledReason !== null;
  return (
    <button
      type="button"
      className="ui-focus-ring dv-btn dv-tile"
      onClick={onClick}
      disabled={disabled}
      title={disabledReason ?? buttonLabel}
      aria-label={disabledReason ?? buttonLabel}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: compact ? "center" : "flex-start",
        justifyContent: "center",
        gap: compact ? 2 : 6,
        minHeight: compact ? 64 : 84,
        padding: compact ? "6px 8px" : 12,
        textAlign: "left",
        border: `1px solid ${disabled ? "var(--border)" : "color-mix(in srgb, var(--accent) 45%, var(--border))"}`,
        borderRadius: "var(--radius-card)",
        background: "var(--bg-panel)",
        color: disabled ? "var(--text-dim)" : "var(--text)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.65 : 1,
      }}
    >
      <span style={{ display: "inline-flex", flexDirection: compact ? "column" : "row", alignItems: "center", gap: compact ? 2 : 8, fontSize: compact ? 12 : 14, fontWeight: 700, color: disabled ? "var(--text-dim)" : "var(--accent)" }}>
        <span aria-hidden="true" style={{ display: "inline-flex" }}>{icon}</span>
        <span style={{ color: "inherit" }}>{label}</span>
      </span>
      {!compact && <span style={{ fontSize: 12, lineHeight: 1.35, color: "var(--text-muted)" }}>{disabled ? unavailableLabel : hint}</span>}
    </button>
  );
}

function SupportChip({ label, supported }: { label: string; supported: boolean }) {
  return <Chip tone={supported ? "good" : "neutral"} icon={supported ? <Check size={12} strokeWidth={2.6} /> : <X size={12} strokeWidth={2.6} />}>{label}</Chip>;
}

/**
 * Step one: pick or grant a device. USB, serial and Bluetooth are the three
 * ways a browser can be handed hardware, so they are the three tiles; what
 * this browser can actually do is stated right under them.
 */
export function ConnectCard({ capabilities, connect, compact }: { capabilities: DeviceCapabilities; compact: boolean; connect: (kind: DeviceKind, bleOptionalServices?: readonly string[]) => Promise<void> }): React.ReactElement {
  const { t } = useI18n();
  const [bleOptionalServices, setBleOptionalServices] = useState("");
  const usbReason = usbDisabledReason(capabilities, t);
  const serialReason = serialDisabledReason(capabilities, t);
  const bleReason = bluetoothDisabledReason(capabilities, t);
  const reasons = [usbReason, serialReason, bleReason].filter((reason): reason is string => reason !== null);
  const uniqueReasons = [...new Set(reasons)];

  const support = (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label={t("devices.browserSupport")}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)" }}>{t("devices.browserSupport")}</span>
          <SupportChip label={t("devices.kindUsb")} supported={usbReason === null} />
          <SupportChip label={capabilities.serial || !capabilities.serialViaUsb ? t("devices.kindSerial") : t("devices.kindSerialViaUsb")} supported={serialReason === null} />
          <SupportChip label={t("devices.kindBluetooth")} supported={bleReason === null} />
        </div>
        {uniqueReasons.map((reason) => <Notice key={reason} tone="warning">{reason}</Notice>)}
      </div>

      <Disclosure summary={t("devices.bluetoothMore")}>
        <TextField
          label={t("devices.bleServicesLabel")}
          hint={t("devices.bleServicesHint")}
          value={bleOptionalServices}
          onChange={(event) => setBleOptionalServices(event.target.value)}
          placeholder={t("devices.bleServicesPlaceholder")}
          mono
        />
        <div aria-label={t("devices.bluetoothMatrix")} style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-dim)" }}>
          {([
            ["devices.bleBrowserGatt", capabilities.bluetoothGatt, capabilities.bluetoothReasons?.bluetoothGatt],
            ["devices.bleAdvertisements", capabilities.bluetoothAdvertisements, capabilities.bluetoothReasons?.bluetoothAdvertisements],
            ["devices.bleNativeCompanion", capabilities.nativeBluetooth, capabilities.bluetoothReasons?.nativeBluetooth],
            ["devices.bleClassic", capabilities.classicBluetooth, capabilities.bluetoothReasons?.classicBluetooth],
            ["devices.bleLocalHci", capabilities.localHci, capabilities.bluetoothReasons?.localHci],
            ["devices.bleOtaSniffer", capabilities.bluetoothOta, capabilities.bluetoothReasons?.bluetoothOta],
          ] as const).map(([key, available, reason]) => (
            <div key={key}>
              <strong style={{ color: available ? "var(--status-success)" : "var(--text-muted)" }}>{t(key)}: {available ? t("devices.available") : t("devices.unavailable")}</strong>
              {!available && reason ? " — " + reason : ""}
            </div>
          ))}
        </div>
      </Disclosure>
    </>
  );

  return (
    <section aria-label={t("devices.connectTitle")} style={{ ...cardStyle }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h3 style={sectionHeadingStyle}>{t("devices.connectTitle")}</h3>
        {!compact && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.connectIntro")}</p>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(3, minmax(0, 1fr))" : "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: 8 }}>
        <ConnectTile compact={compact} icon={<Usb size={20} />} label={t("devices.kindUsb")} hint={t("devices.connectUsbHint")} unavailableLabel={t("devices.notAvailableHere")} buttonLabel={t("devices.connectUsb")} disabledReason={usbReason} onClick={() => void connect("usb")} />
        <ConnectTile compact={compact} icon={<Cable size={20} />} label={t("devices.kindSerial")} hint={capabilities.serial ? t("devices.connectSerialHint") : t("devices.connectSerialViaUsbHint")} unavailableLabel={t("devices.notAvailableHere")} buttonLabel={t("devices.connectSerial")} disabledReason={serialReason} onClick={() => void connect("serial")} />
        <ConnectTile compact={compact} icon={<Bluetooth size={20} />} label={t("devices.kindBluetooth")} hint={t("devices.connectBluetoothHint")} unavailableLabel={t("devices.notAvailableHere")} buttonLabel={t("devices.connectBluetooth")} disabledReason={bleReason} onClick={() => void connect("ble", bleOptionalServices.split(/[\s,]+/).filter(Boolean))} />
      </div>
      {compact ? <Disclosure summary={t("devices.browserSupportMore")}>{support}</Disclosure> : <>{support}</>}
    </section>
  );
}
