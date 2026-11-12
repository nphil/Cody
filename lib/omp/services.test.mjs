import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/** `omp ps --all --json` parsing for Settings › System › Background services. */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseServiceReports, listServices } = await jiti.import("./services.ts");

const SAMPLE = JSON.stringify([
  {
    kind: "project",
    projectDir: "/work/app",
    runtimeDir: "/run/x",
    brokerPid: 1,
    daemons: [
      { name: "web", id: "a", state: "ready", pid: 42, startedAt: 1000, command: "bun   run\n dev", cwd: "/work/app", supervised: true },
      { name: "old", id: "b", state: "exited", startedAt: 900, command: "x" },
      { name: "omp.browser.headless", id: "c", state: "running", pid: 43, command: "chromium" },
    ],
  },
  { kind: "global", service: "browser-relay", runtimeDir: "/run/g", daemons: [{ name: "relay", id: "d", state: "starting", command: "relay" }] },
  { kind: "project", daemons: [{ name: "no-dir", state: "ready" }] },
]);

test("only running services are listed, with their scope", () => {
  const rows = parseServiceReports(`warning line\n${SAMPLE}`);
  assert.deepEqual(rows.map((row) => row.name), ["web", "omp.browser.headless", "relay"]);
  assert.deepEqual(rows[0], { name: "web", state: "ready", pid: 42, startedAt: 1000, command: "bun run dev", projectDir: "/work/app", scope: null, internal: false });
  assert.equal(rows[1].internal, true);
  assert.equal(rows[2].scope, "browser-relay");
  assert.equal(rows[2].projectDir, null);
});

test("unreadable output is null, not an empty list", () => {
  assert.equal(parseServiceReports("not json"), null);
  assert.equal(parseServiceReports("{}"), null);
});

test("the installed engine answers `omp ps --all --json`", async () => {
  const rows = await listServices();
  assert.ok(Array.isArray(rows));
  for (const row of rows) assert.ok(row.projectDir !== null || row.scope !== null);
});
