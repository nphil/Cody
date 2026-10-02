import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDeviceZoneReporter, shouldReportDeviceZone } = await jiti.import("./useDeviceTimeZone.ts");

/** A fake network whose answers the test settles by hand. */
function fakeServer() {
  const sent = [];
  const pending = [];
  return {
    sent,
    send(zone) {
      sent.push(zone);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    /** Settle the oldest unanswered report. */
    async answer(accepted) {
      pending.shift().resolve(accepted);
      await Promise.resolve();
      await Promise.resolve();
    },
    async fail(error) {
      pending.shift().reject(error);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function device(initial) {
  const state = { zone: initial };
  return { state, detect: () => state.zone };
}

test("reports on load, then stays quiet while the zone is unchanged", async () => {
  const server = fakeServer();
  const tablet = device("America/New_York");
  const check = createDeviceZoneReporter(tablet.detect, (zone) => server.send(zone));
  check();
  await server.answer(true);
  check();
  check();
  assert.deepEqual(server.sent, ["America/New_York"], "focus events in the same zone cost nothing");
});

test("a tablet that flew to Tokyo reports the new zone the next time it is picked up", async () => {
  const server = fakeServer();
  const tablet = device("America/New_York");
  const check = createDeviceZoneReporter(tablet.detect, (zone) => server.send(zone));
  check();
  await server.answer(true);
  tablet.state.zone = "Asia/Tokyo";
  check();
  await server.answer(true);
  tablet.state.zone = "America/New_York";
  check();
  assert.deepEqual(server.sent, ["America/New_York", "Asia/Tokyo", "America/New_York"]);
});

test("a rejected report is retried at the next check, not in a loop", async () => {
  const server = fakeServer();
  const tablet = device("Europe/Paris");
  const check = createDeviceZoneReporter(tablet.detect, (zone) => server.send(zone));
  check();
  await server.answer(false);
  assert.deepEqual(server.sent, ["Europe/Paris"], "a failure waits for the next focus instead of hammering the server");
  check();
  assert.deepEqual(server.sent, ["Europe/Paris", "Europe/Paris"]);
  await server.answer(true);
  check();
  assert.equal(server.sent.length, 2);
});

test("never two reports at once; a zone that changed meanwhile goes out right after", async () => {
  const server = fakeServer();
  const tablet = device("America/New_York");
  const check = createDeviceZoneReporter(tablet.detect, (zone) => server.send(zone));
  check();
  tablet.state.zone = "Asia/Tokyo";
  check();
  assert.deepEqual(server.sent, ["America/New_York"], "the second check waits for the first to settle");
  await server.answer(true);
  assert.deepEqual(server.sent, ["America/New_York", "Asia/Tokyo"], "the change is not left until the next focus");
});

test("a report that throws does not wedge the reporter", async () => {
  const server = fakeServer();
  const tablet = device("Asia/Tokyo");
  const check = createDeviceZoneReporter(tablet.detect, (zone) => server.send(zone));
  check();
  await server.fail(new Error("socket closed"));
  check();
  assert.deepEqual(server.sent, ["Asia/Tokyo", "Asia/Tokyo"]);
});

test("a browser that cannot name its zone reports nothing", () => {
  const server = fakeServer();
  const check = createDeviceZoneReporter(() => null, (zone) => server.send(zone));
  check();
  assert.deepEqual(server.sent, []);
  assert.equal(shouldReportDeviceZone(null, null, false), false);
});
