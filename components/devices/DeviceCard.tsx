"use client";

import { Activity, ArchiveRestore, Bluetooth, Cable, FolderOpen, Info, Network, Smartphone, Terminal, Unplug, Usb, Zap } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";
import type { DeviceActivity, DeviceInfo } from "@/lib/devices/protocol";
import type { DeviceArtifact } from "@/lib/devices/artifacts";
import { adbBannerState, availableGroups, deviceMode, formActions, offeredProtocols, type ActionGroup, type DeviceMode } from "@/lib/devices/ui-model";
import { useI18n } from "@/lib/i18n";
import { ActionForm } from "./ActionForm";
import { ActivityLine } from "./ActivityLine";
import { DeviceTerminal } from "./DeviceTerminal";
import { FastbootCommand } from "./FastbootCommand";
import { isTerminalState, OperationList } from "./OperationList";
import { ShellAccessControl } from "./ShellAccessControl";
import { Button, cardStyle, Chip, Disclosure, Notice, sectionHeadingStyle, TOUCH } from "./ui";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const GROUP_ICON: Record<ActionGroup, React.ReactNode> = {
  overview: <Info size={16} />,
  terminal: <Terminal size={16} />,
  commands: <Terminal size={16} />,
  serial: <Activity size={16} />,
  files: <FolderOpen size={16} />,
  flash: <Zap size={16} />,
  backup: <ArchiveRestore size={16} />,
  ports: <Network size={16} />,
};

const VISIBLE_OPERATIONS = 3;

function hex4(value: number | undefined): string {
  return (value ?? 0).toString(16).padStart(4, "0");
}

function modeIcon(mode: DeviceMode, device: DeviceInfo): React.ReactNode {
  if (device.kind === "ble") return <Bluetooth size={20} />;
  if (mode.id === "serial") return <Cable size={20} />;
  if (mode.id === "adb") return <Smartphone size={20} />;
  return <Usb size={20} />;
}

/** The most recent finished identify result for a protocol on this device, if any. */
function lastDetect(operations: readonly DeviceOperationSnapshot[], protocol: string): Record<string, unknown> | undefined {
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (operation.request.protocol === protocol && operation.request.action === "detect" && operation.state === "succeeded" && operation.result?.details) return operation.result.details as Record<string, unknown>;
  }
  return undefined;
}

function modeLabel(mode: DeviceMode, operations: readonly DeviceOperationSnapshot[], t: Translate): string {
  switch (mode.id) {
    case "adb": {
      const state = adbBannerState(lastDetect(operations, "adb")?.banner);
      if (state === "recovery") return t("devices.modeAdbRecovery");
      if (state === "sideload") return t("devices.modeAdbSideload");
      if (state === "bootloader") return t("devices.modeAdbBootloader");
      return t("devices.modeAdb");
    }
    case "fastboot": return t("devices.modeFastboot");
    case "dfu": return t("devices.modeDfu");
    case "serial": {
      const chip = lastDetect(operations, "esp")?.chip;
      return typeof chip === "string" && chip ? t("devices.modeSerialChip", { chip }) : t("devices.modeSerial");
    }
    case "ble": return t("devices.modeBle");
    case "unknown-usb": return t("devices.modeUnknownUsb");
  }
}

function groupLabel(group: ActionGroup, t: Translate): string {
  return t(`devices.group.${group}`);
}

function Facts({ device, mode, t }: { device: DeviceInfo; mode: DeviceMode; t: Translate }) {
  const rows: Array<[string, string]> = [];
  if (device.vendorId !== undefined || device.productId !== undefined) rows.push([t("devices.factIds"), `${hex4(device.vendorId)}:${hex4(device.productId)}`]);
  if (device.serialNumber) rows.push([t("devices.factSerialNumber"), device.serialNumber]);
  if (device.transport) rows.push([t("devices.factTransport"), device.transport === "web-serial" ? t("devices.transportWebSerial") : t("devices.transportWebUsb")]);
  if (device.baudRate) rows.push([t("devices.operationBaudRate"), String(device.baudRate)]);
  if (mode.protocols.length > 0) rows.push([t("devices.factProtocols"), mode.protocols.map((protocol) => t(`devices.protocol.${protocol}`)).join(", ")]);
  if (device.services && device.services.length > 0) rows.push([t("devices.factServices"), device.services.join(", ")]);
  if (rows.length === 0) return null;
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 8, margin: 0, fontSize: 12 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ minWidth: 0, padding: "6px 8px", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
          <dt style={{ color: "var(--text-dim)", fontSize: 11 }}>{label}</dt>
          <dd style={{ margin: 0, color: "var(--text)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface DeviceCardProps {
  sessionId: string;
  manager: DeviceOperationManager | null;
  device: DeviceInfo;
  activity: DeviceActivity | undefined;
  operations: readonly DeviceOperationSnapshot[];
  selectedInputId: string | null;
  input: DeviceArtifact | undefined;
  onChooseFile: () => void;
  onDisconnect: () => void;
}

/** One granted device: who it is, what mode it is in, and only the actions that mode supports. */
export function DeviceCard({ sessionId, manager, device, activity, operations, selectedInputId, input, onChooseFile, onDisconnect }: DeviceCardProps): React.ReactElement {
  const { t } = useI18n();
  const baseId = useId();
  const mode = useMemo(() => deviceMode(device), [device]);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<ActionGroup>("overview");
  const protocols = offeredProtocols(mode, showAll);
  const groups = useMemo(() => availableGroups(protocols), [protocols]);
  const tab = groups.includes(selected) ? selected : "overview";
  const awaiting = operations.some((operation) => operation.state === "awaiting-confirmation");
  const running = operations.some((operation) => !isTerminalState(operation.state));
  // A user terminal shows its own output on the Terminal tab; listing it again here would repeat every line.
  const listed = useMemo(() => operations.filter((operation) => !(operation.origin === "user" && operation.request.action === "monitor")).slice().reverse(), [operations]);
  const recent = listed.slice(0, VISIBLE_OPERATIONS);
  const earlier = listed.slice(VISIBLE_OPERATIONS);
  const label = modeLabel(mode, operations, t);

  const adbCandidates = device.protocolCandidates?.filter((candidate) => candidate.protocol === "adb") ?? [];
  const fastbootCandidates = device.protocolCandidates?.filter((candidate) => candidate.protocol === "fastboot") ?? [];
  const serialCandidates = device.protocolCandidates?.filter((candidate) => candidate.protocol === "serial") ?? [];

  const form = (group: ActionGroup) => manager && (
    <ActionForm key={group} sessionId={sessionId} manager={manager} device={device} group={group} protocols={protocols} selectedInputId={selectedInputId} onChooseFile={onChooseFile} />
  );

  const renderGroup = (group: ActionGroup): React.ReactNode => {
    if (!manager) return <Notice>{t("devices.operationsUnavailable")}</Notice>;
    switch (group) {
      case "overview":
        return (
          <>
            <Facts device={device} mode={mode} t={t} />
            {device.kind === "ble" ? <Notice>{t("devices.bleAgentOnly")}</Notice> : (
              <>
                {mode.id === "unknown-usb" && <Notice tone="warning">{t("devices.modeUnknownHint")}</Notice>}
                {protocols.some((protocol) => formActions("overview", protocol).length > 0) && (
                  <section aria-label={t("devices.action.detect")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <h4 style={sectionHeadingStyle}>{t("devices.identifyTitle")}</h4>
                    {form("overview")}
                  </section>
                )}
                {mode.id !== "unknown-usb" && (
                  <Disclosure summary={t("devices.advanced")}>
                    <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("devices.showAllProtocolsHint")}</div>
                    <div><Button pressed={showAll} onClick={() => setShowAll((current) => !current)}>{showAll ? t("devices.showAllProtocolsOn") : t("devices.showAllProtocolsOff")}</Button></div>
                  </Disclosure>
                )}
              </>
            )}
          </>
        );
      case "terminal":
        return (
          <>
            <ShellAccessControl manager={manager} deviceId={device.id} label={device.label} />
            {(adbCandidates.length > 0 ? adbCandidates : [undefined]).map((candidate) => (
              <DeviceTerminal key={candidate ? `${candidate.interfaceNumber}:${candidate.alternateSetting}` : "adb"} manager={manager} deviceId={device.id} label={device.label} interfaceNumber={candidate?.interfaceNumber} alternateSetting={candidate?.alternateSetting} showTitle={adbCandidates.length > 1} />
            ))}
            <Disclosure summary={t("devices.runOneCommand")}>{form("terminal")}</Disclosure>
          </>
        );
      case "commands":
        return (
          <>
            {protocols.includes("fastboot") && (fastbootCandidates.length > 0 ? fastbootCandidates : [undefined]).map((candidate) => (
              <FastbootCommand key={candidate ? `${candidate.interfaceNumber}:${candidate.alternateSetting}` : "fastboot"} manager={manager} deviceId={device.id} label={device.label} interfaceNumber={candidate?.interfaceNumber} alternateSetting={candidate?.alternateSetting} input={input} showTitle={fastbootCandidates.length > 1} />
            ))}
            {protocols.some((protocol) => formActions("commands", protocol).length > 0) && form("commands")}
          </>
        );
      case "serial":
        return (
          <>
            {device.kind === "serial" || serialCandidates.length === 0 ? (
              <DeviceTerminal manager={manager} deviceId={device.id} label={device.label} protocol="serial" />
            ) : serialCandidates.map((candidate) => (
              <DeviceTerminal key={`${candidate.interfaceNumber}:${candidate.alternateSetting}`} manager={manager} deviceId={device.id} label={device.label} protocol="serial" interfaceNumber={candidate.interfaceNumber} alternateSetting={candidate.alternateSetting} showTitle={serialCandidates.length > 1} />
            ))}
            <Disclosure summary={t("devices.lineCommand")}>{form("serial")}</Disclosure>
          </>
        );
      case "files":
        return form("files");
      case "flash":
        return (
          <>
            <Notice tone="warning">{t("devices.flashWarning")}</Notice>
            {form("flash")}
          </>
        );
      case "backup":
        return (
          <>
            <Notice>{t("devices.backupRestoreNote")}</Notice>
            {form("backup")}
          </>
        );
      case "ports":
        return (
          <>
            <Notice>{t("devices.portsHostNote")}</Notice>
            {form("ports")}
          </>
        );
    }
  };

  return (
    <article aria-label={device.label} style={cardStyle}>
      <header style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, alignItems: "center", justifyContent: "center", width: TOUCH, height: TOUCH, borderRadius: "var(--radius-control)", background: "var(--bg)", color: device.open ? "var(--status-success)" : "var(--accent)" }}>
          {modeIcon(mode, device)}
        </span>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)", overflowWrap: "anywhere" }}>{device.label}</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Chip tone="accent">{label}</Chip>
            <Chip tone={device.open ? "good" : "neutral"}>{device.open ? t("devices.stateInUse") : t("devices.stateReady")}</Chip>
            {awaiting ? <Chip tone="warn">{t("devices.operationStateAwaitingConfirmation")}</Chip> : running ? <Chip tone="neutral">{t("devices.operationStateRunning")}</Chip> : null}
          </div>
          {activity && <ActivityLine activity={activity} />}
        </div>
        <Button icon={<Unplug size={18} />} ariaLabel={t("devices.disconnectLabel", { label: device.label })} title={t("devices.disconnectLabel", { label: device.label })} onClick={onDisconnect} />
      </header>

      {groups.length > 1 && (
        <div role="tablist" aria-label={t("devices.actionsFor", { device: device.label })} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (step === 0) return;
            event.preventDefault();
            const next = groups[(groups.indexOf(tab) + step + groups.length) % groups.length];
            setSelected(next);
            document.getElementById(`${baseId}-tab-${next}`)?.focus();
          }}
        >
          {groups.map((group) => {
            const active = group === tab;
            return (
              <button
                key={group}
                id={`${baseId}-tab-${group}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`${baseId}-panel-${group}`}
                tabIndex={active ? 0 : -1}
                className="ui-focus-ring dv-btn"
                onClick={() => setSelected(group)}
                style={{
                  flex: "0 0 auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  minHeight: TOUCH,
                  padding: "0 14px",
                  borderRadius: "var(--radius-control)",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  background: active ? "var(--bg-selected)" : "var(--bg)",
                  color: "var(--text)",
                  fontSize: 13,
                  fontWeight: active ? 700 : 500,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                <span aria-hidden="true" style={{ display: "inline-flex", color: active ? "var(--accent)" : "var(--text-muted)" }}>{GROUP_ICON[group]}</span>
                {groupLabel(group, t)}
              </button>
            );
          })}
        </div>
      )}

      {/* Every panel stays mounted and only the chosen one is shown: a terminal or form on another tab keeps its state and its running operation. */}
      {groups.map((group) => (
        <div
          key={group}
          id={`${baseId}-panel-${group}`}
          role={groups.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={groups.length > 1 ? `${baseId}-tab-${group}` : undefined}
          hidden={group !== tab}
          style={{ display: group === tab ? "flex" : "none", flexDirection: "column", gap: 12, minWidth: 0 }}
        >
          {renderGroup(group)}
        </div>
      ))}

      {manager && listed.length > 0 && (
        <section aria-label={t("devices.activityTitle")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h4 style={sectionHeadingStyle}>{t("devices.activityTitle")}</h4>
          <OperationList manager={manager} operations={recent} />
          {earlier.length > 0 && (
            <Disclosure summary={t("devices.earlierActivity", { count: earlier.length })}>
              <OperationList manager={manager} operations={earlier} />
            </Disclosure>
          )}
        </section>
      )}
    </article>
  );
}
