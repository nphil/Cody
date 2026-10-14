import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { createJiti } from "jiti";

/**
 * The page-wide store behind the top-bar machine meters. What matters: the two
 * components that draw machines share ONE stream (it opens with the first and
 * closes with the last), a hidden page holds none (that is what lets the
 * server stop sampling), a connection the browser cannot repair is retried
 * slowly, and a stream that has gone quiet is replaced even when the browser
 * has not noticed it died.
 *
 * Browser globals and time are fakes; each test gets a fresh copy of the
 * module, because the store is module state by design.
 */

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all = [];
  readyState = 1;
  closed = false;
  onmessage = null;
  onerror = null;
  constructor(url) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  push(frame) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  fail(readyState) {
    this.readyState = readyState;
    this.onerror?.({});
  }
}

const opened = () => FakeEventSource.all;

async function setup({ visible = true } = {}) {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
  const store = await jiti.import("./useMachineMeters.ts");
  FakeEventSource.all = [];
  globalThis.EventSource = FakeEventSource;
  globalThis.window = globalThis;
  const handlers = new Map();
  const doc = {
    visibilityState: visible ? "visible" : "hidden",
    addEventListener: (type, handler) => handlers.set(type, handler),
    removeEventListener: (type, handler) => { if (handlers.get(type) === handler) handlers.delete(type); },
    setVisible(state) {
      this.visibilityState = state;
      handlers.get("visibilitychange")?.();
    },
    get listeners() { return handlers.size; },
  };
  globalThis.document = doc;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  return { store, doc };
}

afterEach(() => {
  mock.timers.reset();
  delete globalThis.EventSource;
  delete globalThis.document;
  delete globalThis.window;
});

const frame = (names = ["This server"]) => ({
  type: "machines",
  at: 1,
  machines: names.map((name, index) => ({ id: index === 0 ? "local" : `m-${index}`, name, kind: index === 0 ? "local" : "ssh", status: "online", reason: null, metrics: null })),
});

test("the first subscriber opens one stream, the next ones share it, the last one out closes it", async () => {
  const { store, doc } = await setup();
  const first = store.subscribeMachineMeters(() => {});
  assert.equal(opened().length, 1);
  assert.equal(opened()[0].url, "/api/machines/stream");
  const second = store.subscribeMachineMeters(() => {});
  assert.equal(opened().length, 1, "the dropdown opening must not open a second stream");
  first();
  assert.equal(opened()[0].closed, false);
  second();
  assert.equal(opened()[0].closed, true);
  assert.equal(doc.listeners, 0, "no visibility listener is left behind");
});

test("a frame reaches every subscriber; heartbeats and junk are ignored", async () => {
  const { store } = await setup();
  let heard = 0;
  store.subscribeMachineMeters(() => { heard += 1; });
  store.subscribeMachineMeters(() => { heard += 1; });
  const stream = opened()[0];
  stream.push({ type: "heartbeat", at: 1 });
  stream.push("{not json");
  stream.push({ type: "machines", machines: "nope", at: 1 });
  assert.equal(heard, 0);
  assert.equal(store.getMachineMetersSnapshot(), null);

  stream.push(frame(["This server", "Proxmox"]));
  assert.equal(heard, 2, "both subscribers were told");
  const snapshot = store.getMachineMetersSnapshot();
  assert.equal(snapshot.live, true);
  assert.deepEqual(snapshot.machines.map((machine) => machine.name), ["This server", "Proxmox"]);
});

test("a hidden page holds no stream and keeps the last figures marked as not live", async () => {
  const { store, doc } = await setup();
  store.subscribeMachineMeters(() => {});
  opened()[0].push(frame());
  doc.setVisible("hidden");
  assert.equal(opened()[0].closed, true, "nobody is looking: let the server stop sampling");
  const stale = store.getMachineMetersSnapshot();
  assert.equal(stale.live, false);
  assert.equal(stale.machines.length, 1, "the last figures stay, flagged");

  doc.setVisible("visible");
  assert.equal(opened().length, 2);
  opened()[1].push(frame());
  assert.equal(store.getMachineMetersSnapshot().live, true);
});

test("a page that starts hidden opens nothing until it is shown", async () => {
  const { store, doc } = await setup({ visible: false });
  store.subscribeMachineMeters(() => {});
  assert.equal(opened().length, 0);
  doc.setVisible("visible");
  assert.equal(opened().length, 1);
});

test("a dropped connection the browser repairs is only marked not live; a refusal is retried here, slowly", async () => {
  const { store } = await setup();
  store.subscribeMachineMeters(() => {});
  opened()[0].push(frame());
  opened()[0].fail(FakeEventSource.CONNECTING);
  assert.equal(store.getMachineMetersSnapshot().live, false);
  assert.equal(opened().length, 1, "the browser reconnects it by itself: do not open a second");

  opened()[0].fail(FakeEventSource.CLOSED);
  assert.equal(opened()[0].closed, true);
  mock.timers.tick(1_999);
  assert.equal(opened().length, 1);
  mock.timers.tick(1);
  assert.equal(opened().length, 2, "first retry after 2 s");

  opened()[1].fail(FakeEventSource.CLOSED);
  mock.timers.tick(4_999);
  assert.equal(opened().length, 2);
  mock.timers.tick(1);
  assert.equal(opened().length, 3, "second retry after 5 s");

  opened()[2].push(frame());
  opened()[2].fail(FakeEventSource.CLOSED);
  mock.timers.tick(2_000);
  assert.equal(opened().length, 4, "a good frame resets the gap to the shortest");
});

test("a stream that went quiet is replaced, and one that keeps heartbeating is left alone", async () => {
  const { store } = await setup();
  store.subscribeMachineMeters(() => {});
  opened()[0].push(frame());
  for (let i = 0; i < 10; i += 1) {
    mock.timers.tick(10_000);
    opened()[0].push({ type: "heartbeat", at: i });
  }
  assert.equal(opened().length, 1, "heartbeats every 10 s are life");

  mock.timers.tick(30_000);
  assert.equal(opened().length, 1, "30 s of silence is not yet a verdict");
  mock.timers.tick(10_000);
  assert.equal(opened().length, 2, "past 30 s the connection is replaced");
  assert.equal(opened()[0].closed, true);
});
