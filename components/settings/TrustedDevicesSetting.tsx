"use client";

/**
 * Settings › Preferences › Trusted devices: the devices this account let the
 * agent control without asking again.
 *
 * The list can only REMOVE trust. A device lands here when the person presses
 * Allow with "Remember this device" on the question in the chat
 * (components/DeviceTrustCard.tsx); nothing on this page can add one, so a
 * stolen Settings tab or a misread button cannot hand the agent a device.
 * Forgetting one takes effect at once: the agent's running operations on it
 * are cancelled and it has to ask again (lib/devices/trust-client.ts).
 */
import { Loader2, ShieldOff } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { useTrustedDevices, type TrustedDevicesSource } from "@/hooks/useTrustedDevices";
import type { TrustedDevice } from "@/lib/devices/trust";
import { NativeSetting } from "./primitives";

const noteStyle: CSSProperties = { fontSize: 11, lineHeight: 1.45 };

export const TRUSTED_DEVICES_EMPTY = "No device is remembered. The agent asks in the chat the first time it wants to control one.";

/** The device's USB vendor id as the person would read it off a device list: four lowercase hex digits. */
function vendorText(vendorId: number): string {
  return `USB ${vendorId.toString(16).padStart(4, "0")}`;
}

function allowedText(grantedAt: number): string {
  return `Allowed ${new Date(grantedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
}

/** Forget one device. Resolves to the reason it failed, or null when it worked. */
export async function forgetDevice(forget: (key: string) => Promise<void>, key: string): Promise<string | null> {
  try {
    await forget(key);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One remembered device: what it is, when it was allowed, and Forget. */
export function DeviceRow({ device, first, busy, error, onForget }: {
  device: TrustedDevice;
  first: boolean;
  busy: boolean;
  error: string | null;
  onForget: (key: string) => void;
}) {
  return (
    <li
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 12px",
        borderTop: first ? "none" : "1px solid var(--border)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
        <div style={{ flex: "1 1 160px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>{device.label}</span>
          <span style={{ ...noteStyle, color: "var(--text-muted)", display: "flex", flexWrap: "wrap", columnGap: 10 }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>{vendorText(device.vendorId)}</span>
            <span style={{ fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{device.serialNumber}</span>
            <span>{allowedText(device.grantedAt)}</span>
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          aria-busy={busy || undefined}
          className="ui-focus-ring"
          aria-label={`Forget ${device.label}`}
          onClick={() => onForget(device.key)}
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            // The Settings shell raises every button to 44px on touch (app/globals.css, `.settings-shell button`).
            minHeight: 32,
            padding: "4px 10px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            background: "var(--bg)",
            color: "var(--text)",
            fontSize: 12,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? <Loader2 size={14} aria-hidden className="icon-spin" /> : <ShieldOff size={14} aria-hidden />}
          Forget
        </button>
      </div>
      {error && (
        <span role="alert" style={{ ...noteStyle, color: "var(--status-error)", overflowWrap: "anywhere" }}>
          Could not forget {device.label}: {error}
        </span>
      )}
    </li>
  );
}

export function TrustedDevicesSetting({ label, description, searchId, source, initiallyLoaded }: {
  label: string;
  description: string;
  searchId: string;
  /** The trust book to read; the page's own when omitted. The seam a test renders through. */
  source?: TrustedDevicesSource;
  /** Paint as if the first read had finished, for a static render that never runs effects. */
  initiallyLoaded?: boolean;
}) {
  const { devices, loadError, loaded, forget } = useTrustedDevices(source, initiallyLoaded);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  const onForget = (key: string) => {
    setBusyKey(key);
    setFailure(null);
    void forgetDevice(forget, key).then((message) => {
      setBusyKey(null);
      if (message !== null) setFailure({ key, message });
    });
  };

  return (
    <NativeSetting
      label={label}
      description={description}
      scope="Cody only"
      searchId={searchId}
      control={(
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          {loadError !== null && (
            <span role="alert" style={{ ...noteStyle, color: "var(--status-error)", overflowWrap: "anywhere" }}>
              Could not read the remembered devices: {loadError}
            </span>
          )}
          {devices.length > 0 ? (
            <ul
              aria-label={label}
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                overflow: "hidden",
                minWidth: 0,
              }}
            >
              {devices.map((device, index) => (
                <DeviceRow
                  key={device.key}
                  device={device}
                  first={index === 0}
                  busy={busyKey === device.key}
                  error={failure?.key === device.key ? failure.message : null}
                  onForget={onForget}
                />
              ))}
            </ul>
          ) : loaded && loadError === null ? (
            <span style={{ ...noteStyle, color: "var(--text-muted)" }}>{TRUSTED_DEVICES_EMPTY}</span>
          ) : loadError === null ? (
            <span role="status" style={{ ...noteStyle, color: "var(--text-muted)" }}>Loading…</span>
          ) : null}
        </div>
      )}
    />
  );
}
