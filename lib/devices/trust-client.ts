/**
 * The page's copy of the devices this account remembers, and the only code that writes to the server's
 * per-account store (GET / PUT / DELETE `/api/devices/trust`, lib/devices/trust-store.ts).
 *
 * `remember` is called from exactly one place: the Allow answer in `DeviceOperationManager.answerTrust`, which the
 * chat card's button reaches. `forget` is called from a device card's Forget and from Settings. Nothing here is
 * reachable from a tool, a server frame or an operation option, and the server itself never grants anything: it
 * stores what an authenticated page asked it to.
 *
 * The list is read once when the page starts and again when a hidden tab comes back (a device forgotten on
 * another browser must stop being trusted here soon, not at the next reload). Until the first read settles the
 * trust gate waits on `ready` rather than ask about a device the person already remembered.
 */

import { parseTrustedDevice, type DeviceTrustBook, type TrustedDevice } from "./trust";

export const TRUST_ROUTE = "/api/devices/trust";

/** The longest the trust gate waits for the first read: a server that does not answer must not hang every operation. */
const FIRST_READ_TIMEOUT_MS = 4_000;
/** A returning tab re-reads the list no more often than this. */
const REFRESH_MIN_INTERVAL_MS = 30_000;

interface TrustListBody {
  devices?: unknown;
  error?: unknown;
}

function devicesFrom(body: TrustListBody | null): TrustedDevice[] | null {
  if (!body || !Array.isArray(body.devices)) return null;
  const devices: TrustedDevice[] = [];
  for (const entry of body.devices) {
    const stored = typeof entry === "object" && entry !== null ? (entry as { grantedAt?: unknown }) : null;
    const parsed = parseTrustedDevice(entry, typeof stored?.grantedAt === "number" ? stored.grantedAt : 0);
    if (parsed) devices.push(parsed);
  }
  return devices;
}

async function errorFrom(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as TrustListBody | null;
  return new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
}

export class ServerTrustBook implements DeviceTrustBook {
  readonly ready: Promise<void>;
  private devices = new Map<string, TrustedDevice>();
  private sorted: readonly TrustedDevice[] = [];
  private readonly listeners = new Set<() => void>();
  private refreshing: Promise<void> | undefined;
  private refreshedAt = 0;
  private writes = 0;
  /** Why the last read failed, for Settings to say; null once a read worked. */
  loadError: string | null = null;

  constructor(private readonly request: typeof fetch = (...args) => fetch(...args)) {
    this.ready = this.refresh();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - this.refreshedAt > REFRESH_MIN_INTERVAL_MS) void this.refresh();
      });
    }
  }

  has(key: string): boolean {
    return this.devices.has(key);
  }

  list(): readonly TrustedDevice[] {
    return this.sorted;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Re-reads the list. Never rejects: a failed read keeps what the page had and records why. */
  refresh(): Promise<void> {
    this.refreshing ??= this.read().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async remember(device: TrustedDevice): Promise<void> {
    await this.write(() => this.request(TRUST_ROUTE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: device.label, vendorId: device.vendorId, productId: device.productId, serialNumber: device.serialNumber }),
    }));
  }

  async forget(key: string): Promise<void> {
    await this.write(() => this.request(`${TRUST_ROUTE}?key=${encodeURIComponent(key)}`, { method: "DELETE" }));
  }

  private async read(): Promise<void> {
    const readsBefore = this.writes;
    try {
      const response = await this.request(TRUST_ROUTE, { cache: "no-store", signal: AbortSignal.timeout(FIRST_READ_TIMEOUT_MS) });
      if (!response.ok) throw await errorFrom(response);
      const devices = devicesFrom((await response.json().catch(() => null)) as TrustListBody | null);
      if (!devices) throw new Error("The server's list of trusted devices was not readable.");
      this.loadError = null;
      // A write that finished while this read was in flight is newer than what the read returned.
      if (this.writes === readsBefore) this.replace(devices);
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      this.notify();
    }
    this.refreshedAt = Date.now();
  }

  /** One write: the server answers with the list it now holds, which becomes the page's. A refusal throws and changes nothing. */
  private async write(send: () => Promise<Response>): Promise<void> {
    const response = await send();
    if (!response.ok) throw await errorFrom(response);
    const devices = devicesFrom((await response.json().catch(() => null)) as TrustListBody | null);
    if (!devices) throw new Error("The server's list of trusted devices was not readable.");
    this.writes += 1;
    this.loadError = null;
    this.replace(devices);
  }

  private replace(devices: readonly TrustedDevice[]): void {
    this.devices = new Map(devices.map((device) => [device.key, device]));
    this.sorted = [...devices].sort((left, right) => right.grantedAt - left.grantedAt);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The page's one trust book, created on first use. Outside a browser (server rendering, a test that imports the
 * default runner) there is no store to read, so the first read fails quietly and the book stays empty.
 */
export function pageTrustBook(): ServerTrustBook {
  const scope = globalThis as typeof globalThis & { __codyDeviceTrustBook?: ServerTrustBook };
  scope.__codyDeviceTrustBook ??= typeof window === "undefined"
    ? new ServerTrustBook(async () => { throw new Error("The trusted-device list is only available in a browser."); })
    : new ServerTrustBook();
  return scope.__codyDeviceTrustBook;
}
