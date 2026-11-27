// Shared by the wireless card tests: the states the card can be in, as the server would describe them. Not a test itself.
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const yes = async () => true;

export const tablet = {
  selectionId: "selection-1",
  label: "Samsung Galaxy Tab S9 Ultra (SM-X916B)",
  host: "192.168.100.123",
  connectPort: 37099,
  pairedAt: NOW - 86_400_000,
  lastConnectedAt: NOW - 600_000,
  clientName: "Cody on a rather long server name",
};

export const snapshot = (over = {}) => ({ sessionId: "s", supported: true, status: "unpaired", device: null, rootRequests: [], ...over });

/** What `useWirelessAdb` returns, with every action a no-op that succeeds. */
export const controller = (state, over = {}) => ({
  snapshot: state,
  loadError: null,
  busy: null,
  actionError: null,
  pair: yes,
  connect: yes,
  disconnect: yes,
  forget: yes,
  answerRoot: yes,
  ...over,
});

export const rootRequests = [
  { id: "r1", command: "getprop ro.product.model && printf '%s\\n' 'a-long-marker-to-check-command-wrapping-in-the-narrow-devices-panel'", elevated: true, requestedAt: NOW, expiresAt: Date.now() + 90_000, state: "pending" },
  { id: "r2", command: "id", elevated: true, requestedAt: NOW, expiresAt: Date.now() + 90_000, state: "approved" },
];

export const shellResult = {
  exitCode: 1,
  stdout: `model=SM-X916B\n${"a-long-output-line-without-spaces-".repeat(6)}`,
  stderr: "Read-only test output: <not an html element>",
};

export const states = {
  checking: controller(null),
  loadFailed: controller(null, { loadError: "The server answered 502." }),
  unsupported: controller(snapshot({ supported: false, reason: "adb is not installed on this server." })),
  unpaired: controller(snapshot()),
  pairingBusy: controller(snapshot({ status: "pairing" }), { busy: "pair" }),
  connecting: controller(snapshot({ status: "connecting", device: tablet })),
  connected: controller(snapshot({ status: "connected", device: tablet, rootRequests })),
  disconnected: controller(snapshot({ status: "disconnected", device: tablet })),
  offline: controller(snapshot({ status: "offline", device: tablet, error: { code: "unreachable", message: "Nothing answered at 192.168.100.123:37099." } })),
  needsPairing: controller(snapshot({ status: "needs-pairing", device: tablet }), { actionError: { action: "pair", message: "The tablet refused that pairing code." } }),
  stale: controller(snapshot({ status: "connected", device: tablet }), { loadError: "offline" }),
};
