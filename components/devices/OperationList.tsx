"use client";

import { useEffect, useState } from "react";
import type { DeviceOperationManager, DeviceOperationSnapshot, OperationState } from "@/lib/devices/operations";

export function isTerminalState(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** Every operation the manager remembers for this session, kept current while mounted. */
export function useOperations(manager: DeviceOperationManager | null): readonly DeviceOperationSnapshot[] {
  const [operations, setOperations] = useState<readonly DeviceOperationSnapshot[]>(() => manager?.snapshots() ?? []);
  useEffect(() => {
    if (!manager) {
      setOperations([]);
      return;
    }
    const sync = () => setOperations(manager.snapshots());
    sync();
    return manager.subscribe(sync);
  }, [manager]);
  return operations;
}
