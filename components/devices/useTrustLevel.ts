"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { DeviceOperationManager } from "@/lib/devices/operations";
import type { DeviceTrustLevel } from "@/lib/devices/trust";

/** How far the person has let the agent control `deviceId` right now, kept current while mounted. No manager means no trust. */
export function useTrustLevel(manager: DeviceOperationManager | null, deviceId: string): DeviceTrustLevel {
  const subscribe = useCallback((listener: () => void) => (manager ? manager.subscribeTrust(listener) : () => {}), [manager]);
  const read = useCallback((): DeviceTrustLevel => (manager ? manager.trustLevel(deviceId) : "none"), [manager, deviceId]);
  return useSyncExternalStore(subscribe, read, read);
}
