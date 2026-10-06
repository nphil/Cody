import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { allowAgent, denyAgent, flush, untilTrustRequest } from "./trust.test-helper.mjs";

/**
 * The one permission per device. These tests run the real operation manager against fake devices and pin what the
 * person is promised: an agent operation on an untrusted device raises ONE question however many operations arrive,
 * the operations wait behind it and touch nothing, Allow runs them all, Deny fails them all and the agent is not
 * asked about again until the device is reconnected, a remembered device is recognised by vendor id and serial number
 * in any USB mode, and trust is written only by the Allow answer that asked for it.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceOperationManager } = await jiti.import("./operations.ts");
const { MemoryTrustBook, TRUST_WITHDRAWN_REASON, deviceTrustKey } = await jiti.import("./trust.ts");

const GOOGLE = 0x18d1;
const DEVICES = {
  "usb-adb": { label: "Pixel 8", vendorId: GOOGLE, productId: 0x4ee7, serialNumber: "SER-1" },
  "usb-fastboot": { label: "Pixel 8", vendorId: GOOGLE, productId: 0x4ee0, serialNumber: "SER-1" },
  "usb-other": { label: "Second Pixel", vendorId: GOOGLE, productId: 0x4ee7, serialNumber: "SER-2" },
  "usb-bare": { label: "Mystery board", vendorId: 0x1234, productId: 0x0001 },
};

/** What the page's `describeDevice` answers for a granted device: its name, and the key when it has a serial number. */
function subjectFor(deviceId) {
  const device = DEVICES[deviceId];
  if (!device) return undefined;
  const key = deviceTrustKey(device);
  return { ...device, ...(key === null ? {} : { key }) };
}

const FIRMWARE = new Blob(["firmware"]);
const DIGEST = Buffer.from(await crypto.subtle.digest("SHA-256", await FIRMWARE.arrayBuffer())).toString("hex");

/** One valid request for every action, so the gate can be asked about all of them. */
const BY_ACTION = {
  detect: {},
  exec: { command: "getvar product" },
  flash: { target: "boot_a", fileId: "firmware", sha256: DIGEST },
  dump: { target: "boot_a" },
  push: { target: "/sdcard/a.bin", fileId: "firmware", sha256: DIGEST },
  pull: { target: "/sdcard/a.bin" },
  sideload: { fileId: "firmware", sha256: DIGEST },
  install: { fileId: "firmware", sha256: DIGEST },
  verify: { target: "boot_a", length: 4, sha256: DIGEST },
  monitor: {},
  forward: { target: "tcp:8080", options: { local: "tcp:9000" } },
  reverse: { target: "tcp:8080", options: { local: "tcp:9000" } },
};

const request = (over = {}) => ({ deviceId: "usb-adb", protocol: "fastboot", action: "exec", command: "getvar product", ...over });
const actionRequest = (action, deviceId = "usb-adb") => ({ deviceId, protocol: "fastboot", action, ...BY_ACTION[action] });

function rig({ book = new MemoryTrustBook() } = {}) {
  const state = { borrows: 0, releases: 0, ran: [], inputRead: 0, writes: [], typed: [] };
  const provider = {
    async borrowHardwareTransport(deviceId) {
      if (!DEVICES[deviceId]) throw new Error(`Unknown device ${deviceId}.`);
      state.borrows += 1;
      return {
        transport: { kind: "usb", async read() { return null; }, async write() {}, connected: () => true },
        identity: `usb:${deviceId}`,
        async release() { state.releases += 1; },
      };
    },
    describeDevice: subjectFor,
  };
  const flasher = {
    protocol: "fastboot",
    actions: Object.keys(BY_ACTION),
    async run(operation, context) {
      state.ran.push(`${operation.deviceId}:${operation.action}${operation.command ? `:${operation.command}` : ""}`);
      if (operation.action !== "detect") {
        await context.confirm({ action: `fastboot ${operation.action}`, target: operation.target ?? operation.command ?? operation.action, backup: "Not applicable." });
      }
      if (operation.action === "monitor") {
        context.setTerminalInput(async (bytes) => { state.typed.push(new TextDecoder().decode(bytes)); });
        await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
      }
      return { summary: `${operation.action} done` };
    },
  };
  const remember = book.remember.bind(book);
  book.remember = async (device) => { state.writes.push(device); await remember(device); };
  const manager = new DeviceOperationManager(
    "session-a",
    provider,
    { async getInput() { state.inputRead += 1; return FIRMWARE; }, async save() { return "artifact"; } },
    [flasher],
    book,
  );
  return { manager, state, book };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
async function finished(manager, id) {
  for (let turn = 0; turn < 100; turn += 1) {
    const snapshot = manager.status(id);
    if (TERMINAL.has(snapshot.state)) return snapshot;
    await flush(2);
  }
  throw new Error(`operation ${id} never finished (${manager.status(id).state})`);
}

async function inState(manager, id, state) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (manager.status(id).state === state) return manager.status(id);
    await flush(2);
  }
  throw new Error(`operation ${id} is ${manager.status(id).state}, not ${state}`);
}

const declined = (label) => `The user declined control of ${label}; do not ask again until they reconnect it`;

test("the first agent operation on an untrusted device asks once, and nothing reaches the device until the person answers", async () => {
  const { manager, state } = rig();
  const changes = [];
  manager.subscribeTrust(() => changes.push(manager.trustRequests().length));
  const { id } = manager.start(request());
  const asked = await untilTrustRequest(manager, "usb-adb");

  assert.equal(manager.status(id).state, "awaiting-trust");
  assert.deepEqual({ label: asked.label, waiting: asked.waiting, key: asked.key }, { label: "Pixel 8", waiting: 1, key: deviceTrustKey({ vendorId: GOOGLE, serialNumber: "SER-1" }) });
  assert.equal(manager.trustLevel("usb-adb"), "none");
  await flush();
  assert.equal(state.borrows, 0, "the device connection was not even opened");
  assert.equal(state.inputRead, 0);
  assert.deepEqual(state.ran, [], "no flasher ran");

  const result = await manager.answerTrust(asked.id, { allow: true });
  assert.deepEqual(result, { remembered: false });
  const done = await finished(manager, id);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(state.ran, ["usb-adb:exec:getvar product"]);
  assert.deepEqual(manager.trustRequests(), [], "the question is gone once answered");
  assert.equal(manager.trustLevel("usb-adb"), "session", "allowed for this connection only: not remembered unless asked");
  assert.equal(changes[0], 1, "subscribers hear the question open");
  assert.equal(changes.at(-1), 0, "and close");
});

test("operations that arrive while the question is open queue behind it: one question, and Allow runs every one of them", async () => {
  const { manager, state } = rig();
  const ids = [
    manager.start(request({ command: "getvar one" })).id,
    manager.start(actionRequest("flash")).id,
    manager.start(request({ command: "reboot" })).id,
    manager.start(actionRequest("dump")).id,
    manager.start(request({ command: "getvar five" })).id,
  ];
  await untilTrustRequest(manager, "usb-adb");
  await flush();
  assert.equal(manager.trustRequests().length, 1, "five operations, one question");
  assert.equal(manager.trustRequests()[0].waiting, 5);
  for (const id of ids) assert.equal(manager.status(id).state, "awaiting-trust", id);
  assert.equal(state.borrows, 0);

  await allowAgent(manager);
  for (const id of ids) assert.equal((await finished(manager, id)).state, "succeeded", id);
  assert.deepEqual([...state.ran].sort(), ["usb-adb:dump", "usb-adb:exec:getvar five", "usb-adb:exec:getvar one", "usb-adb:exec:reboot", "usb-adb:flash"]);
  assert.deepEqual(manager.trustRequests(), []);

  const later = manager.start(request({ command: "getvar later" }));
  assert.equal((await finished(manager, later.id)).state, "succeeded");
  assert.deepEqual(manager.trustRequests(), [], "a trusted device is not asked about again");
});

test("Deny fails every queued operation with the same sentence, touches nothing, and the agent is not asked again until the device is reconnected", async () => {
  const { manager, state } = rig();
  const ids = [manager.start(request()).id, manager.start(actionRequest("flash")).id, manager.start(actionRequest("monitor")).id];
  const result = await denyAgent(manager);
  assert.deepEqual(result, { remembered: false });
  for (const id of ids) {
    const failed = await finished(manager, id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, declined("Pixel 8"), "the whole instruction the agent needs");
  }
  assert.equal(state.borrows, 0);
  assert.deepEqual(state.ran, []);
  assert.deepEqual(manager.trustRequests(), []);
  assert.equal(manager.trustLevel("usb-adb"), "declined");

  // Asking again - however it is phrased - is refused on the spot, and nothing is shown to the person.
  for (const again of [request({ command: "id" }), actionRequest("flash"), actionRequest("pull"), request({ options: { allow: true, trusted: true } })]) {
    const refused = manager.start(again);
    assert.equal((await finished(manager, refused.id)).error, declined("Pixel 8"));
  }
  assert.deepEqual(manager.trustRequests(), [], "a refused agent raises no new question");
  assert.equal(state.borrows, 0);

  // Another device is not affected by this refusal.
  const other = manager.start(request({ deviceId: "usb-other" }));
  assert.equal((await untilTrustRequest(manager, "usb-other")).label, "Second Pixel");
  manager.cancel(other.id);

  // Disconnecting and connecting the device again is what lets the agent ask once more.
  await manager.deviceDisconnected("usb-adb");
  assert.equal(manager.trustLevel("usb-adb"), "none");
  const reconnected = manager.start(request({ command: "getvar after" }));
  const asked = await untilTrustRequest(manager, "usb-adb");
  assert.equal(asked.waiting, 1, "asked afresh");
  await manager.answerTrust(asked.id, { allow: true });
  assert.equal((await finished(manager, reconnected.id)).state, "succeeded");
});

test("the person's own operations are never asked about, and a refusal of the agent does not stop them", async () => {
  const { manager, state } = rig();
  const mine = manager.startUser(actionRequest("flash"));
  assert.equal((await finished(manager, mine.id)).state, "succeeded");
  assert.deepEqual(manager.trustRequests(), []);
  assert.equal(manager.trustLevel("usb-adb"), "none", "their own click is not trust for the agent");
  assert.equal(state.ran.length, 1);

  const agent = manager.start(request());
  await denyAgent(manager);
  await finished(manager, agent.id);
  const again = manager.startUser(request({ command: "getvar mine" }));
  assert.equal((await finished(manager, again.id)).state, "succeeded");
  assert.equal(manager.trustLevel("usb-adb"), "declined");
});

test("read-only detection needs no trust; every other action does", async () => {
  const { manager, state } = rig();
  const detect = manager.start(actionRequest("detect"));
  assert.equal((await finished(manager, detect.id)).state, "succeeded");
  assert.deepEqual(manager.trustRequests(), [], "detect asked nothing");
  assert.equal(manager.trustLevel("usb-adb"), "none");

  for (const action of Object.keys(BY_ACTION).filter((name) => name !== "detect")) {
    const { id } = manager.start(actionRequest(action));
    const asked = await untilTrustRequest(manager, "usb-adb");
    assert.equal(manager.status(id).state, "awaiting-trust", action);
    assert.equal(asked.waiting, 1, action);
    manager.cancel(id);
    assert.equal((await finished(manager, id)).state, "cancelled", action);
    assert.deepEqual(manager.trustRequests(), [], `${action}: the question went with its only operation`);
  }
  assert.deepEqual(state.ran, ["usb-adb:detect"], "nothing but detection ran");
  assert.equal(state.borrows, 1);
});

test("each device has its own question, listed oldest first, and answering one does not answer the other", async () => {
  const { manager } = rig();
  const first = manager.start(request({ deviceId: "usb-adb" }));
  await untilTrustRequest(manager, "usb-adb");
  await flush();
  const second = manager.start(request({ deviceId: "usb-other" }));
  await untilTrustRequest(manager, "usb-other");
  const both = manager.trustRequests();
  assert.deepEqual(both.map((entry) => entry.deviceId), ["usb-adb", "usb-other"]);

  await manager.answerTrust(both[1].id, { allow: false });
  assert.equal((await finished(manager, second.id)).error, declined("Second Pixel"));
  assert.equal(manager.status(first.id).state, "awaiting-trust", "the other device's operation is still waiting");
  assert.deepEqual(manager.trustRequests().map((entry) => entry.deviceId), ["usb-adb"]);
  await manager.answerTrust(manager.trustRequests()[0].id, { allow: true });
  assert.equal((await finished(manager, first.id)).state, "succeeded");
});

test("a device is remembered by vendor id and serial number, so its other USB modes and reboots are not asked about again", async () => {
  assert.equal(deviceTrustKey(DEVICES["usb-adb"]), deviceTrustKey(DEVICES["usb-fastboot"]), "the product id changes with the mode and is not part of the key");
  assert.notEqual(deviceTrustKey(DEVICES["usb-adb"]), deviceTrustKey(DEVICES["usb-other"]), "a second unit of the same model is another device");
  assert.notEqual(deviceTrustKey({ vendorId: GOOGLE, serialNumber: "SER-1" }), deviceTrustKey({ vendorId: 0x04e8, serialNumber: "SER-1" }), "the same serial under another vendor is another device");
  for (const noSerial of [undefined, null, "", "   "]) assert.equal(deviceTrustKey({ vendorId: GOOGLE, serialNumber: noSerial }), null, JSON.stringify(noSerial));
  assert.equal(deviceTrustKey({ serialNumber: "SER-1" }), null, "no vendor, no key");

  const { manager, book, state } = rig();
  const adb = manager.start(request());
  const asked = await untilTrustRequest(manager, "usb-adb");
  const saved = await manager.answerTrust(asked.id, { allow: true, remember: true });
  assert.deepEqual(saved, { remembered: true });
  await finished(manager, adb.id);
  assert.deepEqual(book.list().map((entry) => ({ key: entry.key, label: entry.label, vendorId: entry.vendorId, productId: entry.productId, serialNumber: entry.serialNumber })), [
    { key: deviceTrustKey(DEVICES["usb-adb"]), label: "Pixel 8", vendorId: GOOGLE, productId: 0x4ee7, serialNumber: "SER-1" },
  ]);
  assert.equal(typeof book.list()[0].grantedAt, "number");
  assert.equal(manager.trustLevel("usb-adb"), "remembered");

  // The same unit, rebooted into the bootloader: another USB id and product id, the same vendor id and serial number.
  assert.equal(manager.trustLevel("usb-fastboot"), "remembered");
  const fastboot = manager.start(request({ deviceId: "usb-fastboot", command: "flash boot" }));
  assert.equal((await finished(manager, fastboot.id)).state, "succeeded");
  assert.deepEqual(manager.trustRequests(), [], "no question for the other mode");

  // Another unit of the same model has its own serial number and is asked about.
  assert.equal(manager.trustLevel("usb-other"), "none");
  const other = manager.start(request({ deviceId: "usb-other" }));
  assert.equal((await untilTrustRequest(manager, "usb-other")).key, deviceTrustKey(DEVICES["usb-other"]));
  manager.cancel(other.id);
  assert.equal(state.writes.length, 1, "one device was remembered");
});

test("a remembered device from an earlier visit is trusted at once, and an operation waits for the list to load before deciding", async () => {
  const entry = { key: deviceTrustKey(DEVICES["usb-adb"]), label: "Pixel 8", vendorId: GOOGLE, serialNumber: "SER-1", grantedAt: 1 };

  const known = rig({ book: new MemoryTrustBook([entry]) });
  const quick = known.manager.start(request());
  assert.equal((await finished(known.manager, quick.id)).state, "succeeded");
  assert.deepEqual(known.manager.trustRequests(), []);
  assert.equal(known.manager.trustLevel("usb-adb"), "remembered");

  // The page reads the server's list when it starts. Until that settles, a question could be about a device the person
  // already remembered: the keyed device waits, the one with no serial number has nothing to look up and asks at once.
  const gate = Promise.withResolvers();
  class LoadingBook extends MemoryTrustBook {
    constructor() { super(); this.ready = gate.promise; }
  }
  const loading = new LoadingBook();
  const slow = rig({ book: loading });
  const keyed = slow.manager.start(request());
  const bare = slow.manager.start(request({ deviceId: "usb-bare" }));
  await untilTrustRequest(slow.manager, "usb-bare");
  await flush();
  assert.equal(slow.manager.trustRequests().some((asked) => asked.deviceId === "usb-adb"), false, "no question while the list is still loading");
  assert.equal(slow.manager.status(keyed.id).state, "starting");
  await loading.remember(entry);
  gate.resolve();
  assert.equal((await finished(slow.manager, keyed.id)).state, "succeeded");
  assert.equal(slow.manager.trustRequests().some((asked) => asked.deviceId === "usb-adb"), false, "it was on the list, so it was never asked about");
  assert.equal(slow.manager.status(bare.id).state, "awaiting-trust");
});

test("a device with no serial number cannot be remembered: the question has no key, Remember is ignored, and trust ends when it disconnects", async () => {
  const { manager, book, state } = rig();
  const first = manager.start(request({ deviceId: "usb-bare" }));
  const asked = await untilTrustRequest(manager, "usb-bare");
  assert.equal(asked.key, undefined, "nothing to remember it by, so the card offers no Remember box");
  assert.equal(asked.label, "Mystery board");

  const result = await manager.answerTrust(asked.id, { allow: true, remember: true });
  assert.deepEqual(result, { remembered: false }, "a tick that cannot be honoured is not an error");
  assert.equal((await finished(manager, first.id)).state, "succeeded");
  assert.deepEqual(book.list(), []);
  assert.equal(state.writes.length, 0);
  assert.equal(manager.trustLevel("usb-bare"), "session");

  const second = manager.start(request({ deviceId: "usb-bare", command: "id" }));
  assert.equal((await finished(manager, second.id)).state, "succeeded");
  assert.deepEqual(manager.trustRequests(), [], "trusted for as long as it stays connected");

  await manager.deviceDisconnected("usb-bare");
  assert.equal(manager.trustLevel("usb-bare"), "none");
  manager.start(request({ deviceId: "usb-bare", command: "id" }));
  assert.equal((await untilTrustRequest(manager, "usb-bare")).waiting, 1, "the next connection asks again");
});

test("only the Allow answer that ticked Remember writes the remembered list; nothing an operation carries can", async () => {
  const { manager, book, state } = rig();

  // An agent that names trust, approval or "remember" in its request is still asked, and nothing is stored.
  const sneaky = manager.start(request({ options: { trusted: true, remember: true, allow: true, approved: true, trust: "always" }, trusted: true, remember: true, allow: true }));
  await untilTrustRequest(manager, "usb-adb");
  await flush();
  assert.equal(manager.status(sneaky.id).state, "awaiting-trust", "the request cannot answer its own question");
  assert.equal(state.writes.length, 0);

  // Deny with the box ticked stores nothing.
  const denied = await manager.answerTrust(manager.trustRequests()[0].id, { allow: false, remember: true });
  assert.deepEqual(denied, { remembered: false });
  await finished(manager, sneaky.id);
  assert.equal(state.writes.length, 0);
  assert.deepEqual(book.list(), []);

  // Allow without the box stores nothing either.
  await manager.deviceDisconnected("usb-adb");
  manager.start(request());
  await allowAgent(manager, { remember: false });
  assert.equal(state.writes.length, 0);

  // Allow with the box ticked stores that one device, once.
  await manager.deviceDisconnected("usb-adb");
  manager.start(request());
  await allowAgent(manager, { remember: true });
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].key, deviceTrustKey(DEVICES["usb-adb"]));
  assert.deepEqual(book.list().map((entry) => entry.key), [deviceTrustKey(DEVICES["usb-adb"])]);
});

test("if the server cannot save the remembered device, the agent still gets what the person allowed, and the answer says why it was not saved", async () => {
  const { manager, book } = rig();
  book.remember = async () => { throw new Error("The server is not reachable."); };
  const { id } = manager.start(request());
  const asked = await untilTrustRequest(manager, "usb-adb");
  const result = await manager.answerTrust(asked.id, { allow: true, remember: true });
  assert.deepEqual(result, { remembered: false, error: "The server is not reachable." });
  assert.equal((await finished(manager, id)).state, "succeeded");
  assert.equal(manager.trustLevel("usb-adb"), "session", "trusted for this connection all the same");
});

test("a question that is gone cannot be answered, and a second click on the same one is refused", async () => {
  const { manager } = rig();
  const { id } = manager.start(request());
  const asked = await untilTrustRequest(manager, "usb-adb");
  await assert.rejects(manager.answerTrust("device-trust-forged", { allow: true }), /already answered or is no longer waiting/);
  assert.equal(manager.status(id).state, "awaiting-trust", "a made-up id answered nothing");
  await manager.answerTrust(asked.id, { allow: true });
  await assert.rejects(manager.answerTrust(asked.id, { allow: false }), /already answered or is no longer waiting/);
  assert.equal((await finished(manager, id)).state, "succeeded", "the second click did not turn Allow into Deny");
  assert.equal(manager.trustLevel("usb-adb"), "session");
});

test("cancelling an operation leaves the queue; the question goes away with the last one waiting", async () => {
  const { manager, state } = rig();
  const a = manager.start(request({ command: "a" }));
  const b = manager.start(request({ command: "b" }));
  await untilTrustRequest(manager, "usb-adb");
  await flush();
  assert.equal(manager.trustRequests()[0].waiting, 2);

  manager.cancel(a.id);
  assert.equal((await finished(manager, a.id)).state, "cancelled");
  assert.equal(manager.trustRequests()[0].waiting, 1, "the question stays for the one still waiting");
  assert.equal(manager.status(b.id).state, "awaiting-trust");

  manager.cancel(b.id);
  assert.equal((await finished(manager, b.id)).state, "cancelled");
  assert.deepEqual(manager.trustRequests(), [], "nobody is left to ask about");
  assert.equal(manager.trustLevel("usb-adb"), "none", "cancelling is not an answer");
  assert.equal(state.borrows, 0);

  manager.start(request({ command: "c" }));
  assert.equal((await untilTrustRequest(manager, "usb-adb")).waiting, 1, "a later operation asks afresh");
});

test("a device that leaves before the question is answered cancels the question and what waits behind it, and says why", async () => {
  const { manager } = rig();
  const a = manager.start(request({ command: "a" }));
  const b = manager.start(actionRequest("flash"));
  await untilTrustRequest(manager, "usb-adb");
  await manager.deviceDisconnected("usb-adb");
  for (const id of [a.id, b.id]) {
    const cancelled = manager.status(id);
    assert.equal(cancelled.state, "cancelled");
    assert.match(cancelled.error, /left the USB bus before the question about it was answered/);
    assert.match(cancelled.error, /Nothing was changed on the device/);
  }
  assert.deepEqual(manager.trustRequests(), []);

  const forgotten = rig();
  const c = forgotten.manager.start(request());
  await untilTrustRequest(forgotten.manager, "usb-adb");
  await forgotten.manager.deviceDisconnected("usb-adb", "forgotten");
  assert.match(forgotten.manager.status(c.id).error, /The device was disconnected before the question about it was answered/);
});

test("an unanswered question never times out: a day later it is still waiting and can still be answered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { manager, state } = rig();
  const { id } = manager.start(request());
  const asked = await untilTrustRequest(manager, "usb-adb");
  t.mock.timers.tick(24 * 60 * 60_000);
  await flush();
  assert.equal(manager.status(id).state, "awaiting-trust");
  assert.equal(manager.status(id).error, undefined);
  assert.equal(manager.trustRequests().length, 1);
  await manager.answerTrust(asked.id, { allow: true });
  assert.equal((await finished(manager, id)).state, "succeeded");
  assert.equal(state.ran.length, 1);
});

test("Forget ends the agent's control: what it was running is cancelled with the reason, the remembered entry is removed, and the next operation asks again", async () => {
  const entry = { key: deviceTrustKey(DEVICES["usb-adb"]), label: "Pixel 8", vendorId: GOOGLE, serialNumber: "SER-1", grantedAt: 1 };
  const { manager, book } = rig({ book: new MemoryTrustBook([entry]) });
  const terminal = manager.start(actionRequest("monitor"));
  await inState(manager, terminal.id, "running");

  await manager.withdrawTrust("usb-adb");
  const stopped = await finished(manager, terminal.id);
  assert.equal(stopped.state, "cancelled");
  assert.equal(stopped.error, TRUST_WITHDRAWN_REASON);
  assert.deepEqual(book.list(), [], "forgotten on the server's list too");
  assert.equal(manager.trustLevel("usb-adb"), "none");
  assert.equal(manager.trustLevel("usb-fastboot"), "none", "the same unit in another mode is no longer trusted either");

  const next = manager.start(request());
  assert.equal((await untilTrustRequest(manager, "usb-adb")).waiting, 1);
  manager.cancel(next.id);
});

test("forgetting a device elsewhere (Settings) stops what the agent is doing on it; a device allowed for this connection only keeps its grant", async () => {
  const entry = { key: deviceTrustKey(DEVICES["usb-adb"]), label: "Pixel 8", vendorId: GOOGLE, serialNumber: "SER-1", grantedAt: 1 };
  const { manager, book } = rig({ book: new MemoryTrustBook([entry]) });
  const terminal = manager.start(actionRequest("monitor"));
  await inState(manager, terminal.id, "running");
  await book.forget(entry.key);
  const stopped = await finished(manager, terminal.id);
  assert.equal(stopped.state, "cancelled");
  assert.equal(stopped.error, TRUST_WITHDRAWN_REASON);
  assert.equal(manager.trustLevel("usb-adb"), "none");

  // A device the person allowed without Remember is not on the list, so forgetting something else does not touch it.
  const session = rig({ book: new MemoryTrustBook([{ ...entry, key: deviceTrustKey(DEVICES["usb-other"]), serialNumber: "SER-2" }]) });
  const live = session.manager.start(actionRequest("monitor", "usb-bare"));
  await allowAgent(session.manager, { deviceId: "usb-bare" });
  await inState(session.manager, live.id, "running");
  await session.book.forget(deviceTrustKey(DEVICES["usb-other"]));
  await flush();
  assert.equal(session.manager.status(live.id).state, "running");
  assert.equal(session.manager.trustLevel("usb-bare"), "session");
  session.manager.cancel(live.id);
});

test("Forget does not cancel an operation that is still waiting for an answer: its question stays open", async () => {
  const { manager } = rig();
  const waiting = manager.start(request());
  await untilTrustRequest(manager, "usb-adb");
  await manager.withdrawTrust("usb-adb");
  assert.equal(manager.status(waiting.id).state, "awaiting-trust");
  assert.equal(manager.trustRequests().length, 1);
  manager.cancel(waiting.id);
});

test("a page that replaced this one withdraws everything: operations are cancelled with the reason and a late answer is refused", async () => {
  const { manager } = rig();
  const { id } = manager.start(request());
  const asked = await untilTrustRequest(manager, "usb-adb");
  manager.revokeAuthority("A newer page took over.");
  const cancelled = await finished(manager, id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.error, "A newer page took over.");
  assert.deepEqual(manager.trustRequests(), []);
  await assert.rejects(manager.answerTrust(asked.id, { allow: true }), /A newer page took over\./);
  assert.throws(() => manager.start(request()), /A newer page took over\./);
});

test("a device the page does not know raises no question: it fails on its own", async () => {
  const { manager } = rig();
  const { id } = manager.start(request({ deviceId: "usb-gone" }));
  const failed = await finished(manager, id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error, /Unknown device usb-gone/);
  assert.deepEqual(manager.trustRequests(), []);
});

test("the question names the device and the operations behind it, and an agent cannot type into a terminal it is not trusted with", async () => {
  const { manager, state } = rig();
  const monitor = manager.startUser(actionRequest("monitor"));
  await inState(manager, monitor.id, "running");
  await assert.rejects(manager.send(monitor.id, "rm -rf /\n"), /no longer allowed/);
  manager.start(request({ command: "a" }));
  manager.start(request({ command: "b" }));
  manager.start(request({ command: "c" }));
  await untilTrustRequest(manager, "usb-adb");
  await flush();
  assert.deepEqual(manager.trustRequests().map(({ label, waiting }) => ({ label, waiting })), [{ label: "Pixel 8", waiting: 3 }]);
  await allowAgent(manager);
  await manager.send(monitor.id, "id\n");
  assert.deepEqual(state.typed, ["id\n"], "the refused input never reached the terminal");
  manager.cancel(monitor.id);
});
