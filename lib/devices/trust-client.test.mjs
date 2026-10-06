import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The page's copy of the server's remembered-device list (ServerTrustBook),
 * against a fake `fetch` that plays the route in lib/devices/trust-store.test.mjs.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ServerTrustBook, TRUST_ROUTE } = await jiti.import("./trust-client.ts");

const pixel = { key: "usb:18d1:PIX123", label: "Pixel 8", vendorId: 0x18d1, productId: 0x4ee7, serialNumber: "PIX123", grantedAt: 2_000 };
const esp = { key: "usb:303a:ESP001", label: "ESP32-S3", vendorId: 0x303a, serialNumber: "ESP001", grantedAt: 1_000 };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake fetch whose answers the test hands out by hand. Each call waits in `pending` until `answer` settles it. */
function fakeServer() {
  const calls = [];
  const pending = [];
  const request = (url, init = {}) => new Promise((resolve, reject) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    pending.push({ call, resolve, reject });
    init.signal?.addEventListener("abort", () => reject(init.signal.reason));
  });
  return {
    calls,
    request,
    /** Settle the oldest unanswered call (of the given method, if one is named). */
    answer(response, method) {
      const index = pending.findIndex((entry) => method === undefined || entry.call.method === method);
      assert.ok(index >= 0, "a request was waiting");
      const [next] = pending.splice(index, 1);
      if (response instanceof Error) next.reject(response);
      else next.resolve(response);
      return next.call;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the first read fills the list and settles ready", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  let settled = false;
  void book.ready.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false, "the gate waits for the first read");
  assert.equal(book.has(pixel.key), false);

  const call = server.answer(json(200, { devices: [esp, pixel] }));
  assert.equal(call.url, TRUST_ROUTE);
  assert.equal(call.method, "GET");
  await book.ready;
  assert.deepEqual(book.list().map((device) => device.key), [pixel.key, esp.key], "newest grantedAt first");
  assert.equal(book.has(esp.key), true);
  assert.equal(book.loadError, null);
});

test("a read the server refuses settles ready anyway, empty, with the reason in loadError", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(401, { error: "Authentication required", code: "auth_required" }));
  await book.ready;
  assert.deepEqual(book.list(), []);
  assert.equal(book.loadError, "Authentication required");
});

test("an unreachable server settles ready with loadError, and a later read clears it", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(new Error("network down"));
  await book.ready;
  assert.equal(book.loadError, "network down");

  const refreshed = book.refresh();
  server.answer(json(200, { devices: [pixel] }));
  await refreshed;
  assert.equal(book.loadError, null);
  assert.deepEqual(book.list().map((device) => device.key), [pixel.key]);
});

test("a read that never answers is given up on after a few seconds so the gate does not hang", { timeout: 10_000 }, async () => {
  const server = fakeServer();
  const keepAlive = setInterval(() => {}, 100); // AbortSignal.timeout does not keep the event loop running by itself
  try {
    const book = new ServerTrustBook(server.request);
    await book.ready;
    assert.ok(book.loadError, "the timeout is reported");
    assert.deepEqual(book.list(), []);
  } finally {
    clearInterval(keepAlive);
  }
});

test("a failed read keeps what the page already had", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(200, { devices: [pixel] }));
  await book.ready;

  const again = book.refresh();
  server.answer(json(500, {}));
  await again;
  assert.deepEqual(book.list().map((device) => device.key), [pixel.key]);
  assert.equal(book.loadError, "HTTP 500");
});

test("a list the server sends is re-checked: entries that are not valid devices are ignored", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(200, { devices: [pixel, { ...esp, key: "usb:dead:beef" }, "text", { label: "no serial", vendorId: 1 }] }));
  await book.ready;
  assert.deepEqual(book.list().map((device) => device.key), [pixel.key]);

  const broken = new ServerTrustBook(server.request);
  server.answer(json(200, { nope: true }));
  await broken.ready;
  assert.match(broken.loadError, /not readable/);
});

test("remember sends the device without a key or a time, and the page's list becomes the server's answer", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(200, { devices: [] }));
  await book.ready;
  const heard = [];
  book.subscribe(() => heard.push(book.list().map((device) => device.key)));

  const remembering = book.remember(pixel);
  await settle();
  const call = server.answer(json(200, { devices: [pixel, esp] }));
  await remembering;

  assert.equal(call.method, "PUT");
  assert.equal(call.url, TRUST_ROUTE);
  assert.deepEqual(call.body, { label: "Pixel 8", vendorId: 0x18d1, productId: 0x4ee7, serialNumber: "PIX123" });
  assert.deepEqual(book.list().map((device) => device.key), [pixel.key, esp.key], "the server's list, including what it already held");
  assert.equal(book.has(esp.key), true);
  assert.deepEqual(heard, [[pixel.key, esp.key]], "subscribers hear about the change once");
});

test("a refused remember throws the server's reason and changes nothing", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(200, { devices: [esp] }));
  await book.ready;
  const before = book.list();
  let heard = 0;
  book.subscribe(() => { heard += 1; });

  for (const [status, body, message] of [
    [403, { error: "Only the Cody page can remember a device", code: "page_required" }, "Only the Cody page can remember a device"],
    [400, { error: "The device needs a label", code: "invalid_trusted_device" }, "The device needs a label"],
    [502, "<html>bad gateway</html>", "HTTP 502"],
  ]) {
    const attempt = book.remember(pixel);
    await settle();
    server.answer(typeof body === "string" ? new Response(body, { status }) : json(status, body));
    await assert.rejects(attempt, { message });
    assert.equal(book.list(), before, "the very same list: nothing changed");
    assert.equal(book.has(pixel.key), false);
  }
  assert.equal(heard, 0);
});

test("forget deletes by encoded key and takes the server's answer; a refusal throws and changes nothing", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(200, { devices: [pixel, esp] }));
  await book.ready;

  const refused = book.forget(esp.key);
  await settle();
  server.answer(json(401, { error: "Authentication required" }));
  await assert.rejects(refused, { message: "Authentication required" });
  assert.equal(book.has(esp.key), true);
  assert.equal(book.list().length, 2);

  const forgetting = book.forget("usb:303a:A B/C");
  await settle();
  const call = server.answer(json(200, { devices: [pixel] }));
  await forgetting;
  assert.equal(call.method, "DELETE");
  assert.equal(call.url, `${TRUST_ROUTE}?key=${encodeURIComponent("usb:303a:A B/C")}`);
  assert.deepEqual(book.list().map((device) => device.key), [pixel.key]);
  assert.equal(book.has(esp.key), false);
});

test("a write that finishes while an older read is in flight wins over that read", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(200, { devices: [] }));
  await book.ready;

  const reading = book.refresh();
  await settle();
  const writing = book.remember(pixel);
  await settle();
  // The write is answered and applied first; the read, begun before the write, then answers with the old list.
  server.answer(json(200, { devices: [pixel] }), "PUT");
  await writing;
  server.answer(json(200, { devices: [] }), "GET");
  await reading;
  assert.deepEqual(book.list().map((device) => device.key), [pixel.key], "the remembered device is not erased by the stale read");
  assert.equal(book.has(pixel.key), true);
});

test("list() is the same array until something changes", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(200, { devices: [pixel] }));
  await book.ready;
  const first = book.list();
  assert.equal(book.list(), first);

  const failing = book.refresh();
  server.answer(new Error("offline"));
  await failing;
  assert.equal(book.list(), first, "a failed read does not replace the list");

  const writing = book.remember(esp);
  await settle();
  server.answer(json(200, { devices: [pixel, esp] }));
  await writing;
  assert.notEqual(book.list(), first);
  assert.equal(book.list(), book.list());
});

test("unsubscribing stops the notifications", async () => {
  const server = fakeServer();
  const book = new ServerTrustBook(server.request);
  server.answer(json(200, { devices: [] }));
  await book.ready;
  let heard = 0;
  const stop = book.subscribe(() => { heard += 1; });
  stop();
  const writing = book.remember(pixel);
  await settle();
  server.answer(json(200, { devices: [pixel] }));
  await writing;
  assert.equal(heard, 0);
});
