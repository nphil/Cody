"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Select } from "@/components/ui/Select";
import { deviceArtifacts } from "@/lib/devices/artifacts";
import type { HardwareAction, HardwareProtocol } from "@/lib/devices/flasher";
import type { DeviceOperationManager } from "@/lib/devices/operations";
import type { DeviceInfo } from "@/lib/devices/protocol";
import { flashOverrideChoices, formActions, type ActionGroup } from "@/lib/devices/ui-model";
import { useI18n } from "@/lib/i18n";
import { Button, Chip, Field, Notice, Segmented, TextField } from "./ui";

interface ActionFormProps {
  sessionId: string;
  manager: DeviceOperationManager;
  device: DeviceInfo;
  group: ActionGroup;
  protocols: readonly HardwareProtocol[];
  selectedInputId: string | null;
  /** Takes the user to the place where a file is chosen. */
  onChooseFile: () => void;
}

const ACTIONS_NEEDING_TARGET: readonly HardwareAction[] = ["flash", "dump", "push", "pull", "verify", "forward", "reverse"];
const ACTIONS_NEEDING_RANGE: readonly HardwareAction[] = ["flash", "dump", "verify"];
const ACTIONS_NEEDING_INPUT: readonly HardwareAction[] = ["flash", "push", "sideload", "verify", "install"];
/** Writes to the device, or can change what it does next: these get the cautious button. */
const RISKY_ACTIONS: readonly HardwareAction[] = ["flash", "push", "sideload", "forward", "reverse", "install"];
type AdbExecKind = "shell" | "root" | "unroot" | "tcpip" | "usb" | "wait-for-device";
const ADB_EXEC_KINDS: readonly AdbExecKind[] = ["shell", "root", "unroot", "tcpip", "usb", "wait-for-device"];
const INSTALL_OPTIONS = ["replace", "downgrade", "grantPermissions", "testOnly"] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetKeys(action: HardwareAction): { label: string; placeholder: string } {
  switch (action) {
    case "push":
    case "pull": return { label: "devices.fieldDevicePath", placeholder: "devices.fieldDevicePathPlaceholder" };
    case "forward": return { label: "devices.fieldForwardTarget", placeholder: "devices.fieldForwardTargetPlaceholder" };
    case "reverse": return { label: "devices.fieldReverseTarget", placeholder: "devices.fieldReverseTargetPlaceholder" };
    default: return { label: "devices.fieldPartition", placeholder: "devices.operationTargetPlaceholder" };
  }
}

/**
 * The one form behind every non-terminal action. It is told which group of
 * actions and which protocols it may offer; it shows a choice only when there
 * is more than one, and builds the request exactly as the old all-in-one
 * operation form did.
 */
export function ActionForm({ sessionId, manager, device, group, protocols, selectedInputId, onChooseFile }: ActionFormProps): React.ReactElement | null {
  const { t } = useI18n();
  const formId = useId();
  const usable = useMemo(() => protocols.filter((candidate) => formActions(group, candidate).length > 0), [group, protocols]);
  const [protocol, setProtocol] = useState<HardwareProtocol>(usable[0]);
  const [action, setAction] = useState<HardwareAction>(formActions(group, usable[0])[0]);
  const [target, setTarget] = useState("");
  const [offset, setOffset] = useState("");
  const [length, setLength] = useState("");
  const [command, setCommand] = useState("");
  const [expectedChip, setExpectedChip] = useState("");
  const [protectedOverride, setProtectedOverride] = useState("");
  const [host, setHost] = useState("");
  const [candidateKey, setCandidateKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installFlags, setInstallFlags] = useState<Record<string, boolean>>({});
  const [execKind, setExecKind] = useState<AdbExecKind>("shell");
  const [tcpPort, setTcpPort] = useState("");

  const activeProtocol = usable.includes(protocol) ? protocol : usable[0];
  const actions = formActions(group, activeProtocol);
  const activeAction = actions.includes(action) ? action : actions[0];
  const needsTarget = ACTIONS_NEEDING_TARGET.includes(activeAction);
  const needsHost = activeAction === "forward" || activeAction === "reverse";
  const needsRange = ACTIONS_NEEDING_RANGE.includes(activeAction);
  const needsCommand = activeAction === "exec";
  const inputRequired = ACTIONS_NEEDING_INPUT.includes(activeAction);
  const protocolCandidates = useMemo(() => device.protocolCandidates?.filter((candidate) => candidate.protocol === activeProtocol) ?? [], [activeProtocol, device]);
  const selectedCandidate = protocolCandidates.find((candidate) => `${candidate.interfaceNumber}:${candidate.alternateSetting}` === candidateKey);
  const input = selectedInputId ? deviceArtifacts.list(sessionId).find((artifact) => artifact.id === selectedInputId) : undefined;
  const commandUsesImage = activeProtocol === "fastboot" && activeAction === "exec" && /^(?:boot|download|stage|flash|update|flashall)(?:$|[:\s])/.test(command.trim().replace(/^fastboot\s+/, ""));
  const keys = targetKeys(activeAction);

  useEffect(() => {
    if (protocolCandidates.length === 1) {
      const [candidate] = protocolCandidates;
      setCandidateKey(`${candidate.interfaceNumber}:${candidate.alternateSetting}`);
      return;
    }
    if (!protocolCandidates.some((candidate) => `${candidate.interfaceNumber}:${candidate.alternateSetting}` === candidateKey)) setCandidateKey("");
  }, [candidateKey, protocolCandidates]);

  if (usable.length === 0) return null;

  const start = () => {
    try {
      if (protocolCandidates.length > 1 && !selectedCandidate) throw new Error(t("devices.operationInterfaceRequired"));
      if (inputRequired && !input) throw new Error(t("devices.operationInputRequired"));
      if (needsTarget && !target.trim()) throw new Error(t("devices.operationTargetRequired"));
      const kindOnly = activeProtocol === "adb" && activeAction === "exec" && execKind !== "shell";
      if (needsHost && !host.trim()) throw new Error(t("devices.operationHostAddressRequired"));
      if (needsCommand && !kindOnly && !command.trim()) throw new Error(t("devices.operationCommandRequired"));
      const parsedOffset = offset.trim() ? Number(offset) : undefined;
      const parsedLength = length.trim() ? Number(length) : activeAction === "verify" ? input?.size : undefined;
      for (const [value, label, minimum] of [[parsedOffset, "offset", 0], [parsedLength, "length", 1]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) throw new Error(`${label} must be a safe integer of at least ${minimum}.`);
      }
      if (activeAction === "dump" && (parsedOffset === undefined || parsedLength === undefined)) throw new Error(t("devices.operationRangeRequired"));
      const options: Record<string, string | number | boolean> = {};
      if (expectedChip.trim()) options.expectedChip = expectedChip.trim();
      if (protectedOverride) options.protectedOverride = protectedOverride;
      if (needsHost) options.local = host.trim();
      if (activeProtocol === "adb" && activeAction === "install") for (const [name, on] of Object.entries(installFlags)) if (on) options[name] = true;
      if (kindOnly) {
        options.kind = execKind;
        if (execKind === "tcpip") options.port = Number(tcpPort);
      }
      manager.startUser({
        deviceId: device.id,
        protocol: activeProtocol,
        action: activeAction,
        ...(selectedCandidate ? { interfaceNumber: selectedCandidate.interfaceNumber } : {}),
        ...(selectedCandidate ? { alternateSetting: selectedCandidate.alternateSetting } : {}),
        ...(needsTarget ? { target: target.trim() } : {}),
        ...(needsRange && parsedOffset !== undefined ? { offset: parsedOffset } : {}),
        ...(needsRange && parsedLength !== undefined ? { length: parsedLength } : {}),
        ...(needsCommand && !kindOnly ? { command: command.trim() } : {}),
        ...(input && (inputRequired || commandUsesImage) ? { fileId: input.id, sha256: input.sha256 } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      });
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const protocolOptions = usable.map((value) => ({ value, label: t(`devices.protocol.${value}`) }));
  const actionOptions = actions.map((value) => ({ value, label: t(`devices.action.${value}`) }));
  const risky = RISKY_ACTIONS.includes(activeAction);

  return (
    <form
      aria-label={t(`devices.action.${activeAction}`)}
      onSubmit={(event) => { event.preventDefault(); start(); }}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      {usable.length > 1 && (
        <Field label={t("devices.operationProtocol")}>
          {() => <Segmented label={t("devices.operationProtocol")} value={activeProtocol} options={protocolOptions} onChange={(next) => { setProtocol(next); setAction(formActions(group, next)[0]); }} />}
        </Field>
      )}
      {actions.length > 1 && (
        <Field label={t("devices.operationAction")}>
          {() => <Segmented label={t("devices.operationAction")} value={activeAction} options={actionOptions} onChange={setAction} />}
        </Field>
      )}
      <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>{t(`devices.actionHint.${activeAction}`)}</div>

      {protocolCandidates.length > 1 && (
        <Field label={t("devices.operationInterface")}>
          {() => (
            <Select
              aria-label={t("devices.operationInterface")}
              value={candidateKey || null}
              onChange={setCandidateKey}
              placeholder={t("devices.operationInterfaceRequired")}
              options={protocolCandidates.map((candidate) => ({ value: `${candidate.interfaceNumber}:${candidate.alternateSetting}`, label: t("devices.operationInterfaceTuple", { interfaceNumber: candidate.interfaceNumber, alternateSetting: candidate.alternateSetting }) }))}
            />
          )}
        </Field>
      )}

      {inputRequired && (
        input ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Chip tone="good">{t("devices.operationSelectedInput")}: {input.name}</Chip>
            <Button onClick={onChooseFile}>{t("devices.changeFile")}</Button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Notice tone="warning">{t("devices.operationInputRequired")}</Notice>
            <div><Button onClick={onChooseFile}>{t("devices.chooseFile")}</Button></div>
          </div>
        )
      )}

      {activeProtocol === "adb" && activeAction === "install" && (
        <div role="group" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {INSTALL_OPTIONS.map((name) => (
            <Button key={name} pressed={Boolean(installFlags[name])} onClick={() => setInstallFlags((current) => ({ ...current, [name]: !current[name] }))}>{t(`devices.installOption.${name}`)}</Button>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 10 }}>
        {needsTarget && <TextField id={`${formId}-target`} label={t(keys.label)} value={target} onChange={(event) => setTarget(event.target.value)} placeholder={t(keys.placeholder)} />}
        {needsHost && <TextField id={`${formId}-host`} label={t("devices.operationHostAddress")} value={host} onChange={(event) => setHost(event.target.value)} placeholder={t("devices.operationHostAddressPlaceholder")} />}
        {needsRange && <>
          <TextField id={`${formId}-offset`} label={t("devices.operationOffset")} type="number" min="0" inputMode="numeric" value={offset} onChange={(event) => setOffset(event.target.value)} />
          <TextField id={`${formId}-length`} label={t("devices.operationLength")} type="number" min="1" inputMode="numeric" value={length} onChange={(event) => setLength(event.target.value)} />
        </>}
        {needsCommand && activeProtocol === "adb" && (
          <Field label={t("devices.execKindLabel")}>
            {() => <Segmented label={t("devices.execKindLabel")} value={execKind} options={ADB_EXEC_KINDS.map((value) => ({ value, label: t(`devices.execKind.${value}`) }))} onChange={setExecKind} />}
          </Field>
        )}
        {needsCommand && !(activeProtocol === "adb" && execKind !== "shell") && <TextField id={`${formId}-command`} label={t("devices.operationCommand")} value={command} onChange={(event) => setCommand(event.target.value)} />}
        {needsCommand && activeProtocol === "adb" && execKind === "tcpip" && <TextField id={`${formId}-tcp-port`} label={t("devices.fieldTcpPort")} type="number" min="1024" max="65535" inputMode="numeric" value={tcpPort} onChange={(event) => setTcpPort(event.target.value)} placeholder="5555" />}
        {activeAction === "flash" && <>
          <TextField id={`${formId}-chip`} label={t("devices.operationExpectedChip")} value={expectedChip} onChange={(event) => setExpectedChip(event.target.value)} />
          <Field label={t("devices.operationProtectedOverride")}>
            {() => (
              <Select
                aria-label={t("devices.operationProtectedOverride")}
                value={protectedOverride || "none"}
                onChange={(value) => setProtectedOverride(value === "none" ? "" : value)}
                options={[
                  { value: "none", label: t("devices.none") },
                  ...flashOverrideChoices(activeProtocol).map((value) => (value === "allow-unknown"
                    ? { value, label: t("devices.operationUnknownOverride"), description: t("devices.operationUnknownOverrideDescription") }
                    : { value, label: value })),
                ]}
              />
            )}
          </Field>
        </>}
      </div>

      {error && <Notice tone="error" role="alert">{error}</Notice>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div><Button type="submit" tone={risky ? "warning" : "primary"}>{t(`devices.actionStart.${activeAction}`)}</Button></div>
        {(risky || activeAction === "dump") && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("devices.operationSetup")}</span>}
      </div>
    </form>
  );
}
