import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// The SSE route (app/api/engines/install/events) leans on exactly these
// semantics: an engine nobody installed reads as "idle", and subscribing to a
// non-running install returns a live-but-inert unsubscribe rather than
// throwing — the route always subscribes before it snapshots.
test("install progress: unknown engine snapshots as idle", async () => {
  const { getInstallSnapshot } = await jiti.import("./install.ts");
  assert.deepEqual(getInstallSnapshot("never-installed"), { status: "idle", log: "", error: null });
});

test("install progress: subscribing to a non-running install is a safe no-op", async () => {
  const { subscribeInstall } = await jiti.import("./install.ts");
  let called = false;
  const unsubscribe = subscribeInstall("never-installed", () => { called = true; });
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.equal(called, false);
});
