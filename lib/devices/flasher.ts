import type { TunnelChannel } from "./tunnel";

/** Page-side protocol boundary. A transport is an exclusive session/device lease,
 * not a fresh connection per packet. Implementations must never retry writes
 * implicitly: a lost acknowledgement makes completion unknown. */
export type HardwareProtocol = "esp" | "adb" | "fastboot" | "gecko" | "stm32" | "stk500" | "dfu" | "serial";
export type HardwareAction = "detect" | "flash" | "dump" | "exec" | "push" | "pull" | "monitor" | "sideload" | "verify" | "forward" | "reverse" | "install";

export interface HardwareRequest {
  protocol: HardwareProtocol;
  action: HardwareAction;
  target?: string;
  offset?: number;
  length?: number;
  command?: string;
  /** Blob reference resolved by the operation owner, never base64 firmware. */
  fileId?: string;
  sha256?: string;
  baudRate?: number;
  /** Explicit protocol parameters, validated by the selected implementation. */
  options?: Record<string, unknown>;
}

export interface HardwareProgress {
  phase: string;
  completed?: number;
  total?: number;
  message?: string;
}

export interface HardwareTransport {
  kind: "serial" | "usb";
  /** A quiet read returns null. Cancellation rejects; late bytes stay owned by
   * this transport instead of an abandoned Promise.race consuming them. */
  read(length: number, timeoutMs: number, signal: AbortSignal): Promise<Uint8Array | null>;
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  setBaudRate?(baudRate: number, signal?: AbortSignal): Promise<void>;
  setSignals?(signals: { dtr?: boolean; rts?: boolean; brk?: boolean }, signal?: AbortSignal): Promise<void>;
  controlIn?(setup: USBControlTransferParameters, length: number, signal: AbortSignal): Promise<Uint8Array>;
  controlOut?(setup: USBControlTransferParameters, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** USB port reset (`dfu-util -R`); the device may re-enumerate. */
  reset?(signal: AbortSignal): Promise<void>;
  /** Browser bridge observation after a reset failure. False proves a disconnect. */
  connected?(): boolean;
  /** esptool-js owns the reader while borrowed; the console pump is suspended. */
  serialPort?: SerialPort;
  interfaceNumber?: number;
  /** Exact active USB alternate setting, selected from a descriptor candidate. */
  alternateSetting?: number;
  /** Descriptor-derived DFU alternate identity; never caller-provided options. */
  dfu?: {
    interfaceNumber: number;
    alternateSetting: number;
    alternateName?: string;
  };
}

export interface HardwareResult {
  summary: string;
  verified?: boolean;
  sha256?: string;
  fileId?: string;
  details?: Record<string, unknown>;
}

export interface StreamArtifact { fileId: string; sha256: string; length: number; }

export interface HardwareContext {
  transport: HardwareTransport;
  signal: AbortSignal;
  progress: (event: HardwareProgress) => void;
  /** Browser-owned permission; never read from agent-supplied options. */
  shellAccess?: () => boolean;
  output?: (text: string) => void;
  /** Installs protocol-framed input for a live terminal. */
  setTerminalInput?: (send: ((bytes: Uint8Array) => Promise<void>) | undefined) => void;
  /** Firmware resolved within this operation's session, hash-checked before use. */
  input?: Blob;
  /** Produces a session-scoped downloadable file and returns its opaque id. */
  save: (name: string, data: Blob) => Promise<string>;
  saveStream?: (name: string, chunks: AsyncIterable<Uint8Array>) => Promise<StreamArtifact>;
  /**
   * Explicit recovery after the caller verified a safe resume point. It never
   * retries a write. `deadline` (an absolute time) bounds how long the same
   * device is awaited; without one the runner applies its own limit.
   */
  reacquireTransport?: (options?: { deadline?: number }) => Promise<HardwareTransport>;
  /**
   * For an operation that is about to make the device restart its own daemon: the
   * device will leave the USB bus on purpose, so the runner must not treat that
   * one disconnect as a reason to cancel this operation. Returns a function that
   * ends the exception; it also ends by itself after `windowMs`. Shell access is
   * revoked by the disconnect all the same, and only the same device identity may
   * come back.
   */
  expectDeviceRestart?: (windowMs: number) => () => void;
  /** The absolute time at which a bounded wait gives up, counted from when the operation began waiting (so it covers lease acquisition). */
  deadline?: number;
  /** The durable operation running this protocol: identity for relay rules. */
  operation?: { id: string; deviceId: string };
  /** Browser-to-server relay for port forwarding; absent when no relay is attached. */
  tunnels?: TunnelChannel;
  /** Request point-of-risk approval. Bound to the exact destination and digest;
   * protocols call this before every destructive action, including shell exec. */
  confirm: (risk: HardwareRisk) => Promise<void>;
}

export interface HardwareRisk {
  action: string;
  target: string;
  /** Original requested payload identity and byte range. */
  sha256?: string;
  offset?: number;
  length?: number;
  /** Full final image and erase/program footprint when read-modify-write widens it. */
  programSha256?: string;
  programOffset?: number;
  programLength?: number;
  /** Exact command, script, or protocol action presented at confirmation. */
  details?: string;
  protectedOverride?: string;
  /** Escrow location, or why this device cannot supply a readable backup. */
  backup: string;
}

export interface Flasher {
  protocol: HardwareProtocol;
  actions: readonly HardwareAction[];
  run: (request: HardwareRequest, context: HardwareContext) => Promise<HardwareResult>;
}
