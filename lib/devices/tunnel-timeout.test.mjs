import assert from "node:assert/strict";
import test from "node:test";
import { fakeTunnelDevice } from "./adb-tunnel.test-helper.mjs";
import { connectPage, listen, until } from "./tunnel-page.test-helper.mjs";

// Its own file: the bound is a real 15 s, and test files run in parallel processes.
test("a reverse registration the device never answers fails after the bound and frees the rule and lease", async () => {
  const host = await listen(() => {});
  const daemon = fakeTunnelDevice();
  daemon.withholdReverse = true;
  const page = connectPage(daemon);
  try {
    const id = await page.start("device_reverse", { target: "tcp:0", local: `tcp:${host.port}` });
    await until(() => daemon.services.some((service) => service.startsWith("reverse:forward:")), "the registration to be sent");
    assert.equal(page.state(id), "running", "still waiting at first");
    const done = await until(() => ["succeeded", "failed", "cancelled"].includes(page.state(id)) && page.manager.status(id), "the registration bound", 25_000);
    assert.equal(done.state, "failed");
    assert.match(done.error, /did not answer the reverse registration in time/);
    await until(() => page.bridge.tunnels.list().length === 0, "the server-side rule to be dropped");
    await until(() => page.stats.releases === 1, "the device lease to be released");
  } finally {
    page.disconnect();
    daemon.close();
    await host.close();
  }
});
