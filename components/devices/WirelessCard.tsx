"use client";

import { KeyRound, RefreshCw, Smartphone, Trash2, Unplug, Wifi, WifiOff } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { WirelessController } from "@/hooks/useWirelessAdb";
import { endpointProblem, isPrivateIpv4, pairingProblem, parsePort, splitHostPort } from "@/lib/devices/wireless-browser";
import type { WirelessDevice, WirelessStatus } from "@/lib/devices/wireless-types";
import { WIRELESS_PAIRING_CODE_LENGTH } from "@/lib/devices/wireless-types";
import { useI18n } from "@/lib/i18n";
import { Button, cardStyle, Chip, Disclosure, Notice, sectionHeadingStyle, TextField } from "./ui";
import { WirelessShell } from "./WirelessShell";

const STATUS_KEY: Record<WirelessStatus, string> = {
  unpaired: "devices.wirelessStatusUnpaired",
  pairing: "devices.wirelessStatusPairing",
  connecting: "devices.wirelessStatusConnecting",
  connected: "devices.wirelessStatusConnected",
  disconnected: "devices.wirelessStatusDisconnected",
  offline: "devices.wirelessStatusOffline",
  "needs-pairing": "devices.wirelessStatusNeedsPairing",
};

function StatusChip({ status }: { status: WirelessStatus }) {
  const { t } = useI18n();
  const tone = status === "connected" ? "good" : status === "offline" || status === "needs-pairing" ? "warn" : "neutral";
  const icon = status === "offline" || status === "disconnected" ? <WifiOff size={12} strokeWidth={2.4} /> : <Wifi size={12} strokeWidth={2.4} />;
  return <Chip tone={tone} icon={icon}>{t(STATUS_KEY[status])}</Chip>;
}

const groupStyle = { display: "flex", flexDirection: "column", gap: 10, minWidth: 0, margin: 0, padding: "8px 12px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" } as const;
const legendStyle = { padding: "0 4px", fontSize: 12, fontWeight: 600, color: "var(--text)" } as const;
const twoUpStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))", gap: 10 } as const;
// Chosen so a password manager or the browser's own autofill leaves the one-time code alone.
const noAutofill = { autoComplete: "off", "data-lpignore": "true", "data-1p-ignore": "true", "data-bwignore": "true", "data-form-type": "other" } as const;

function Problem({ children }: { children: string }) {
  return <span style={{ color: "var(--status-error)" }}>{children}</span>;
}

/**
 * Android shows the connection details on the main screen and the pairing details in a separate popup.
 * Keep the code in the input only, not in React state or a named form field the browser could submit.
 */
function PairForm({ wireless }: { wireless: WirelessController }) {
  const { t } = useI18n();
  const [hostValue, setHost] = useState("");
  const [connectValue, setConnectPort] = useState("");
  const [pairingPort, setPairingPort] = useState("");
  const [codeReady, setCodeReady] = useState(false);
  const pairing = parsePort(pairingPort);
  const connect = parsePort(connectValue);
  const samePort = pairing !== null && pairing === connect;
  const validHost = isPrivateIpv4(hostValue);
  const ready = validHost && connect !== null && pairing !== null && !samePort && codeReady;
  const locked = wireless.busy !== null || wireless.snapshot?.status === "pairing";

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // Read the untracked password field only on submission.
    const input = event.currentTarget.querySelector<HTMLInputElement>("[data-wireless-pairing-code]");
    if (locked || !input || connect === null || pairing === null || pairingProblem({ host: hostValue, connectPort: connectValue, pairingPort, code: input.value })) return;
    const code = input.value;
    input.value = "";
    setCodeReady(false);
    void wireless.pair({ host: hostValue.trim(), pairingPort: pairing, connectPort: connect, code });
  };
  // "192.168.1.50:37099" copied from the Android screen fills the address and that port at once.
  const onHost = (value: string): void => {
    const split = splitHostPort(value);
    if (split) { setHost(split.host); setConnectPort(split.port); } else setHost(value);
  };
  const onPairingPort = (value: string): void => {
    const split = splitHostPort(value);
    if (split) { setPairingPort(split.port); if (hostValue === "") setHost(split.host); } else setPairingPort(value.replace(/\D/g, "").slice(0, 5));
  };

  return (
    <form onSubmit={submit} autoComplete="off" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.wirelessIntro")}</p>
      <Disclosure summary={t("devices.wirelessWhereSummary")}>
        <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>
          <li>{t("devices.wirelessWhere1")}</li>
          <li>{t("devices.wirelessWhere2")}</li>
          <li>{t("devices.wirelessWhere3")}</li>
        </ol>
      </Disclosure>

      <fieldset style={groupStyle}>
        <legend style={legendStyle}>{t("devices.wirelessConnectionGroup")}</legend>
        <TextField
          label={t("devices.wirelessAddress")}
          hint={hostValue !== "" && !validHost ? <Problem>{t("devices.wirelessErrAddress")}</Problem> : t("devices.wirelessAddressHint")}
          value={hostValue}
          onChange={(event) => onHost(event.target.value)}
          placeholder="192.168.1.50"
          inputMode="decimal"
          name="wireless-adb-address"
          aria-invalid={hostValue !== "" && !validHost}
          disabled={locked}
          mono
          {...noAutofill}
        />
        <TextField
          label={t("devices.wirelessConnectPort")}
          hint={connectValue !== "" && connect === null ? <Problem>{t("devices.wirelessErrPort")}</Problem> : t("devices.wirelessConnectPortHint")}
          value={connectValue}
          onChange={(event) => setConnectPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
          inputMode="numeric"
          name="wireless-adb-connect-port"
          aria-invalid={connectValue !== "" && connect === null}
          disabled={locked}
          mono
          {...noAutofill}
        />
      </fieldset>

      <fieldset style={groupStyle}>
        <legend style={legendStyle}>{t("devices.wirelessPairingGroup")}</legend>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-dim)" }}>{t("devices.wirelessPairingHint")}</p>
        <div style={twoUpStyle}>
          <TextField
            label={t("devices.wirelessPairingPort")}
            hint={samePort ? <Problem>{t("devices.wirelessErrSamePort")}</Problem> : pairingPort !== "" && pairing === null ? <Problem>{t("devices.wirelessErrPort")}</Problem> : undefined}
            value={pairingPort}
            onChange={(event) => onPairingPort(event.target.value)}
            inputMode="numeric"
            name="wireless-adb-pairing-port"
            aria-invalid={samePort || (pairingPort !== "" && pairing === null)}
            disabled={locked}
            mono
            {...noAutofill}
          />
          <TextField
            label={t("devices.wirelessPairingCode")}
            onInput={(event) => {
              const input = event.currentTarget;
              input.value = input.value.replace(/\D/g, "");
              setCodeReady(input.value.length === WIRELESS_PAIRING_CODE_LENGTH);
            }}
            type="password"
            inputMode="numeric"
            enterKeyHint="go"
            maxLength={WIRELESS_PAIRING_CODE_LENGTH}
            data-wireless-pairing-code=""
            disabled={locked}
            mono
            {...noAutofill}
          />
        </div>
        <span style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>{t("devices.wirelessPairingCodeHint", { count: WIRELESS_PAIRING_CODE_LENGTH })}</span>
      </fieldset>

      <Button type="submit" tone="primary" full icon={<KeyRound size={16} />} disabled={!ready || locked}>
        {wireless.busy === "pair" ? t("devices.wirelessPairingBusy") : t("devices.wirelessPair")}
      </Button>
    </form>
  );
}

/** The address of a tablet that is already paired: no code, because Android only changes the port when Wireless debugging is switched back on. */
function AddressForm({ wireless, device }: { wireless: WirelessController; device: WirelessDevice }) {
  const { t } = useI18n();
  const [host, setHost] = useState(device.host);
  const [port, setPort] = useState(String(device.connectPort));
  const problem = endpointProblem({ host, connectPort: port });
  const locked = wireless.busy !== null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const connectPort = parsePort(port);
    if (problem || locked || connectPort === null) return;
    void wireless.connect({ host: host.trim(), connectPort });
  };
  return (
    <form onSubmit={submit} autoComplete="off" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.wirelessChangeAddressHint")}</p>
      <div style={twoUpStyle}>
        <TextField
          label={t("devices.wirelessAddress")}
          hint={host !== "" && !isPrivateIpv4(host) ? <Problem>{t("devices.wirelessErrAddress")}</Problem> : undefined}
          value={host}
          onChange={(event) => { const split = splitHostPort(event.target.value); if (split) { setHost(split.host); setPort(split.port); } else setHost(event.target.value); }}
          inputMode="decimal"
          name="wireless-adb-address"
          aria-invalid={host !== "" && !isPrivateIpv4(host)}
          disabled={locked}
          mono
          {...noAutofill}
        />
        <TextField
          label={t("devices.wirelessConnectPort")}
          hint={port !== "" && parsePort(port) === null ? <Problem>{t("devices.wirelessErrPort")}</Problem> : undefined}
          value={port}
          onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
          inputMode="numeric"
          name="wireless-adb-connect-port"
          aria-invalid={port !== "" && parsePort(port) === null}
          disabled={locked}
          mono
          {...noAutofill}
        />
      </div>
      <Button type="submit" full icon={<RefreshCw size={16} />} disabled={problem !== null || locked}>{t("devices.wirelessSaveReconnect")}</Button>
    </form>
  );
}

function formatTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** The second step of removing a tablet. "Keep" is focused first so a stray Enter cannot delete anything. */
export function RemoveConfirm({ locked, onKeep, onRemove }: { locked: boolean; onKeep: () => void; onRemove: () => void }): React.ReactElement {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t("devices.wirelessRemoveConfirm")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("devices.wirelessRemoveConfirm")}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button autoFocus onClick={onKeep} disabled={locked} style={{ flex: "1 1 120px" }}>{t("devices.wirelessKeep")}</Button>
        <Button tone="danger" icon={<Trash2 size={16} />} onClick={onRemove} disabled={locked} style={{ flex: "1 1 120px" }}>{t("devices.wirelessRemoveYes")}</Button>
      </div>
    </div>
  );
}

/** What is left to do after a tablet is removed: Cody dropped its key, but only the tablet can forget Cody. Stays until dismissed. */
export function ForgetGuide({ name, onDone }: { name: string | undefined; onDone: () => void }): React.ReactElement {
  const { t } = useI18n();
  return (
    <>
      <Notice tone="warning">
        <strong>{t("devices.wirelessForgetGuideTitle")}</strong>{" "}
        {t("devices.wirelessForgetGuide", { name: name ?? t("devices.wirelessThisServer") })}
      </Notice>
      <Button tone="quiet" onClick={onDone}>{t("devices.wirelessGuideDone")}</Button>
    </>
  );
}

/** Everything about the one paired tablet: where it is, how it is doing, the one button it needs, and the way to remove it. */
function PairedTablet({ wireless, device, status, sessionId, onRemoved }: { wireless: WirelessController; device: WirelessDevice; status: WirelessStatus; sessionId: string; onRemoved: (clientName: string | undefined) => void }) {
  const { t, locale } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const locked = wireless.busy !== null;
  const working = status === "connecting" || status === "pairing";
  const canReconnect = status === "offline" || status === "disconnected";

  const remove = async (): Promise<void> => {
    if (await wireless.forget()) onRemoved(device.clientName);
    setConfirming(false);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
        <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, marginTop: 2, color: "var(--text-muted)" }}><Smartphone size={20} /></span>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>{device.label}</span>
          <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)", overflowWrap: "anywhere" }}>{device.host}:{device.connectPort}</span>
          <span style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>
            {device.lastConnectedAt !== undefined ? t("devices.wirelessLastConnected", { time: formatTime(device.lastConnectedAt, locale) }) : t("devices.wirelessPairedAt", { time: formatTime(device.pairedAt, locale) })}
          </span>
        </div>
      </div>

      {status === "offline" && <Notice tone="warning">{t("devices.wirelessOfflineHint")}</Notice>}
      {status === "disconnected" && <Notice>{t("devices.wirelessDisconnectedHint")}</Notice>}
      {status === "needs-pairing" && <Notice tone="warning">{t("devices.wirelessNeedsPairingHint")}</Notice>}

      {canReconnect && (
        <Button tone="primary" full icon={<RefreshCw size={16} />} disabled={locked} onClick={() => void wireless.connect()}>
          {wireless.busy === "connect" ? t("devices.wirelessConnecting") : t("devices.wirelessReconnect")}
        </Button>
      )}
      {(status === "connected" || working) && (
        <Button full icon={<Unplug size={16} />} disabled={locked} onClick={() => void wireless.disconnect()}>{t("devices.wirelessDisconnect")}</Button>
      )}
      <span style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>{t("devices.wirelessScopeNote")}</span>

      {status === "connected" && <WirelessShell sessionId={sessionId} selectionId={device.selectionId} disabled={locked} />}
      {canReconnect && (
        <Disclosure summary={t("devices.wirelessChangeAddressSummary")}>
          <AddressForm wireless={wireless} device={device} />
        </Disclosure>
      )}

      <Disclosure summary={t("devices.wirelessRemoveSummary")} defaultOpen={status === "needs-pairing"}>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.wirelessRemoveBody")}</p>
        {confirming ? (
          <RemoveConfirm locked={locked} onKeep={() => setConfirming(false)} onRemove={() => void remove()} />
        ) : (
          <Button tone="danger" full icon={<Trash2 size={16} />} onClick={() => setConfirming(true)} disabled={locked}>{t("devices.wirelessRemove")}</Button>
        )}
      </Disclosure>
    </>
  );
}

/**
 * Wireless ADB: one tablet per chat, paired once with Android's pairing code and then reconnected by the server on its own,
 * with no cable and no browser bridge. Everything here comes from the server (`useWirelessAdb`); it never touches the USB
 * bridge. Below the first visit the card is one row and one button, because pairing is a one-time job.
 */
export function WirelessCard({ wireless }: { wireless: WirelessController }): React.ReactElement {
  const { t } = useI18n();
  const { snapshot, loadError, actionError } = wireless;
  // Set after a tablet is removed, to say what is left to do on the tablet itself; dropped with the chat (the card is keyed on it).
  const [removed, setRemoved] = useState<{ name: string | undefined } | null>(null);
  const device = snapshot?.device ?? null;

  let body: React.ReactNode;
  if (!snapshot) {
    body = loadError ? (
      <>
        <Notice tone="error" role="alert">{t("devices.wirelessLoadFailed", { reason: loadError })}</Notice>
        <Button full icon={<RefreshCw size={16} />} onClick={wireless.retry}>{t("devices.wirelessRetry")}</Button>
      </>
    ) : (
      <div role="status" style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("devices.wirelessChecking")}</div>
    );
  } else if (!snapshot.supported) {
    body = <Notice tone="info">{t("devices.wirelessUnsupported", { reason: snapshot.reason ?? "" })}</Notice>;
  } else {
    body = (
      <>
        {loadError && <Notice tone="warning">{t("devices.wirelessStale")}</Notice>}
        {actionError && (actionError.action !== "root" || snapshot.rootRequests.length === 0) && (
          <Notice tone="error" role="alert">{actionError.code === "secure_context_required" ? t("devices.wirelessSecurePage") : actionError.message}</Notice>
        )}
        {snapshot.error && !actionError && snapshot.status !== "connected" && <Notice tone="warning">{snapshot.error.message}</Notice>}
        {device && <PairedTablet key={device.selectionId} wireless={wireless} device={device} status={snapshot.status} sessionId={snapshot.sessionId} onRemoved={(name) => setRemoved({ name })} />}
        {removed && !device && <ForgetGuide name={removed.name} onDone={() => setRemoved(null)} />}
        {!device && <PairForm wireless={wireless} />}
      </>
    );
  }

  return (
    <section aria-label={t("devices.wirelessTitle")} style={{ ...cardStyle }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h3 style={sectionHeadingStyle}>{t("devices.wirelessTitle")}</h3>
        {snapshot?.supported && <StatusChip status={snapshot.status} />}
      </div>
      {body}
    </section>
  );
}
