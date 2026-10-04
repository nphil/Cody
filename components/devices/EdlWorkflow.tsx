"use client";

import { useEffect, useMemo, useState } from "react";
import { Select } from "@/components/ui/Select";
import { deviceArtifacts, type DeviceArtifact } from "@/lib/devices/artifacts";
import { parseEdlCommand } from "@/lib/devices/edl";
import { formatBytes } from "@/lib/devices/edl-disk";
import { classifyEdlPartition } from "@/lib/devices/edl-protect";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";
import { useI18n } from "@/lib/i18n";
import { isTerminalState } from "./OperationList";
import { Button, Chip, Notice, Segmented, sectionHeadingStyle, TextField } from "./ui";

interface EdlProps {
  manager: DeviceOperationManager;
  sessionId: string;
  deviceId: string;
  /** This device's operations, newest last. */
  operations: readonly DeviceOperationSnapshot[];
  interfaceNumber?: number;
  alternateSetting?: number;
  /** The file selected in Files & backups: the loader while the device is still in its boot ROM, the image for a flash. */
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

interface LastSet {
  id: string;
  partitions: number;
  restorable: boolean;
  reason: string;
}

/** The backup set the last successful `backup` saved, as its result describes it. */
function lastBackupSet(operations: readonly DeviceOperationSnapshot[]): LastSet | undefined {
  const details = lastResult(operations, "backup");
  const manifest = details?.manifest;
  if (typeof manifest !== "object" || manifest === null || !("sha256" in manifest) || typeof manifest.sha256 !== "string") return undefined;
  const listed = details?.partitions;
  const reasons = details?.notRestorableBecause;
  return {
    id: manifest.sha256.slice(0, 8),
    partitions: Array.isArray(listed) ? listed.length : 0,
    restorable: details?.restorable === true,
    reason: Array.isArray(reasons) ? reasons.filter((item): item is string => typeof item === "string").join(" ") : "",
  };
}

type EdlRequest =
  | { action: "exec"; command: string; options?: Record<string, string>; target?: string }
  | { action: "dump"; target: string; options?: Record<string, number> }
  | { action: "flash"; target: string; options?: Record<string, string> };

/** Starts EDL operations on one device, attaching the chosen file (the loader, or for a flash the image) when asked. */
function useEdlStarter({ manager, deviceId, interfaceNumber, alternateSetting, input }: EdlProps) {
  const [error, setError] = useState("");
  const start = (request: EdlRequest, withFile: boolean) => {
    try {
      manager.startUser({
        deviceId,
        protocol: "edl",
        ...request,
        ...(interfaceNumber !== undefined ? { interfaceNumber, alternateSetting } : {}),
        ...(withFile && input ? { fileId: input.id, sha256: input.sha256 } : {}),
      });
      setError("");
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return { start, error };
}

/** Every file of this session, kept current while mounted. */
function useSessionArtifacts(sessionId: string): readonly DeviceArtifact[] {
  const [artifacts, setArtifacts] = useState<readonly DeviceArtifact[]>(() => deviceArtifacts.list(sessionId));
  useEffect(() => deviceArtifacts.subscribe(sessionId, setArtifacts), [sessionId]);
  return artifacts;
}

interface PartitionChoice {
  partitions: ListedPartition[];
  picked: string | null;
  typed: string;
  setPicked: (name: string | null) => void;
  setTyped: (text: string) => void;
  /** The typed name, else the picked one. */
  name: string;
}

/** The partitions the last partition-table read listed, and the one the user picked or typed. */
function usePartitionChoice(operations: readonly DeviceOperationSnapshot[]): PartitionChoice {
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const partitions = useMemo(() => listedPartitions(lastResult(operations, "printgpt")), [operations]);
  return { partitions, picked, typed, setPicked, setTyped, name: typed.trim() || picked || "" };
}

function PartitionPicker({ choice }: { choice: PartitionChoice }) {
  const { t } = useI18n();
  const { partitions, picked, typed, setPicked, setTyped } = choice;
  return (
    <>
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
    </>
  );
}

/** The file chosen in Files & backups, with its digest, or the way to choose one. */
function ChosenFile({ input, chosen, none, onChooseFile }: { input: DeviceArtifact | undefined; chosen: string; none: string; onChooseFile: () => void }) {
  const { t } = useI18n();
  return input ? (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Chip tone="good">{chosen}</Chip>
        <Button onClick={onChooseFile}>{t("devices.changeFile")}</Button>
      </div>
      <small style={{ overflowWrap: "anywhere", color: "var(--text-muted)" }}>SHA-256 {input.sha256}</small>
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Notice>{none}</Notice>
      <div><Button onClick={onChooseFile}>{t("devices.chooseFile")}</Button></div>
    </div>
  );
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
        <ChosenFile input={input} chosen={t("devices.edl.loaderChosen", { name: input?.name ?? "" })} none={t("devices.edl.loaderNone")} onChooseFile={onChooseFile} />
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
  const choice = usePartitionChoice(operations);
  const busy = operations.some((operation) => !isTerminalState(operation.state));
  const check = useMemo(() => lastCheck(operations), [operations]);
  return (
    <section aria-label={t("devices.edl.backupTitle")} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Notice>{t("devices.edl.bootAreas")}</Notice>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.edl.partitionTitle")}</h4>
        <PartitionPicker choice={choice} />
        <div><Button tone="primary" disabled={busy || !choice.name} onClick={() => start({ action: "dump", target: choice.name }, true)}>{t("devices.edl.partitionStart")}</Button></div>
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

/** A backup set of the whole disk, and the restore of one onto the same unit. */
export function EdlBackupSets(props: EdlProps): React.ReactElement {
  const { t } = useI18n();
  const { start, error } = useEdlStarter(props);
  const { operations, input, onChooseFile, sessionId } = props;
  const busy = operations.some((operation) => !isTerminalState(operation.state));
  const artifacts = useSessionArtifacts(sessionId);
  const sets = useMemo(() => artifacts.filter((artifact) => artifact.name.endsWith(".manifest.json")), [artifacts]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen = sets.find((artifact) => artifact.id === chosenId) ?? sets[0];
  const last = useMemo(() => lastBackupSet(operations), [operations]);
  return (
    <section aria-label={t("devices.edl.setTitle")} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.edl.setTitle")}</h4>
        <Notice>{t("devices.edl.setHint")}</Notice>
        <ChosenFile input={input} chosen={t("devices.edl.loaderChosen", { name: input?.name ?? "" })} none={t("devices.edl.loaderNone")} onChooseFile={onChooseFile} />
        {last && (last.restorable
          ? <Chip tone="good">{t("devices.edl.setLast", { id: last.id, count: last.partitions })}</Chip>
          : <Notice tone="warning">{t("devices.edl.setNotRestorable", { reason: last.reason })}</Notice>)}
        <div><Button tone="primary" disabled={busy} onClick={() => start({ action: "exec", command: "backup" }, true)}>{t("devices.edl.setStart")}</Button></div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.edl.restoreTitle")}</h4>
        <Notice tone="warning">{t("devices.edl.restoreIntro")}</Notice>
        {!input && <Notice>{t("devices.edl.restoreLoader")}</Notice>}
        {sets.length > 0 ? (
          <Select
            aria-label={t("devices.edl.restorePick")}
            value={chosen?.id ?? null}
            onChange={setChosenId}
            placeholder={t("devices.edl.restorePick")}
            options={sets.map((artifact) => ({ value: artifact.id, label: t("devices.edl.restoreOption", { name: artifact.name, id: artifact.sha256.slice(0, 8) }) }))}
          />
        ) : (
          <Notice>{t("devices.edl.restoreNone")}</Notice>
        )}
        {chosen && <small style={{ overflowWrap: "anywhere", color: "var(--text-muted)" }}>{t("devices.edl.restoreId", { id: chosen.sha256.slice(0, 8) })} SHA-256 {chosen.sha256}</small>}
        <div>
          <Button tone="danger" disabled={busy || !input || !chosen} onClick={() => chosen && start({ action: "exec", command: "restore", options: { manifestSha256: chosen.sha256 } }, true)}>{t("devices.edl.restoreStart")}</Button>
        </div>
      </div>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </section>
  );
}

export interface FlashAdvice {
  /** How the flasher will treat the name: not chosen yet, an ordinary partition, one that needs a typed override, or one it never writes. */
  level: "none" | "ordinary" | "protected" | "refused";
  /** How the image compares with the partition, when both are known. */
  fit: "unknown" | "exact" | "tooBig" | "needsPad";
  /** Whether the Flash button may be pressed. The flasher checks all of this again; the button only avoids asking for what it will refuse. */
  canFlash: boolean;
}

export function adviseFlash(name: string, partitions: readonly { name: string; bytes: number }[], imageBytes: number | undefined, pad: "none" | "zero" | "ff", busy: boolean): FlashAdvice {
  const level = name ? classifyEdlPartition(name).level : "none";
  const part = partitions.find((entry) => entry.name === name);
  const fit = part && imageBytes !== undefined ? (imageBytes > part.bytes ? "tooBig" : imageBytes < part.bytes ? "needsPad" : "exact") : "unknown";
  const canFlash = !busy && name !== "" && imageBytes !== undefined && level !== "refused" && fit !== "tooBig" && !(fit === "needsPad" && pad === "none");
  return { level, fit, canFlash };
}

/** Write the chosen image into one named partition, or erase one. The confirmation card asks for the typed override where one is needed. */
export function EdlFlash(props: EdlProps): React.ReactElement {
  const { t } = useI18n();
  const { start, error } = useEdlStarter(props);
  const { operations, input, onChooseFile } = props;
  const choice = usePartitionChoice(operations);
  const [pad, setPad] = useState<"none" | "zero" | "ff">("none");
  const busy = operations.some((operation) => !isTerminalState(operation.state));
  const { name } = choice;
  const part = choice.partitions.find((entry) => entry.name === name);
  const advice = adviseFlash(name, choice.partitions, input?.size, pad, busy);
  return (
    <section aria-label={t("devices.edl.flashTitle")} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Notice>{t("devices.edl.flashIntro")}</Notice>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.edl.imageTitle")}</h4>
        <ChosenFile input={input} chosen={t("devices.edl.imageChosen", { name: input?.name ?? "", size: formatBytes(input?.size ?? 0) })} none={t("devices.edl.imageNone")} onChooseFile={onChooseFile} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h4 style={sectionHeadingStyle}>{t("devices.edl.flashPartitionTitle")}</h4>
        <PartitionPicker choice={choice} />
        {advice.level === "protected" && <Notice tone="warning">{t("devices.edl.classProtected", { name })}</Notice>}
        {advice.level === "refused" && <Notice tone="error" role="alert">{t("devices.edl.classRefused", { name })}</Notice>}
        {part && input && (advice.fit === "tooBig"
          ? <Notice tone="error" role="alert">{t("devices.edl.fitTooBig", { image: formatBytes(input.size), name, partition: formatBytes(part.bytes) })}</Notice>
          : advice.fit === "needsPad"
            ? <Notice tone="warning">{t("devices.edl.fitNeedsPad", { image: formatBytes(input.size), name, partition: formatBytes(part.bytes) })}</Notice>
            : <Notice>{t("devices.edl.fitExact", { name })}</Notice>)}
        <Segmented
          label={t("devices.edl.padTitle")}
          value={pad}
          onChange={setPad}
          options={[
            { value: "none", label: t("devices.edl.padNone") },
            { value: "zero", label: t("devices.edl.padZero") },
            { value: "ff", label: t("devices.edl.padFf") },
          ]}
        />
        <div>
          <Button tone="warning" disabled={!advice.canFlash} onClick={() => start({ action: "flash", target: name, ...(pad === "none" ? {} : { options: { pad } }) }, true)}>{t("devices.edl.flashStart")}</Button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 12, lineHeight: 1.4, color: "var(--text-dim)" }}>{t("devices.edl.eraseHint")}</span>
        <div>
          <Button tone="danger" disabled={busy || !name || advice.level === "refused"} onClick={() => start({ action: "exec", command: "erase", target: name }, false)}>{t("devices.edl.eraseStart")}</Button>
        </div>
      </div>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </section>
  );
}
