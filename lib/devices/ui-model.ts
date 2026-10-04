/**
 * What the Devices panel offers for a device, decided in one place.
 *
 * The panel is organised as connect -> device -> actions for that device's
 * mode. This file is the only table that says which hardware actions belong
 * to which action group and which protocols a granted device can speak. It is
 * deliberately pure (no React, no browser APIs) so the invariant that matters
 * is testable: every action any shipped flasher declares is reachable from
 * exactly one group.
 */

import { adbFlasher } from "./adb";
import { dfuFlasher } from "./dfu";
import { espFlasher } from "./esp";
import { fastbootFlasher } from "./fastboot";
import type { HardwareAction, HardwareProtocol } from "./flasher";
import { geckoFlasher } from "./gecko";
import { PROTECTED_REGION_OVERRIDES, type ProtectedRegionOverride } from "./hardware-safety";
import type { DeviceInfo, DeviceProtocolCandidate } from "./protocol";
import { serialFlasher } from "./serial-monitor";
import { stk500Flasher } from "./stk500";
import { stm32Flasher } from "./stm32";

export const SHIPPED_FLASHERS = [serialFlasher, espFlasher, adbFlasher, fastbootFlasher, geckoFlasher, stm32Flasher, stk500Flasher, dfuFlasher] as const;

/** The same protocol declarations used by the page operation delegate. */
export const ACTIONS_BY_PROTOCOL = Object.fromEntries(SHIPPED_FLASHERS.map((flasher) => [
  flasher.protocol,
  flasher.actions,
])) as Readonly<Record<HardwareProtocol, readonly HardwareAction[]>>;

export const ALL_PROTOCOLS = Object.keys(ACTIONS_BY_PROTOCOL).filter((protocol) => ACTIONS_BY_PROTOCOL[protocol as HardwareProtocol].length > 0) as HardwareProtocol[];

/** The groups of actions a device card can show, in tab order. */
export type ActionGroup = "overview" | "terminal" | "commands" | "serial" | "files" | "flash" | "backup" | "ports";

export const GROUP_ORDER: readonly ActionGroup[] = ["overview", "terminal", "commands", "serial", "files", "flash", "backup", "ports"];

/**
 * Which `(protocol, action)` pairs live under which group. `detect` is the
 * Overview ("Identify"). `monitor` is the interactive terminal / serial
 * monitor, which the card renders as a real terminal rather than a form.
 */
const GROUP_ACTIONS: Readonly<Record<ActionGroup, Readonly<Partial<Record<HardwareProtocol, readonly HardwareAction[]>>>>> = {
  overview: { esp: ["detect"], adb: ["detect"], fastboot: ["detect"], gecko: ["detect"], stm32: ["detect"], stk500: ["detect"], dfu: ["detect"] },
  terminal: { adb: ["monitor", "exec"] },
  commands: { fastboot: ["exec"], dfu: ["exec"], esp: ["exec"] },
  serial: { serial: ["monitor", "exec"] },
  files: { adb: ["push", "pull", "sideload", "install"] },
  flash: { esp: ["flash"], fastboot: ["flash"], dfu: ["flash"], stm32: ["flash"], stk500: ["flash"] },
  backup: { esp: ["dump"], adb: ["dump", "verify"], fastboot: ["dump"], dfu: ["dump"], stm32: ["dump"], stk500: ["dump"] },
  ports: { adb: ["forward", "reverse"] },
};

/** Every `(protocol, action)` pair a group exposes, as declared by the flashers. */
export function groupActions(group: ActionGroup, protocol: HardwareProtocol): readonly HardwareAction[] {
  const wanted = GROUP_ACTIONS[group][protocol] ?? [];
  return wanted.filter((action) => ACTIONS_BY_PROTOCOL[protocol].includes(action));
}

/** Actions the card renders as a terminal or a dedicated command box instead of a generic form. */
export const TERMINAL_COVERED: Readonly<Partial<Record<HardwareProtocol, readonly HardwareAction[]>>> = {
  adb: ["monitor"],
  serial: ["monitor"],
  fastboot: ["exec"],
};

/** Protocols a UART-attached chip can speak: a plain monitor plus the ROM/bootloader flashers. */
const SERIAL_PROTOCOLS: readonly HardwareProtocol[] = ["serial", "esp", "stm32", "stk500", "gecko"];

export type DeviceModeId = "adb" | "fastboot" | "dfu" | "serial" | "unknown-usb" | "ble";

export interface DeviceMode {
  id: DeviceModeId;
  /** Protocols this device can be driven with, in the order they are offered. */
  protocols: readonly HardwareProtocol[];
}

function candidateProtocols(candidates: readonly DeviceProtocolCandidate[] | undefined): HardwareProtocol[] {
  const found = new Set<HardwareProtocol>();
  for (const candidate of candidates ?? []) {
    if (candidate.protocol === "serial") for (const protocol of SERIAL_PROTOCOLS) found.add(protocol);
    else found.add(candidate.protocol);
  }
  return [...found];
}

/**
 * The mode a granted device is in, from what the browser can see (the USB
 * interface descriptors), not from a handshake. A device whose descriptors
 * match nothing Cody knows is `unknown-usb`; its owner can still reach every
 * protocol through the card's "all protocols" switch.
 */
export function deviceMode(device: Pick<DeviceInfo, "kind" | "protocolCandidates">): DeviceMode {
  if (device.kind === "ble") return { id: "ble", protocols: [] };
  const fromDescriptors = candidateProtocols(device.protocolCandidates);
  if (device.kind === "serial") {
    const protocols = new Set<HardwareProtocol>([...SERIAL_PROTOCOLS, ...fromDescriptors]);
    return { id: "serial", protocols: [...protocols] };
  }
  if (fromDescriptors.length === 0) return { id: "unknown-usb", protocols: [] };
  const first = device.protocolCandidates![0].protocol;
  const id: DeviceModeId = first === "serial" ? "serial" : first;
  return { id, protocols: fromDescriptors };
}

/** The protocols the card offers: the mode's own, or every shipped protocol when asked (or when the mode is not recognised). */
export function offeredProtocols(mode: DeviceMode, showAll: boolean): readonly HardwareProtocol[] {
  return showAll || (mode.id === "unknown-usb") ? ALL_PROTOCOLS : mode.protocols;
}

/** The groups with something to do for these protocols. Overview is always present. */
export function availableGroups(protocols: readonly HardwareProtocol[]): ActionGroup[] {
  return GROUP_ORDER.filter((group) => group === "overview" || protocols.some((protocol) => groupActions(group, protocol).length > 0));
}

/** The actions a generic form needs to offer for a group and protocol: everything except what a terminal or command box already covers. */
export function formActions(group: ActionGroup, protocol: HardwareProtocol): readonly HardwareAction[] {
  const covered = TERMINAL_COVERED[protocol] ?? [];
  return groupActions(group, protocol).filter((action) => !covered.includes(action));
}

/**
 * Protocols whose flash is addressed by a name Cody cannot always tie to a
 * role: a Fastboot partition, or a plain DFU 1.1 alternate. Both are refused
 * unless the user types `allow-unknown`, so the form must offer it for exactly
 * these protocols - a choice the user needs but is not shown is a dead end.
 */
const UNNAMED_ROLE_FLASH_PROTOCOLS: readonly HardwareProtocol[] = ["fastboot", "dfu"];

/** The typed overrides the flash form lets the user pick for a protocol, in the order they are listed. */
export function flashOverrideChoices(protocol: HardwareProtocol): readonly ProtectedRegionOverride[] {
  const named = (Object.keys(PROTECTED_REGION_OVERRIDES) as Array<keyof typeof PROTECTED_REGION_OVERRIDES>)
    .filter((kind) => kind !== "unknown")
    .map((kind) => PROTECTED_REGION_OVERRIDES[kind]);
  return UNNAMED_ROLE_FLASH_PROTOCOLS.includes(protocol) ? [...named, PROTECTED_REGION_OVERRIDES.unknown] : named;
}

/** Reads the ADB banner prefix (`device::`, `recovery::`, `sideload::`, ...) a detect result reports. */
export function adbBannerState(banner: unknown): "device" | "recovery" | "sideload" | "bootloader" | "host" | null {
  if (typeof banner !== "string") return null;
  const match = /^(device|recovery|sideload|bootloader|host)::/.exec(banner);
  return match ? (match[1] as "device" | "recovery" | "sideload" | "bootloader" | "host") : null;
}
