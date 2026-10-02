"use client";

import type { DeviceInfo } from "@/lib/devices/protocol";
import type { DeviceOperationManager } from "@/lib/devices/operations";
import { DeviceTerminal } from "./DeviceTerminal";
import { ShellAccessControl } from "./ShellAccessControl";

export function DeviceTerminals({ manager, devices }: { manager: DeviceOperationManager | null; devices: readonly DeviceInfo[] }) {
  if (!manager) return null;
  return <>{devices.map((device) => {
    const candidates = device.protocolCandidates?.filter((candidate) => candidate.protocol === "adb") ?? [];
    if (!candidates.length) return null;
    return <div key={device.id} style={{ display: "grid", gap: 12 }}>
      <ShellAccessControl manager={manager} deviceId={device.id} label={device.label} />
      {candidates.map((candidate) => <DeviceTerminal key={candidate.interfaceNumber + ":" + candidate.alternateSetting} manager={manager} deviceId={device.id} label={device.label} interfaceNumber={candidate.interfaceNumber} alternateSetting={candidate.alternateSetting} />)}
    </div>;
  })}</>;
}
