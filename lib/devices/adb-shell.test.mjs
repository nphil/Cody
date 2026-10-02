import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { spawnSync } from "node:child_process";
import { fakeAdb, waitFor } from "./adb.test-helper.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceOperationManager } = await jiti.import("./operations.ts");
const { adbFlasher } = await jiti.import("./adb.ts");

function setup() {
  const transports = [];
  const manager = new DeviceOperationManager("test", {
    async borrowHardwareTransport() {
      const transport = fakeAdb(); transports.push(transport);
      return { transport, async release() { transport.close(); } };
    },
  }, { async getInput() {}, async save() { return "saved"; } }, [adbFlasher]);
  return { manager, transports };
}
const request = { deviceId: "usb-1", protocol: "adb", action: "exec", command: "mount /system; dd if=/dev/block/mmcblk0p9 | sha256sum" };
const completed = (manager, id) => waitFor(() => { const s = manager.status(id); return ["failed", "succeeded", "cancelled"].includes(s.state) && s; });

test("modern ADB shell preserves quoting, separate output streams, and exit packets", { skip: process.platform === "win32" }, async () => {
  const frame = (id, data) => { const header = Buffer.alloc(5); header[0] = id; header.writeUInt32LE(data.length, 1); return Buffer.concat([header, data]); };
  const output = [];
  const transport = fakeAdb({ features: "shell_v2", output(service) {
    assert.ok(service.startsWith("shell,v2,raw:"));
    const result = spawnSync("/bin/sh", ["-c", service.slice("shell,v2,raw:".length)], { encoding: "utf8" });
    return Buffer.concat([frame(1, Buffer.from(result.stdout)), frame(2, Buffer.from(result.stderr)), frame(3, Buffer.from([result.status]))]);
  } });
  try {
    await assert.rejects(adbFlasher.run({ protocol: "adb", action: "exec", command: "printf '%s\n' 'modern stdout'; printf '%s\n' 'modern stderr' >&2; exit 9" }, {
      transport, signal: new AbortController().signal, shellAccess: () => true, output: text => output.push(text), progress() {},
    }), /status 9/);
    assert.ok(output.some(text => text.includes("modern stdout")));
    assert.ok(output.some(text => text.includes("modern stderr")));
  } finally { transport.close(); }
});

test("quoted shell syntax survives the ADB service string and returns the shell's nonzero status", { skip: process.platform === "win32" }, async () => {
  const output = [];
  const transport = fakeAdb({ output(service) {
    assert.ok(service.startsWith("exec:"));
    const result = spawnSync("/bin/sh", ["-c", service.slice(5)], { encoding: "utf8" });
    return result.stdout + result.stderr;
  } });
  try {
    await assert.rejects(adbFlasher.run({ protocol: "adb", action: "exec", command: "printf '%s\n' 'value with spaces'; exit 7" }, {
      transport, signal: new AbortController().signal, shellAccess: () => true, output: text => output.push(text), progress() {},
    }), /status 7/);
    assert.ok(output.some(text => text.includes("value with spaces")));
  } finally { transport.close(); }
});

test("the requested TWRP rollback script streams output and reports its actual exit status", async () => {
  const command = "sh /data/lumashow/rollback/rollback.sh";
  for (const exitCode of [0, 7]) {
    const transport = fakeAdb({ output: () => "Restoring kernel and root filesystem\n__CODY_ADB_STATUS__" + exitCode + "\n" });
    const manager = new DeviceOperationManager("rollback", { async borrowHardwareTransport() { return { transport, async release() { transport.close(); } }; } }, { async getInput() {}, async save() {} }, [adbFlasher]);
    manager.setShellAccess("cronos", true);
    const { id } = manager.start({ deviceId: "cronos", protocol: "adb", action: "exec", command });
    const result = await completed(manager, id);
    assert.ok(result.output.some(row => row.line.includes("Restoring kernel")));
    assert.ok(transport.services.some(service => service.includes(command)));
    if (exitCode === 0) { assert.equal(result.state, "succeeded"); assert.equal(result.result.details.exitCode, 0); }
    else { assert.equal(result.state, "failed"); assert.match(result.error, /status 7/); }
  }
});

test("agent shell requires a connection grant, streams commands/output, and loses access on revoke/disconnect", async () => {
  const { manager, transports } = setup();
  let id = manager.start({ ...request, options: { shellAccess: true, origin: "user" } }).id;
  assert.match((await completed(manager, id)).error, /Allow agent shell access/);
  assert.deepEqual(transports[0].services, []);
  manager.setShellAccess("usb-1", true);
  id = manager.start(request).id;
  const result = await completed(manager, id);
  assert.equal(result.state, "succeeded", result.error);
  assert.equal(result.result.details.exitCode, 0);
  assert.ok(result.output.some((row) => row.line.includes(request.command)));
  assert.ok(result.output.some((row) => row.line.includes("result")));
  manager.setShellAccess("usb-1", false);
  assert.match((await completed(manager, manager.start(request).id)).error, /Allow agent shell access/);
  manager.setShellAccess("usb-1", true);
  manager.deviceDisconnected("usb-1");
  assert.equal(manager.hasShellAccess("usb-1"), false);
  assert.match((await completed(manager, manager.start(request).id)).error, /Allow agent shell access/);
  assert.equal((await completed(manager, manager.start({ ...request, command: "id" }).id)).state, "succeeded");
});

test("user ADB terminal exchanges framed input/output without granting the agent", async () => {
  const { manager, transports } = setup();
  const { id } = manager.startUser({ ...request, action: "monitor" });
  await waitFor(() => manager.status(id)?.output.some((row) => row.line.includes("root@cronos")));
  assert.equal(manager.hasShellAccess("usb-1"), false);
  await assert.rejects(manager.send(id, "dd destructive\n"), /shell access/);
  await manager.sendUser(id, "id\n");
  await waitFor(() => manager.status(id)?.output.some((row) => row.line.includes("uid=0")));
  assert.deepEqual(transports[0].inputs, ["id\n"]);
  manager.cancel(id);
  assert.equal((await completed(manager, id)).state, "cancelled");
  await assert.rejects(manager.sendUser(id, "late\n"), /not accepting/);
});

test("revoking a shell grant stops an active agent terminal and refuses later input", async () => {
  const { manager, transports } = setup();
  manager.setShellAccess("usb-1", true);
  const { id } = manager.start({ ...request, action: "monitor" });
  await waitFor(() => manager.status(id)?.progress?.phase === "monitoring");
  await manager.send(id, "id\n");
  manager.setShellAccess("usb-1", false);
  assert.equal((await completed(manager, id)).state, "cancelled");
  await assert.rejects(manager.send(id, "late\n"), /not accepting/);
  assert.deepEqual(transports[0].inputs, ["id\n"]);
});
