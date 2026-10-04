"use client";

import { useMemo, useState } from "react";
import { Select } from "@/components/ui/Select";
import type { DeviceArtifact } from "@/lib/devices/artifacts";
import { formatBytes, parseEdlCommand } from "@/lib/devices/edl";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";
import { useI18n } from "@/lib/i18n";
import { isTerminalState } from "./OperationList";
import { Button, Chip, Notice, sectionHeadingStyle, TextField } from "./ui";

interface EdlProps {
  manager: DeviceOperationManager;
  deviceId: string;
  /** This device's operations, newest last. */
  operations: readonly DeviceOperationSnapshot[];
  interfaceNumber?: number;
  alternateSetting?: number;
  /** The file selected in Files & backups, used as the loader while the device is still in its boot ROM. */
  input: DeviceArtifact | undefined;
  onChooseFile: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The EDL command an operation ran, in its canonical spelling, or undefined when it is not an EDL command. */
function commandOf(operation: DeviceOperationSnapshot): string | undefined {
  if (operation.request.protocol !== "edl" || operation.request.action !== "exec") return undefined;
  try {
    return parseEdlCommand(operation.request.command);
  } catch {
    return undefined;
  }
}

function lastResult(operations: readonly DeviceOperationSnapshot[], command: string): Record<string, unknown> | undefined {
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (commandOf(operation) === command && operation.state === "succeeded" && operation.result?.details) return operation.result.details;
  }
  return undefined;
}

interface ListedPartition {
  name: string;
  bytes: number;
}

function listedPartitions(details: Record<string, unknown> | undefined): ListedPartition[] {
  const raw = details?.partitions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry) || !("bytes" in entry)) return [];
    return typeof entry.name === "string" && typeof entry.bytes === "number" ? [{ name: entry.name, bytes: entry.bytes }] : [];
  });
}

interface CheckOutcome {
  ok: boolean;
  sectors: number;
  bytes: number;
  reason: string;
}

function lastCheck(operations: readonly DeviceOperationSnapshot[]): CheckOutcome | undefined {
  const check = lastResult(operations, "check")?.check;
  if (typeof check !== "object" || check === null || !("ok" in check) || !("measuredSectors" in check) || !("sectorSize" in check) || !("reasons" in check)) return undefined;
  const { ok, measuredSectors, sectorSize, reasons } = check;
  if (typeof ok !== "boolean" || typeof measuredSectors !== "number" || typeof sectorSize !== "number") return undefined;
  return { ok, sectors: measuredSectors, bytes: measuredSectors * sectorSize, reason: Array.isArray(reasons) ? reasons.filter((item): item is string => typeof item === "string").join(" ") : "" };
}

/** Starts EDL operations on one device, attaching the chosen loader file. */
function useEdlStarter({ manager, deviceId, interfaceNumber, alternateSetting, input }: EdlProps) {
  const [error, setError] = useState("");
  const start = (request: { action: "exec"; command: string } | { action: "dump"; target: string; options?: Record<string, number> }, withLoader: boolean) => {
    try {
      manager.startUser({
        deviceId,
        protocol: "edl",
        ...request,
        ...(interfaceNumber !== undefined ? { interfaceNumber, alternateSetting } : {}),
        ...(withLoader && input ? { fileId: input.id, sha256: input.sha256 } : {}),
      });
      setError("");
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return { start, error };
}

function CommandCard({ title, hint, onStart, disabled, tone }: { title: string; hint: string; onStart: () => void; disabled: boolean; tone?: "warning" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <Button tone={tone ?? "primary"} disabled={disabled} onClick={onStart} full>{title}</Button>
      <span style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>{hint}</span>
    </div>
  );
}

/** Connect, read the partition tables, check the disk, leave EDL. */
export function EdlCommands(props: EdlProps): React.ReactElement {
  const { t } = useI18n();
  const { start, error } = useEdlStarter(props);
  const { input, onChooseFile, operations } = props;
  const busy = operations.some((operation) => !isTerminalState(operation.state));
  return (
    <section aria-label={t("devices.edl.commandsTitle")} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Notice>{t("devices.edl.untested")}</Notice>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.edl.loaderTitle")}</h4>
        {input ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Chip tone="good">{t("devices.edl.loaderChosen", { name: input.name })}</Chip>
              <Button onClick={onChooseFile}>{t("devices.changeFile")}</Button>
            </div>
            <small style={{ overflowWrap: "anywhere", color: "var(--text-muted)" }}>SHA-256 {input.sha256}</small>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Notice>{t("devices.edl.loaderNone")}</Notice>
            <div><Button onClick={onChooseFile}>{t("devices.chooseFile")}</Button></div>
          </div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12 }}>
        <CommandCard title={t("devices.edl.connect")} hint={t("devices.edl.connectHint")} disabled={busy} onStart={() => start({ action: "exec", command: "connect" }, true)} />
        <CommandCard title={t("devices.edl.printgpt")} hint={t("devices.edl.printgptHint")} disabled={busy} onStart={() => start({ action: "exec", command: "printgpt" }, true)} />
        <CommandCard title={t("devices.edl.check")} hint={t("devices.edl.checkHint")} disabled={busy} onStart={() => start({ action: "exec", command: "check" }, true)} />
        <CommandCard title={t("devices.edl.reset")} hint={t("devices.edl.resetHint")} disabled={busy} tone="warning" onStart={() => start({ action: "exec", command: "reset" }, false)} />
      </div>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </section>
  );
}

/** Back up one partition chosen from the last partition-table read, or the whole user area after a passing check. */
export function EdlBackup(props: EdlProps): React.ReactElement {
  const { t } = useI18n();
  const { start, error } = useEdlStarter(props);
  const { operations } = props;
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const busy = operations.some((operation) => !isTerminalState(operation.state));
  const partitions = useMemo(() => listedPartitions(lastResult(operations, "printgpt")), [operations]);
  const check = useMemo(() => lastCheck(operations), [operations]);
  const name = typed.trim() || picked || "";
  return (
    <section aria-label={t("devices.edl.backupTitle")} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Notice>{t("devices.edl.bootAreas")}</Notice>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.edl.partitionTitle")}</h4>
        {partitions.length > 0 ? (
          <Select
            aria-label={t("devices.edl.partitionPick")}
            value={picked}
            onChange={(value) => { setPicked(value); setTyped(""); }}
            placeholder={t("devices.edl.partitionPick")}
            options={partitions.map((part) => ({ value: part.name, label: t("devices.edl.partitionOption", { name: part.name, size: formatBytes(part.bytes) }) }))}
          />
        ) : (
          <Notice>{t("devices.edl.partitionNoTable")}</Notice>
        )}
        <TextField label={t("devices.edl.partitionName")} placeholder={t("devices.edl.partitionNamePlaceholder")} mono value={typed} onChange={(event) => setTyped(event.target.value)} />
        <div><Button tone="primary" disabled={busy || !name} onClick={() => start({ action: "dump", target: name }, true)}>{t("devices.edl.partitionStart")}</Button></div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.edl.wholeTitle")}</h4>
        {!check ? <Notice>{t("devices.edl.wholeNoCheck")}</Notice>
          : check.ok ? <Notice>{t("devices.edl.wholePassed", { sectors: check.sectors, size: formatBytes(check.bytes) })}</Notice>
            : <Notice tone="warning">{t("devices.edl.wholeFailed", { reason: check.reason })}</Notice>}
        <div>
          <Button tone="warning" disabled={busy || !check?.ok} onClick={() => check && start({ action: "dump", target: "user-area", options: { sectors: check.sectors } }, true)}>{t("devices.edl.wholeStart")}</Button>
        </div>
      </div>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </section>
  );
}
