"use client";

import type { DeviceInfo } from "@/lib/devices/protocol";
import type { DeviceOperationManager } from "@/lib/devices/operations";
import { DeviceTerminal } from "./DeviceTerminal";
import { ShellAccessControl } from "./ShellAccessControl";
import { FastbootCommand } from "./FastbootCommand";
import type { DeviceArtifact } from "@/lib/devices/artifacts";

export function DeviceTerminals({ manager, devices, input }: { manager: DeviceOperationManager | null; devices: readonly DeviceInfo[]; input?: DeviceArtifact }) {
  if (!manager) return null;
  return <>{devices.map((device) => {
    const candidates = device.protocolCandidates?.filter((candidate) => candidate.protocol === "adb") ?? [];
    const fastboot = device.protocolCandidates?.filter((candidate) => candidate.protocol === "fastboot") ?? [];
    if (!candidates.length && !fastboot.length) return null;
    return <div key={device.id} style={{ display: "grid", gap: 12 }}>
      {candidates.length > 0 && <ShellAccessControl manager={manager} deviceId={device.id} label={device.label} />}
      {candidates.map((candidate) => <DeviceTerminal key={candidate.interfaceNumber + ":" + candidate.alternateSetting} manager={manager} deviceId={device.id} label={device.label} interfaceNumber={candidate.interfaceNumber} alternateSetting={candidate.alternateSetting} />)}
      {fastboot.map((candidate) => <FastbootCommand key={candidate.interfaceNumber+":"+candidate.alternateSetting} manager={manager} deviceId={device.id} label={device.label} interfaceNumber={candidate.interfaceNumber} alternateSetting={candidate.alternateSetting} input={input} />)}
    </div>;
  })}</>;
}
