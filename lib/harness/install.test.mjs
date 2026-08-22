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

test("checkInstallDiskSpace refuses a full filesystem and names it", async () => {
  const { checkInstallDiskSpace } = await jiti.import("./install.ts");
  const GB = 1024 * 1024 * 1024;

  // Room everywhere: never block.
  assert.equal(checkInstallDiskSpace("/tools", "/data/home/.npm", () => ({ availableBytes: 10 * GB })), null);

  // The field failure: the npm CACHE filesystem is the one that is full, while
  // the install prefix looks fine. The message must name the cache path.
  const full = checkInstallDiskSpace("/tools", "/data/home/.npm", (dir) =>
    dir === "/data/home/.npm" ? { availableBytes: 0 } : { availableBytes: 10 * GB });
  assert.match(full ?? "", /npm cache \/data\/home\/\.npm/);
  assert.match(full ?? "", /0 B available/);
  assert.match(full ?? "", /quota/i, "must point at raising the quota, the actual remedy here");

  // A full install prefix is reported against its own path.
  const prefixFull = checkInstallDiskSpace("/tools", "/data/home/.npm", (dir) =>
    dir === "/tools" ? { availableBytes: 1024 } : { availableBytes: 10 * GB });
  assert.match(prefixFull ?? "", /install directory \/tools/);

  // Unreadable space must NOT block an install that would have worked.
  assert.equal(checkInstallDiskSpace("/tools", "/data/home/.npm", () => null), null);
});
