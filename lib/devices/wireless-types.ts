/**
 * What the browser and the server agree on for wireless ADB (Android's "Wireless debugging"), one tablet per chat.
 *
 * Browser-safe: types and plain constants only, no Node imports, so the Devices panel can import it. The server routes
 * (`/api/devices/wireless`) answer with `WirelessSnapshot` and take `WirelessAction`. No response holds a pairing
 * code: it travels once, in the body of a `pair` action, and is neither stored, echoed nor logged.
 */

/**
 * Where the one tablet of this chat stands, as the server knows it (not as the browser's USB bridge does):
 * - `unpaired`: nothing is stored; the pairing form is the way in.
 * - `pairing`: a pairing code is being checked.
 * - `connecting`: paired, and the server is reaching the tablet now (also what an automatic reconnect looks like).
 * - `connected`: the tablet answers; ADB commands can run.
 * - `disconnected`: the person disconnected it; Cody will not reconnect until asked.
 * - `offline`: paired, but the tablet did not answer (asleep, off the network, Wireless debugging off, or its port changed).
 * - `needs-pairing`: the tablet refused the stored identity, usually because it was forgotten on the tablet.
 */
export type WirelessStatus = "unpaired" | "pairing" | "connecting" | "connected" | "disconnected" | "offline" | "needs-pairing";

/** The paired tablet. `host` and `connectPort` are the connection address; the pairing port is never kept. */
export interface WirelessDevice {
  /** Short-lived, opaque version of the tablet/connection the page is displaying. Never a pairing ID. */
  readonly selectionId: string;
  /** Name to show: the model when known, otherwise the address. */
  readonly label: string;
  readonly host: string;
  /** The port on the main Wireless debugging screen. It changes each time Wireless debugging is switched off and on. */
  readonly connectPort: number;
  readonly pairedAt: number;
  readonly lastConnectedAt?: number;
  /** The name Android lists under "Paired devices" for this Cody server, when known, so it can be found there to forget. */
  readonly clientName?: string;
}

/**
 * An exact shell command that only runs after the person approves it. An approval covers this command once,
 * on this connection, before `expiresAt`. An approved elevated command may still be waiting for Magisk on Android.
 */
export interface WirelessRootRequest {
  readonly id: string;
  readonly command: string;
  readonly elevated: boolean;
  readonly reason?: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly state: "pending" | "approved";
}

export interface WirelessFailure {
  /** Machine-readable (`wrong_code`, `unreachable`, `invalid_host`, ...); the UI never branches on anything else. */
  readonly code: string;
  /** One plain sentence, never containing a pairing code. */
  readonly message: string;
}

export interface WirelessSnapshot {
  readonly sessionId: string;
  /** False when this server cannot do wireless ADB at all (no adb in the image); `reason` says why. */
  readonly supported: boolean;
  readonly reason?: string;
  readonly status: WirelessStatus;
  readonly device: WirelessDevice | null;
  /** The last thing that went wrong with this tablet, cleared by the next success. */
  readonly error?: WirelessFailure;
  readonly rootRequests: readonly WirelessRootRequest[];
}

/** The one POST body of `/api/devices/wireless`. Answered with the new `WirelessSnapshot`; a refusal is `{error, code}`. */
export type WirelessAction =
  | { readonly action: "pair"; readonly sessionId: string; readonly host: string; readonly pairingPort: number; readonly connectPort: number; readonly code: string }
  /** No endpoint: reconnect to the stored one. With `host`/`connectPort`: the same paired tablet at a new address (its port changed). */
  | { readonly action: "connect"; readonly sessionId: string; readonly selectionId: string; readonly host?: string; readonly connectPort?: number }
  | { readonly action: "disconnect"; readonly sessionId: string; readonly selectionId: string }
  /** Revoke: delete Cody's pairing credentials. Remove its Paired devices entry on Android too. */
  | { readonly action: "forget"; readonly sessionId: string; readonly selectionId: string }
  /** Page-only (a request with an Authorization header is refused): approve or refuse one exact command. */
  | { readonly action: "root"; readonly sessionId: string; readonly selectionId: string; readonly requestId: string; readonly decision: "approve" | "deny" };

export interface WirelessShellAction {
  readonly sessionId: string;
  readonly selectionId: string;
  readonly command: string;
  readonly rootCapableConfirmed: true;
}

/** Read-only operations that don't transfer a file. Transfers require agentPull or agentPush. */
export type WirelessAgentOperation =
  | { readonly kind: "inspect"; readonly query: "identity" | "properties" | "battery" | "storage" | "memory" | "display" | "uptime" | "processes" | "packages"; readonly filter?: string }
  | { readonly kind: "logcat"; readonly buffer?: "main" | "system" | "crash" | "events"; readonly lines?: number; readonly tag?: string; readonly priority?: "V" | "D" | "I" | "W" | "E" | "F" }
  | { readonly kind: "list" | "stat"; readonly path: string };

export interface WirelessCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface WirelessApprovalResult {
  readonly state: "pending" | "approved" | "denied" | "expired" | "cancelled" | "finished";
  readonly result?: WirelessCommandResult;
  readonly error?: WirelessFailure;
}

export const WIRELESS_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const WIRELESS_MAX_COMMAND_CHARS = 2048;

/** How long the pairing code Android shows stays valid is up to Android; the form never keeps it past one attempt. */
export const WIRELESS_PAIRING_CODE_LENGTH = 6;
