import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { fakeBrowser, fakeUsbAdbDevice } from "./usb-adb.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceBridgeConnection, adoptPermittedUsbDevices, forgetDevice } = await jiti.import("./client.ts");
const { usbAcquisitionLimits } = await jiti.import("./usb-acquisition.ts");

async function until(check) {
  for (const end = Date.now() + 2000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 5))) {
    const value = check();
    if (value) return value;
  }
  assert.fail("Expected USB state was not reached");
}

/** Run the real page bridge with the browser's USB and WebSocket boundaries in memory. */
async function usbPage(sessionId) {
  const browser = fakeBrowser();
  const device = fakeUsbAdbDevice({ serial: sessionId, adbd: { transport: {
    async read(length) { return new Uint8Array(length).fill(0x42); },
    async write() { assert.fail("Unexpected USB write"); },
    close() {},
  } } });
  browser.plug(device);
  const selected = new Set();
  const priorSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  let socket;
  class PageSocket {
    static OPEN = 1;
    readyState = PageSocket.OPEN;
    results = new Map();
    requestId = 0;
    constructor() { socket = this; }
    close() {}
    send(data) {
      const frame = JSON.parse(data);
      if (frame.type === "result") this.results.set(frame.id, frame);
    }
    async request(deviceId, op, params = {}) {
      const id = String(++this.requestId);
      this.onmessage({ data: JSON.stringify({ type: "op", id, deviceId, op, params }) });
      return until(() => this.results.get(id));
    }
    replaceHost() { this.onclose({ code: 4001, reason: "Device host authority replaced." }); }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: PageSocket });
  window.location = { protocol: "https:", host: "cody.test" };
  const connections = [new DeviceBridgeConnection(sessionId)];
  const connection = connections[0];
  async function grant() {
    const { id } = await connection.requestDevice("usb");
    selected.add(id);
    return id;
  }
  return {
    device, connection, grant, id: await grant(),
    host(bridge = connection) {
      bridge.start();
      socket.onopen();
      return socket;
    },
    anotherPage() {
      const bridge = new DeviceBridgeConnection(sessionId);
      connections.push(bridge);
      return bridge;
    },
    async close() {
      try {
        for (const id of selected) await forgetDevice(id);
      } finally {
        for (const bridge of connections) bridge.destroy();
        browser.restore();
        if (priorSocket) Object.defineProperty(globalThis, "WebSocket", priorSocket);
        else delete globalThis.WebSocket;
      }
    },
  };
}

for (const method of ["open", "claimInterface"]) {
  test(`a rejected USB ${method} answers once and frees the device for a new borrow`, async () => {
    const page = await usbPage(`usb-refused-${method}`);
    const cause = new DOMException(method === "open" ? "Could not open this device." : "Unable to claim interface.", "NetworkError");
    const original = page.device[method];
    let calls = 0;
    page.device[method] = async function (...args) {
      if (++calls === 1) throw cause;
      return original.apply(this, args);
    };
    try {
      await assert.rejects(page.connection.borrowHardwareTransport(page.id, { interfaceNumber: 0, alternateSetting: 0 }), (error) => {
        if (method === "open") {
          assert.equal(error, cause);
        } else {
          assert.equal(error.name, cause.name);
          assert.equal(error.cause, cause);
          assert.equal(error.originalMessage, cause.message);
          assert.equal(error.interfaceNumber, 0);
          assert.equal(error.alternateSetting, 0);
          assert.match(error.message, /Unable to claim interface.*interface 0 \(alternate 0, class ff\/42\/01\).*NetworkError/);
          assert.match(error.message, /will not retry.*WinUSB.*grant it again/);
        }
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(page.device.opened, false);
      const lease = await page.connection.borrowHardwareTransport(page.id, { interfaceNumber: 0, alternateSetting: 0 });
      try {
        assert.deepEqual(await lease.transport.read(1, 100, new AbortController().signal), Uint8Array.of(0x42));
        assert.equal(calls, 2, "the second attempt came only from a new borrow");
      } finally {
        await lease.release();
      }
    } finally {
      await page.close();
    }
  });
}

test("raw USB open keeps exactly the browser message for an unclaimed interface, but a named claim fails with guidance", async () => {
  const page = await usbPage("usb-partial-open");
  const [first] = page.device.configuration.interfaces;
  const second = { ...first, interfaceNumber: 1 };
  page.device.configuration.interfaces.push(second);
  const failedClaim = "Unable to claim interface.";
  const claims = [];
  page.device.claimInterface = async (number) => {
    claims.push(number);
    if (number === 0) throw new DOMException(failedClaim, "NetworkError");
    second.claimed = true;
  };
  try {
    const socket = page.host();
    const partial = await socket.request(page.id, "usb.open");
    assert.equal(partial.status, "ok", partial.error);
    assert.deepEqual(partial.value.interfaces.map(({ interfaceNumber, claimed, error }) => ({ interfaceNumber, claimed, error })), [
      { interfaceNumber: 0, claimed: false, error: failedClaim },
      { interfaceNumber: 1, claimed: true, error: undefined },
    ]);
    const named = await socket.request(page.id, "usb.open", { interface: 0, alternate: { interfaceNumber: 0, alternateSetting: 0 } });
    assert.equal(named.status, "error");
    assert.match(named.error, /Unable to claim interface.*interface 0 \(alternate 0, class ff\/42\/01\).*NetworkError.*grant it again/);
    assert.deepEqual(claims, [0, 1, 0]);
  } finally {
    await page.close();
  }
});

test("a raw USB open deadline and Disconnect do not let a regrant reuse the same still-busy browser object", async () => {
  const page = await usbPage("usb-raw-deadline");
  const gate = Promise.withResolvers();
  const { device } = page;
  const open = device.open, close = device.close;
  let opens = 0, closes = 0, forgets = 0;
  device.open = async () => { opens += 1; await gate.promise; await open.call(device); };
  device.close = async () => { closes += 1; await close.call(device); };
  device.forget = async () => { forgets += 1; };
  const before = usbAcquisitionLimits.rawOpenMs;
  usbAcquisitionLimits.rawOpenMs = 20;
  try {
    const socket = page.host();
    const timedOut = await socket.request(page.id, "usb.open");
    assert.equal(timedOut.status, "error");
    assert.match(timedOut.error, /did not finish opening the device.*reserved.*nothing is retried/);
    assert.equal(opens, 1);
    assert.equal(closes, 0);
    await page.connection.disconnectDevice(page.id);
    assert.equal(forgets, 1);
    const granted = await page.grant();
    assert.notEqual(granted, page.id);
    await assert.rejects(page.connection.borrowHardwareTransport(granted), (error) => {
      assert.equal(error.busy.held, "unresolved-claim");
      assert.match(error.message, /opening the device.*deadline passed/);
      return true;
    });
    gate.resolve();
    await until(() => closes === 2 && !device.opened); // The explicit Disconnect and the late open's own close.
    const lease = await page.connection.borrowHardwareTransport(granted);
    assert.equal(device.opened, true);
    assert.equal(opens, 2);
    await lease.release();
  } finally {
    usbAcquisitionLimits.rawOpenMs = before;
    gate.resolve();
    await page.close();
  }
});

test("a reconnect deadline stops waiting for the same device's open and reports when its cleanup actually ends", async () => {
  const page = await usbPage("usb-reconnect-deadline");
  const gate = Promise.withResolvers();
  const open = page.device.open;
  let opens = 0, cleanup;
  try {
    const first = await page.connection.borrowHardwareTransport(page.id);
    assert.ok(first.identity);
    await first.release();
    page.device.open = async () => { opens += 1; await gate.promise; await open.call(page.device); };
    await assert.rejects(page.connection.reacquireHardwareTransport(page.id, first.identity, {
      signal: new AbortController().signal, timeoutMs: 20,
    }), (error) => {
      assert.match(error.message, /did not return and finish opening.*nothing is retried/);
      cleanup = error.usbCleanup;
      assert.ok(cleanup instanceof Promise);
      return true;
    });
    assert.equal(opens, 1);
    assert.equal(page.device.opened, false);
    await assert.rejects(page.connection.borrowHardwareTransport(page.id), /unfinished USB step.*opening the device/);
    gate.resolve();
    await cleanup;
    assert.equal(page.device.opened, false);
    const fresh = await page.connection.borrowHardwareTransport(page.id);
    assert.equal(opens, 2);
    await fresh.release();
  } finally {
    gate.resolve();
    await page.close();
  }
});

test("a late list of permitted USB devices cannot replace a newer picker grant", async () => {
  const page = await usbPage("usb-late-list");
  const oldList = Promise.withResolvers();
  try {
    navigator.usb.getDevices = () => oldList.promise;
    const adopting = adoptPermittedUsbDevices(page.connection.sessionId);
    const replacement = fakeUsbAdbDevice({ serial: page.device.serialNumber, adbd: page.device.adbd });
    navigator.usb.requestDevice = async () => replacement;
    assert.equal(await page.grant(), page.id);
    oldList.resolve([page.device]);
    await adopting;
    const lease = await page.connection.borrowHardwareTransport(page.id);
    try {
      assert.equal(replacement.opened, true);
      assert.equal(page.device.opened, false);
    } finally {
      await lease.release();
    }
  } finally {
    oldList.resolve([]);
    await page.close();
  }
});

test("replacing a device host closes its idle raw handle and abandons a pending claim without reusing it", async () => {
  const page = await usbPage("usb-host-replaced");
  const gate = Promise.withResolvers();
  const closeGate = Promise.withResolvers();
  const { device, id } = page;
  const close = device.close, claim = device.claimInterface;
  let closes = 0, claims = 0, usbCleanup;
  device.close = async () => {
    if (++closes === 2) await closeGate.promise;
    await close.call(device);
  };
  try {
    const first = page.host();
    assert.equal((await first.request(id, "usb.open")).status, "ok");
    assert.equal(device.opened, true);
    first.replaceHost();
    assert.equal(page.connection.getSnapshot().attached, false);
    assert.equal(device.opened, false, "the original tab gave up its idle USB handle");
    assert.equal(closes, 1);
    // `opened` can change before close() settles and frees its reservation.
    await nextTurn();

    const second = page.anotherPage();
    const secondSocket = page.host(second);
    device.claimInterface = async (number) => { claims += 1; await gate.promise; await claim.call(device, number); };
    await Promise.all([
      assert.rejects(second.borrowHardwareTransport(id), (error) => {
        assert.equal(error.name, "AbortError", error.message);
        assert.match(error.message, /authority replaced/);
        usbCleanup = error.usbCleanup;
        assert.ok(usbCleanup instanceof Promise);
        return true;
      }),
      until(() => claims === 1).then(() => secondSocket.replaceHost()),
    ]);
    assert.equal(closes, 1, "closing waits until the ongoing claim answers");
    const third = page.anotherPage();
    await assert.rejects(third.borrowHardwareTransport(id), /unfinished USB step.*claiming interface 0/);
    gate.resolve();
    await until(() => closes === 2);
    await assert.rejects(third.borrowHardwareTransport(id), /unfinished USB step.*closing the device/);
    closeGate.resolve();
    await usbCleanup;
    assert.equal(device.opened, false);
    const lease = await third.borrowHardwareTransport(id);
    assert.equal(device.opened, true);
    assert.equal(claims, 2);
    await lease.release();
  } finally {
    gate.resolve();
    closeGate.resolve();
    await page.close();
  }
});
