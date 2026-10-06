/**
 * Device trust: the one permission the person gives for a device, instead of an approval for every command.
 *
 * Before an agent operation (anything but read-only detection) touches a device the person has not trusted, the
 * page asks once, in the chat: "Let the agent control <device>?". Operations that arrive while the question is open
 * wait behind it. Allow runs them all; Deny fails them all and the agent is refused, without another question,
 * until the device is disconnected and connected again. A person who also ticks "Remember this device" is not asked
 * again for the same physical unit, in any USB mode (see `deviceTrustKey`).
 *
 * This module is pure and imports nothing from the page's protocol code, so the server half (the trust store and
 * its route) and the browser half (the operation manager, the chat card, Settings) share one vocabulary.
 *
 * What it deliberately does NOT contain is any way to grant trust. Trust is given in exactly one place: the
 * `answerTrust` call the chat card's Allow button makes (lib/devices/operations.ts). Nothing the agent can reach -
 * a tool, a frame from the server, an operation option - names that call.
 */

/** The longest label, serial number and key the store keeps; the route refuses more rather than clipping an identity. */
export const MAX_TRUST_LABEL_CHARS = 120;
export const MAX_TRUST_SERIAL_CHARS = 128;
/** How many remembered devices one account keeps. The least recently allowed is dropped to make room. */
export const MAX_TRUSTED_DEVICES = 100;

/** The prefix of every declined message: lets a notice recognise a refusal the person already knows about. */
export const DECLINED_MESSAGE_PREFIX = "The user declined control of ";

/** What the agent is told when the person said no. It is the whole instruction: do not ask again until a reconnect. */
export function declinedMessage(label: string): string {
  return `${DECLINED_MESSAGE_PREFIX}${label}; do not ask again until they reconnect it`;
}

/**
 * Why an operation the person had not allowed is cancelled when they withdraw the agent's control of its device
 * (Forget, on the device card or in Settings).
 */
export const TRUST_WITHDRAWN_REASON = "The agent's control of this device was withdrawn, so this operation was cancelled.";

/**
 * Which actions need the person's trust. Read-only detection does not: it identifies a device and the agent needs
 * that to ask for anything sensible. Everything else - a command, a file transfer, a flash, an erase, a terminal, a
 * port rule - is control of the device, and a new action is gated until someone decides it is not.
 */
export function actionNeedsTrust(action: string): boolean {
  return action !== "detect";
}

/**
 * The key a device is remembered under: its USB vendor id and serial number, and NOT the product id. One physical
 * unit enumerates under different product ids as it changes mode (adb, then fastboot, then recovery), so a key
 * that included the product id would ask again at every reboot into the bootloader. A device with no serial number
 * has no key: two boards of one model are not interchangeable, so it can be trusted for a connection but never
 * remembered (the same reason lib/devices/usb-identity.ts never adopts a device by vendor and product alone).
 */
export function deviceTrustKey(source: { vendorId?: number; serialNumber?: string | null }): string | null {
  const serial = source.serialNumber?.trim();
  if (!serial || serial.length > MAX_TRUST_SERIAL_CHARS) return null;
  const vendor = source.vendorId;
  if (vendor === undefined || !Number.isInteger(vendor) || vendor < 0 || vendor > 0xffff) return null;
  return `usb:${vendor.toString(16).padStart(4, "0")}:${serial}`;
}

/** A device the person chose to remember. What the server stores and Settings lists. */
export interface TrustedDevice {
  /** `deviceTrustKey` of the vendor id and serial number below. */
  key: string;
  /** What the person called it when they allowed it (the product string, or the vendor and product ids). */
  label: string;
  vendorId: number;
  /** The product id it had when it was allowed; it may differ in another mode and is not part of the key. */
  productId?: number;
  serialNumber: string;
  /** When the person allowed it, epoch milliseconds. */
  grantedAt: number;
}

/** What the page knows about a granted device when it has to ask about it. */
export interface DeviceTrustSubject {
  /** What the person calls it. */
  label: string;
  /** Present when the device has a stable USB identity: remembering is possible only then. */
  key?: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

/** One open question: "Let the agent control <label>?". At most one per device; further operations queue behind it. */
export interface DeviceTrustRequest {
  id: string;
  deviceId: string;
  label: string;
  /** Present when "Remember this device" can be offered. */
  key?: string;
  requestedAt: number;
  /** How many operations wait for the answer. */
  waiting: number;
}

/** The person's answer. `remember` is honoured only for a device with a stable identity. */
export interface DeviceTrustAnswer {
  allow: boolean;
  remember?: boolean;
}

/** `error` says why a remembered device could not be saved: the device is trusted for this connection all the same. */
export interface DeviceTrustAnswerResult {
  remembered: boolean;
  error?: string;
}

/** How far the person has trusted a device right now. `declined` means the agent is refused until a reconnect. */
export type DeviceTrustLevel = "remembered" | "session" | "declined" | "none";

/**
 * The list of remembered devices the manager consults. The page's implementation reads and writes the server's
 * per-account store; tests use `MemoryTrustBook`. `remember` is called only from the Allow answer.
 */
export interface DeviceTrustBook {
  /** Settles once the stored list has been read (or could not be), so a gate never decides on a half-loaded list. */
  readonly ready: Promise<void>;
  has(key: string): boolean;
  list(): readonly TrustedDevice[];
  remember(device: TrustedDevice): Promise<void>;
  forget(key: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** A trust book held in memory: the default for a manager built without one, and what tests use. */
export class MemoryTrustBook implements DeviceTrustBook {
  readonly ready: Promise<void> = Promise.resolve();
  private readonly devices = new Map<string, TrustedDevice>();
  private readonly listeners = new Set<() => void>();

  constructor(initial: readonly TrustedDevice[] = []) {
    for (const device of initial) this.devices.set(device.key, { ...device });
  }

  has(key: string): boolean {
    return this.devices.has(key);
  }

  list(): readonly TrustedDevice[] {
    return [...this.devices.values()].sort((left, right) => right.grantedAt - left.grantedAt).map((device) => ({ ...device }));
  }

  async remember(device: TrustedDevice): Promise<void> {
    this.devices.set(device.key, { ...device });
    this.notify();
  }

  async forget(key: string): Promise<void> {
    if (this.devices.delete(key)) this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The body of PUT /api/devices/trust, checked by the route and built by the page. Null when it is not acceptable. */
export function parseTrustedDevice(value: unknown, now: number = Date.now()): TrustedDevice | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { vendorId, productId, serialNumber, label } = record;
  if (typeof vendorId !== "number" || typeof serialNumber !== "string" || typeof label !== "string") return null;
  if (productId !== undefined && (typeof productId !== "number" || !Number.isInteger(productId) || productId < 0 || productId > 0xffff)) return null;
  const key = deviceTrustKey({ vendorId, serialNumber });
  // The key is derived here, never taken from the caller: a client cannot file trust under an identity it did not name.
  if (key === null || (record.key !== undefined && record.key !== key)) return null;
  const name = label.replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_TRUST_LABEL_CHARS) return null;
  return {
    key,
    label: name,
    vendorId,
    ...(productId === undefined ? {} : { productId }),
    serialNumber: serialNumber.trim(),
    grantedAt: now,
  };
}
