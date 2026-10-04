import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { bootingTransport, mutedTransport, packageManager, sandboxDevice } from "./adb-device.test-helper.mjs";
import { patterned } from "./sparse.test-helper.mjs";
import { buildZip } from "./zip.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { adbFlasher, adbLimits, adbWaitOptions } = await jiti.import("./adb.ts");
const { DeviceOperationManager } = await jiti.import("./operations.ts");
const { DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const posix = process.platform !== "win32";

const apk = buildZip([
  { name: "AndroidManifest.xml", data: "binary manifest", method: "store" },
  { name: "classes.dex", data: patterned(9000, 4), method: "deflate" },
]);

function context(device, over = {}) {
  const ctx = {
    transport: device.transport,
    signal: new AbortController().signal,
    confirmations: [],
    outputs: [],
    events: [],
    progress: (event) => ctx.events.push(event),
    output: (text) => ctx.outputs.push(text),
    confirm: async (risk) => {
      ctx.confirmations.push(risk);
      await ctx.onConfirm?.(risk);
    },
    ...over,
  };
  return ctx;
}

const install = (ctx, options, overrides = {}) => adbFlasher.run({ protocol: "adb", action: "install", sha256: sha256(apk), options, ...overrides }, { ...ctx, input: ctx.input ?? new Blob([apk]) });
const exec = (ctx, options) => adbFlasher.run({ protocol: "adb", action: "exec", options }, ctx);
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 10))) {
    const value = check();
    if (value) return value;
  }
  throw new Error("Expected state was not reached");
};

// ---------------------------------------------------------------------------
// adb install
// ---------------------------------------------------------------------------

test("install asks first, stages the APK with a hash check, runs pm install on exactly that file, and cleans up", { skip: !posix }, async () => {
  const device = sandboxDevice();
  const ctx = context(device);
  ctx.onConfirm = () => {
    assert.equal(device.writes.length, 0, "no byte reaches the device before approval");
    assert.equal(device.services.some((service) => service.startsWith("sync:") || /mkdir -p/.test(service)), false);
  };
  const result = await install(ctx, { replace: true, grantPermissions: true });

  const [risk] = ctx.confirmations;
  assert.equal(risk.action, "adb.install");
  assert.equal(risk.sha256, sha256(apk));
  assert.equal(risk.length, apk.length);
  assert.match(risk.backup, /-r replaces the installed app's code/);
  assert.equal(device.pmCalls.length, 1);
  assert.match(device.pmCalls[0].command, /pm install -r -g '\/data\/local\/tmp\/cody-install-[0-9a-f]{16}\.apk'/);
  assert.deepEqual(device.pmCalls[0].apk, apk, "pm sees the exact bytes that were approved");
  const stagedName = `cody-install-${sha256(apk).slice(0, 16)}.apk`;
  assert.equal(existsSync(join(device.root, stagedName)), false, "the staged copy is deleted");
  assert.equal(existsSync(join(device.root, `.cody-adb-stage-${sha256(apk).slice(0, 24)}`)), false, "so are its staging chunks");
  assert.equal(result.verified, true);
  assert.equal(result.sha256, sha256(apk));
  assert.deepEqual(result.details.flags, ["-r", "-g"]);
});

test("flags are passed in a fixed order and explicitly refuse replacement unless approved", { skip: !posix }, async () => {
  const device = sandboxDevice();
  await install(context(device), { testOnly: true, downgrade: true, replace: false });
  assert.match(device.pmCalls[0].command, /pm install -d -t -R /);
  const plain = sandboxDevice();
  await install(context(plain), undefined);
  assert.match(plain.pmCalls[0].command, /pm install -R '\/data\/local\/tmp\//);
});

test("an app that is already installed is replaced only when the user approved replacement, on the package manager's real rules", { skip: !posix }, async () => {
  const outcome = async (sdk, options, deviceOptions = {}) => {
    const pm = packageManager({ sdk, installed: true });
    const device = sandboxDevice({ pm, props: sdk === undefined ? {} : { "ro.build.version.sdk": String(sdk) }, ...deviceOptions });
    const ctx = context(device);
    const result = await install(ctx, options).then((value) => ({ result: value }), (error) => ({ error }));
    return { pm, device, ctx, ...result };
  };

  // Android 14: replacing is the default, so an unapproved install must say -R, and the app survives.
  const refused = await outcome(34, undefined);
  assert.match(refused.device.pmCalls[0].command, /pm install -R '/);
  assert.match(refused.error?.message ?? "", /pm install failed: Failure \[INSTALL_FAILED_ALREADY_EXISTS/);
  assert.equal(refused.pm.state.installs, 0, "the installed app was not replaced");
  assert.match(refused.ctx.confirmations[0].backup, /will not replace an app that is already installed/);
  assert.match(refused.ctx.confirmations[0].details, /left alone and the install fails instead/);

  // The same device with replacement approved: -r is passed, -R is not, and the app is replaced.
  const approved = await outcome(34, { replace: true });
  assert.match(approved.device.pmCalls[0].command, /pm install -r '/);
  assert.equal(approved.result.verified, true);
  assert.equal(approved.pm.state.replaced, true);
  assert.equal(approved.result.details.apiLevel, 34);
  assert.match(approved.ctx.confirmations[0].details, /installed copy of the app is replaced/);

  // Android 8: replacement is off unless -r is given, and -R does not exist, so no -R may be sent.
  const legacyRefused = await outcome(26, undefined);
  assert.deepEqual(legacyRefused.device.pmCalls[0].flags, []);
  assert.match(legacyRefused.error?.message ?? "", /INSTALL_FAILED_ALREADY_EXISTS/);
  assert.equal(legacyRefused.pm.state.installs, 0);
  const legacyApproved = await outcome(26, { replace: true, downgrade: true });
  assert.deepEqual(legacyApproved.device.pmCalls[0].flags, ["-r", "-d"]);
  assert.equal(legacyApproved.result.verified, true);

  // The first release with the modern rules is Android 9.
  const pie = await outcome(28, undefined);
  assert.deepEqual(pie.device.pmCalls[0].flags, ["-R"]);
  assert.equal(pie.pm.state.installs, 0);

  // An API level that cannot be read is treated as modern: on an old device that is an error, never a silent replacement.
  const unknownLegacy = await outcome(undefined, undefined, { pm: packageManager({ sdk: 24, installed: true }) });
  assert.deepEqual(unknownLegacy.device.pmCalls[0].flags, ["-R"]);
  assert.match(unknownLegacy.error?.message ?? "", /Unknown option -R/);
  assert.equal(unknownLegacy.device.pmCalls.length, 1);

  // Nothing is left behind on the device by any of these.
  for (const run of [refused, approved, legacyRefused, legacyApproved, pie, unknownLegacy]) assert.deepEqual(readdirSync(run.device.root), [], "the staged copy and its chunks were removed");
});

/** A manager whose device is a sandboxed adbd, and a way to wait for what it does. */
function managerFor(device) {
  const provider = { async borrowHardwareTransport() { return { transport: device.transport, identity: "usb:18d1:4ee0:cronos", async release() { device.transport.close(); } }; } };
  return new DeviceOperationManager("install", provider, { async getInput() { return new Blob([apk]); }, async save() { return "saved"; } }, [adbFlasher]);
}

test("an install started through the manager is approved only by typing the exact confirmation, and what is installed is what was approved", { skip: !posix }, async () => {
  const pm = packageManager({ sdk: 34, installed: false });
  const device = sandboxDevice({ pm, props: { "ro.build.version.sdk": "34" } });
  const manager = managerFor(device);
  const { id } = manager.startUser({ deviceId: "usb-1", protocol: "adb", action: "install", fileId: "apk-1", sha256: sha256(apk), options: { grantPermissions: true } });
  const waiting = await until(() => manager.status(id).state === "awaiting-confirmation" && manager.status(id));
  const { confirmation } = waiting;
  const typed = `install:${sha256(apk).slice(0, 8)}`;
  assert.equal(confirmation.binding.protectedOverride, typed, "the card has a text field to type this into");
  assert.match(confirmation.binding.target, /^pm install -g -R '\/data\/local\/tmp\/cody-install-[0-9a-f]{16}\.apk'$/);
  assert.equal(confirmation.binding.sha256, sha256(apk));

  // The one click the review found sufficient is not: an empty, partial or other-package value is refused.
  for (const wrong of [undefined, "", "install", typed.slice(0, -1), `install:${"0".repeat(8)}`, typed.toUpperCase()]) {
    assert.throws(() => manager.confirm(id, confirmation.id, confirmation.binding, wrong), /Type the exact protected-target override/, JSON.stringify(wrong));
  }
  assert.equal(manager.status(id).state, "awaiting-confirmation");
  assert.equal(device.writes.length, 0, "no byte reached the device while approval was missing");
  assert.equal(pm.state.calls.length, 0);
  // A binding that differs from what was shown is refused too, even with the right text.
  assert.throws(() => manager.confirm(id, confirmation.id, { ...confirmation.binding, target: "pm install '/data/local/tmp/other.apk'" }, typed), /no longer matches/);

  manager.confirm(id, confirmation.id, confirmation.binding, typed);
  const done = await until(() => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state) && manager.status(id));
  assert.equal(done.state, "succeeded", done.error);
  assert.deepEqual(device.pmCalls.map((call) => call.flags), [["-g", "-R"]]);
  assert.deepEqual(device.pmCalls[0].apk, apk);
  assert.equal(pm.state.installs, 1);
});

test("a copy that fails verification, runs out of space, or is cancelled leaves nothing behind on the device", { skip: !posix }, async () => {
  const leftovers = (device) => readdirSync(device.root);

  // The bytes arrive damaged: the hash check on the device refuses them, and pm install is never run.
  const corrupt = sandboxDevice({ syncFault: "corrupt" });
  await assert.rejects(install(context(corrupt)), /staging verification failed for chunk 0/);
  assert.equal(corrupt.pmCalls.length, 0);
  assert.deepEqual(leftovers(corrupt), [], "no staging directory, no partial chunk, no assembled APK");

  // The device fills up part-way through the copy: a half-written chunk is on disk until cleanup removes it.
  const full = sandboxDevice({ syncFault: "no-space" });
  const ctx = context(full);
  await assert.rejects(install(ctx), /No space left on device/);
  assert.equal(full.pmCalls.length, 0);
  assert.deepEqual(leftovers(full), []);

  // A different APK failing the same way accumulates nothing either.
  const other = buildZip([{ name: "AndroidManifest.xml", data: "another manifest", method: "store" }, { name: "classes.dex", data: patterned(4000, 7), method: "deflate" }]);
  const second = sandboxDevice({ syncFault: "corrupt" });
  await assert.rejects(adbFlasher.run({ protocol: "adb", action: "install", sha256: sha256(other) }, { ...context(second), input: new Blob([other]) }), /staging verification failed/);
  assert.deepEqual(leftovers(second), []);

  // Cancelling mid-copy still cleans up: the connection is kept just long enough to remove the staging files.
  const cancelling = sandboxDevice();
  const controller = new AbortController();
  const cancelCtx = context(cancelling, { signal: controller.signal });
  cancelCtx.progress = (event) => { cancelCtx.events.push(event); if (event.phase === "adb.push.resume") controller.abort(); };
  await assert.rejects(install(cancelCtx));
  assert.equal(cancelling.pmCalls.length, 0);
  assert.deepEqual(leftovers(cancelling), [], "cancelled before pm install ran, and nothing was left");
});

test("a cancel after the copy resumed on a replacement connection still removes the APK and its staging files, over that connection", { skip: !posix }, async () => {
  const controller = new AbortController();
  // The first connection fails while the chunk is being written; the same device is then reached through a distinct connection.
  const first = sandboxDevice({ syncFault: "disconnect" });
  let cancelled = false;
  const second = sandboxDevice({ root: first.root, onService: () => { if (!cancelled) { cancelled = true; controller.abort(); } } });
  const ctx = { ...context(first, { signal: controller.signal }), input: new Blob([apk]) };
  let reacquired = 0;
  ctx.reacquireTransport = async () => { reacquired += 1; ctx.transport = second.transport; return second.transport; };

  await assert.rejects(adbFlasher.run({ protocol: "adb", action: "install", sha256: sha256(apk) }, ctx), (error) => error.name === "AbortError");
  assert.equal(reacquired, 1, "the copy was resumed once");
  assert.equal(ctx.transport, second.transport, "on a different transport object");
  assert.equal(cancelled, true, "the cancel arrived on the replacement connection");
  assert.equal(second.pmCalls.length, 0, "before pm install ran");
  assert.deepEqual(readdirSync(first.root), [], "the staging directory, and everything else, was removed");
  assert.ok(second.services.some((service) => /rm -r -f/.test(service)), "and it was removed over the replacement connection, which the cancel did not tear down");
});

test("cancelling while pm install is running ends the wait for the package manager, removes the staged copy over the same connection, and returns promptly, on both shell protocols", { skip: !posix }, async () => {
  for (const features of ["", "shell_v2"]) {
    const label = features || "exec";
    // A package manager that has started and stays silent.
    const device = sandboxDevice({ features, pm: () => undefined });
    const controller = new AbortController();
    const ctx = context(device, { signal: controller.signal });
    const running = install(ctx).then(() => undefined, (error) => error);
    await until(() => device.pmCalls.length === 1);
    assert.ok(readdirSync(device.root).length > 0, `${label}: the staged copy is on the device while pm runs`);

    const cancelledAt = Date.now();
    controller.abort();
    const outcome = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 4000))]);
    assert.notEqual(outcome, "still waiting", `${label}: Cancel did not reach the wait for the package manager`);
    assert.equal(outcome?.name, "AbortError", label);
    assert.ok(Date.now() - cancelledAt < 3000, `${label}: ${Date.now() - cancelledAt} ms to end the install`);
    assert.deepEqual(readdirSync(device.root), [], `${label}: the staged copy and its chunks were removed, over the connection the cancel did not tear down`);
    assert.equal(device.pmCalls.length, 1, `${label}: pm was started once and never again`);
    assert.match(device.services.at(-1), /rm -r -f/, `${label}: the removal was the last thing asked of the device`);
    assert.match(ctx.outputs.join("\n"), /Cancelled while pm install was running.*may still finish installing/s, `${label}: the operator is told pm may still complete`);
  }
});

test("an install cancelled while the package manager is silent ends as cancelled through the manager, and the device is given back only after the cleanup", { skip: !posix }, async () => {
  const device = sandboxDevice({ pm: () => undefined });
  let leftOnTheDevice;
  let releases = 0;
  const provider = {
    async borrowHardwareTransport() {
      return { transport: device.transport, identity: "usb:18d1:4ee0:cronos", async release() { releases += 1; leftOnTheDevice = readdirSync(device.root); device.transport.close(); } };
    },
  };
  const manager = new DeviceOperationManager("install-cancel", provider, { async getInput() { return new Blob([apk]); }, async save() { return "saved"; } }, [adbFlasher]);
  const { id } = manager.startUser({ deviceId: "usb-1", protocol: "adb", action: "install", fileId: "apk-1", sha256: sha256(apk) });
  const waiting = await until(() => manager.status(id).state === "awaiting-confirmation" && manager.status(id));
  manager.confirm(id, waiting.confirmation.id, waiting.confirmation.binding, `install:${sha256(apk).slice(0, 8)}`);
  await until(() => device.pmCalls.length === 1);

  manager.cancel(id);
  const done = await until(() => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state) && manager.status(id));
  assert.equal(done.state, "cancelled", done.error);
  assert.equal(releases, 1);
  assert.deepEqual(leftOnTheDevice, [], "nothing was left on the device when the lease was released");
  assert.ok(done.output.some((row) => /may still finish installing/.test(row.line)));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = (manager, id) => until(() => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state) && manager.status(id), 8000);

/** A manager over a provider whose first lease is `first` and whose reacquisition (if any) is `replacement`; counts every lease given back. */
function installManager({ first, replacement }) {
  const seen = { released: 0 };
  const identity = "usb:18d1:4ee0:cronos";
  const provider = {
    async borrowHardwareTransport() { return { transport: first.transport, identity, async release() { seen.released += 1; first.transport.close(); } }; },
    ...(replacement ? { async reacquireHardwareTransport() { return { transport: replacement, identity, async release() { seen.released += 1; } }; } } : {}),
  };
  const manager = new DeviceOperationManager("install-silence", provider, { async getInput() { return new Blob([apk]); }, async save() { return "saved"; } }, [adbFlasher]);
  return {
    manager,
    seen,
    async start() {
      const { id } = manager.startUser({ deviceId: "usb-1", protocol: "adb", action: "install", fileId: "apk-1", sha256: sha256(apk) });
      const waiting = await until(() => manager.status(id).state === "awaiting-confirmation" && manager.status(id));
      manager.confirm(id, waiting.confirmation.id, waiting.confirmation.binding, `install:${sha256(apk).slice(0, 8)}`);
      return id;
    },
  };
}

test("cancelling while the replacement connection is still authenticating ends the install at once, starts no further authentication, and gives the device back", { skip: !posix }, async () => {
  // The copy fails on a lost connection and is resumed on a replacement whose daemon says nothing, not even to the CONNECT.
  const controller = new AbortController();
  const first = sandboxDevice({ syncFault: "disconnect" });
  const muted = mutedTransport();
  const ctx = { ...context(first, { signal: controller.signal }), input: new Blob([apk]) };
  ctx.reacquireTransport = async () => { ctx.transport = muted; return muted; };
  const running = adbFlasher.run({ protocol: "adb", action: "install", sha256: sha256(apk) }, ctx).then(() => undefined, (error) => error);
  await until(() => muted.writes >= 1);
  await sleep(150);
  const sent = muted.writes;
  const cancelledAt = Date.now();
  controller.abort();
  const outcome = await Promise.race([running, sleep(4000).then(() => "still waiting")]);
  assert.notEqual(outcome, "still waiting", "Cancel did not reach the replacement connection's authentication");
  assert.equal(outcome?.name, "AbortError");
  assert.ok(Date.now() - cancelledAt < 2000, `${Date.now() - cancelledAt} ms to end the install`);
  await sleep(300);
  assert.equal(muted.writes, sent, "the cleanup did not start another authentication on the silent transport");

  // Through the manager: the operation is cancelled and both leases are given back, the first when the copy was resumed and the replacement when the install ended.
  const second = sandboxDevice({ syncFault: "disconnect" });
  const quiet = mutedTransport();
  const { manager, seen, start } = installManager({ first: second, replacement: quiet });
  const id = await start();
  await until(() => quiet.writes >= 1);
  await sleep(100);
  const askedAt = Date.now();
  manager.cancel(id);
  const done = await terminal(manager, id);
  assert.equal(done.state, "cancelled", done.error);
  assert.ok(Date.now() - askedAt < 2500, `${Date.now() - askedAt} ms to end the operation`);
  assert.equal(seen.released, 2);
});

test("opening the package-manager stream or the cleanup stream is bounded by Cancel and by the cleanup limit, and the lease comes back when that limit passes", { skip: !posix }, async () => {
  const limit = adbLimits.cleanupMs;
  adbLimits.cleanupMs = 600;
  try {
    // The daemon never acknowledges the OPEN of pm install: Cancel ends the wait, and the staged copy is removed over the same connection.
    const device = sandboxDevice({ silentOpen: (service) => /pm install/.test(service) });
    const controller = new AbortController();
    const ctx = context(device, { signal: controller.signal });
    const running = install(ctx).then(() => undefined, (error) => error);
    await until(() => device.services.some((service) => /pm install/.test(service)));
    await sleep(100);
    const cancelledAt = Date.now();
    controller.abort();
    const outcome = await Promise.race([running, sleep(4000).then(() => "still waiting")]);
    assert.notEqual(outcome, "still waiting", "Cancel did not reach the wait for pm install's OPEN");
    assert.equal(outcome?.name, "AbortError");
    assert.ok(Date.now() - cancelledAt < 2000, `${Date.now() - cancelledAt} ms to end the install`);
    assert.deepEqual(readdirSync(device.root), [], "the staged copy was removed over the connection the cancel did not tear down");
    assert.match(device.services.at(-1), /rm -r -f/);
    assert.equal(device.services.filter((service) => /pm install/.test(service)).length, 1, "pm was asked for once");

    // The daemon goes quiet from pm install on, so the cleanup's own stream is never acknowledged either: the cleanup limit ends the wait and the lease is given back.
    let muted = false;
    const silent = sandboxDevice({ silentOpen: (service) => { if (/pm install/.test(service)) muted = true; return muted; } });
    const { manager, seen, start } = installManager({ first: silent });
    const id = await start();
    await until(() => silent.services.some((service) => /pm install/.test(service)));
    await sleep(100);
    const askedAt = Date.now();
    manager.cancel(id);
    const done = await terminal(manager, id);
    const took = Date.now() - askedAt;
    assert.equal(done.state, "cancelled", done.error);
    assert.equal(seen.released, 1, "the lease came back");
    assert.ok(took >= 500 && took < 3500, `${took} ms: the cleanup was bounded by its own limit (600 ms), neither skipped nor unbounded`);
    assert.match(silent.services.at(-1), /rm -r -f/, "the cleanup stream was asked for and never acknowledged");
  } finally {
    adbLimits.cleanupMs = limit;
  }
});

test("a package-manager failure is reported with its reason, and the staged copy is still removed", { skip: !posix }, async () => {
  const device = sandboxDevice({ pm: { output: "Failure [INSTALL_FAILED_ALREADY_EXISTS: Attempt to re-install without -r]", status: 1 } });
  await assert.rejects(install(context(device)), /pm install failed: Failure \[INSTALL_FAILED_ALREADY_EXISTS.*The staged copy was removed/);
  assert.equal(existsSync(join(device.root, `cody-install-${sha256(apk).slice(0, 16)}.apk`)), false);
  const silent = sandboxDevice({ pm: { output: "", status: 0 } });
  await assert.rejects(install(context(silent)), /pm install failed/, "a zero exit without the word Success is not an install");
});

test("a file that is not an APK, unknown options, and a wrong digest are refused before anything is copied or run", { skip: !posix }, async () => {
  const notApk = buildZip([{ name: "readme.txt", data: "hello", method: "store" }]);
  const cases = [
    [{ input: new Blob([notApk]), sha256: sha256(notApk) }, undefined, /not an APK/],
    [{ input: new Blob(["definitely not a zip file at all"]), sha256: sha256("definitely not a zip file at all") }, undefined, /not an APK/],
    [{}, { replaec: true }, /Unknown install option "replaec"/],
    [{}, { replace: "yes" }, /replace must be true or false/],
    [{}, { toString: true }, /Unknown install option "toString"/],
    [{ sha256: "0".repeat(64) }, undefined, /SHA-256 does not match/],
  ];
  for (const [over, options, message] of cases) {
    const device = sandboxDevice();
    const ctx = context(device, over.input ? { input: over.input } : {});
    await assert.rejects(adbFlasher.run({ protocol: "adb", action: "install", sha256: over.sha256 ?? sha256(apk), options }, { ...ctx, input: ctx.input ?? new Blob([apk]) }), message);
    assert.equal(ctx.confirmations.length, 0);
    assert.equal(device.writes.length, 0);
    assert.equal(device.pmCalls.length, 0);
  }
});

test("declining the install leaves the device without the APK", { skip: !posix }, async () => {
  const device = sandboxDevice();
  const ctx = context(device, { confirm: async () => { throw new DOMException("Declined", "AbortError"); } });
  await assert.rejects(install(ctx), /Declined/);
  assert.equal(device.writes.length, 0);
  assert.equal(device.pmCalls.length, 0);
});

// ---------------------------------------------------------------------------
// adb root / unroot / tcpip / usb
// ---------------------------------------------------------------------------

/** Runs a restart request; the device after adbd restarted is a second connection that answers getprop with the new state. */
async function restart(options, { answer = {}, after = {}, reconnect = true } = {}) {
  const first = sandboxDevice({ answers: answer });
  const second = sandboxDevice({ props: after });
  const ctx = context(first);
  if (reconnect) ctx.reacquireTransport = async () => { ctx.transport = second.transport; return second.transport; };
  const result = await exec(ctx, options);
  return { result, first, second, ctx };
}

test("adb root asks, restarts adbd, reconnects to the same device, and checks the state it reports", { skip: !posix }, async () => {
  const { result, first, ctx } = await restart({ kind: "root" }, { answer: { "root:": "restarting adbd as root\n" }, after: { "service.adb.root": "1" } });
  assert.equal(ctx.confirmations[0].action, "adb.root");
  assert.ok(first.services.includes("root:"));
  assert.equal(result.verified, true);
  assert.equal(result.details.restarted, true);
  assert.deepEqual(result.details.observed, { "service.adb.root": "1" });
});

test("adb root on a device that does not become root is reported as not verified, not as success", { skip: !posix }, async () => {
  const { result } = await restart({ kind: "root" }, { answer: { "root:": "restarting adbd as root\n" }, after: { "service.adb.root": "0" } });
  assert.equal(result.verified, false);
  assert.match(result.summary, /does not report the requested state/);
});

test("root on an already-root daemon changes nothing and does not reconnect; a production build's refusal is surfaced", { skip: !posix }, async () => {
  const first = sandboxDevice({ answers: { "root:": "adbd is already running as root\n" } });
  let reconnects = 0;
  const ctx = context(first, { reacquireTransport: async () => { reconnects += 1; return first.transport; } });
  const result = await exec(ctx, { kind: "root" });
  assert.equal(result.verified, true);
  assert.equal(result.details.restarted, false);
  assert.equal(reconnects, 0);
  const refused = sandboxDevice({ answers: { "root:": "adbd cannot run as root in production builds\n" } });
  await assert.rejects(exec(context(refused), { kind: "root" }), /adbd refused root:: adbd cannot run as root in production builds/);
});

test("unroot, tcpip and usb each send their own service and verify the device's own report", { skip: !posix }, async () => {
  const unroot = await restart({ kind: "unroot" }, { answer: { "unroot:": "restarting adbd as non root\n" }, after: { "service.adb.root": "0" } });
  assert.equal(unroot.result.verified, true);
  assert.ok(unroot.first.services.includes("unroot:"));

  const tcpip = await restart({ kind: "tcpip", port: 5555 }, { answer: { "tcpip:5555": "restarting in TCP mode port: 5555\n" }, after: { "service.adb.tcp.port": "5555" } });
  assert.equal(tcpip.result.verified, true);
  assert.match(tcpip.ctx.confirmations[0].details, /Cody keeps using USB/);
  assert.equal(tcpip.ctx.confirmations[0].target, "tcpip:5555");

  const wrongPort = await restart({ kind: "tcpip", port: 5555 }, { answer: { "tcpip:5555": "restarting in TCP mode port: 5555\n" }, after: { "service.adb.tcp.port": "5556" } });
  assert.equal(wrongPort.result.verified, false);

  const usb = await restart({ kind: "usb" }, { answer: { "usb:": "restarting in USB mode\n" }, after: { "service.adb.tcp.port": "0" } });
  assert.equal(usb.result.verified, true);
  const stillTcp = await restart({ kind: "usb" }, { answer: { "usb:": "restarting in USB mode\n" }, after: { "service.adb.tcp.port": "5555" } });
  assert.equal(stillTcp.result.verified, false);
});

test("tcpip refuses a missing, privileged or non-integer port before asking or sending anything", { skip: !posix }, async () => {
  for (const port of [undefined, 80, 1023, 65536, 5555.5, "5555"]) {
    const device = sandboxDevice();
    const ctx = context(device);
    await assert.rejects(exec(ctx, { kind: "tcpip", port }), /tcpip needs options\.port/);
    assert.equal(ctx.confirmations.length, 0);
    assert.equal(device.services.length, 0);
  }
});

test("when Cody cannot reconnect after a restart it says so and claims nothing", { skip: !posix }, async () => {
  const { result } = await restart({ kind: "root" }, { answer: { "root:": "restarting adbd as root\n" }, reconnect: false });
  assert.equal(result.verified, false);
  assert.equal(result.details.restarted, true);
  assert.match(result.summary, /could not reconnect to check it/);
});

test("declining a restart sends no service to the device", { skip: !posix }, async () => {
  const device = sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } });
  await assert.rejects(exec(context(device, { confirm: async () => { throw new DOMException("Declined", "AbortError"); } }), { kind: "root" }), /Declined/);
  assert.equal(device.services.includes("root:"), false);
});

// ---------------------------------------------------------------------------
// adb wait-for-device
// ---------------------------------------------------------------------------

test("wait-for-device options are bounded and validated", () => {
  const request = (options) => ({ protocol: "adb", action: "exec", options });
  assert.equal(adbWaitOptions({ protocol: "adb", action: "exec" }), undefined);
  assert.equal(adbWaitOptions(request({ kind: "shell" })), undefined);
  assert.equal(adbWaitOptions({ protocol: "fastboot", action: "exec", options: { kind: "wait-for-device" } }), undefined);
  assert.deepEqual(adbWaitOptions(request({ kind: "wait-for-device" })), { timeoutMs: 60_000, pollMs: 1000, state: "device" });
  assert.deepEqual(adbWaitOptions(request({ kind: "wait-for-device", timeoutSeconds: 600, pollMs: 100, state: "sideload" })), { timeoutMs: 600_000, pollMs: 100, state: "sideload" });
  for (const options of [{ timeoutSeconds: 0 }, { timeoutSeconds: 601 }, { timeoutSeconds: 1.5 }, { timeoutSeconds: "5" }, { pollMs: 99 }, { pollMs: 5001 }, { state: "bootloader" }]) {
    assert.throws(() => adbWaitOptions(request({ kind: "wait-for-device", ...options })), /wait-for-device/, JSON.stringify(options));
  }
});

test("wait-for-device keeps trying until the daemon answers, then reports the device", { skip: !posix }, async () => {
  const booting = { transport: bootingTransport() };
  const ready = sandboxDevice({ props: { "ro.product.model": "Cronos", "ro.build.version.release": "14" } });
  let reacquired = 0;
  const ctx = context(booting, { reacquireTransport: async () => { reacquired += 1; ctx.transport = reacquired >= 2 ? ready.transport : bootingTransport(); return ctx.transport; } });
  const result = await exec(ctx, { kind: "wait-for-device", timeoutSeconds: 10, pollMs: 100 });
  assert.equal(result.verified, true);
  assert.equal(result.details.model, "Cronos");
  assert.equal(result.details.state, "device");
  assert.equal(reacquired, 2);
  assert.ok(ctx.events.some((event) => event.phase === "adb.wait" && /ADB connection was not established/.test(event.message)));
  assert.equal(ctx.confirmations.length, 0, "waiting changes nothing, so it asks nothing");
});

test("wait-for-device gives up at the end of its window, and a device in the wrong state is named", { skip: !posix }, async () => {
  const started = Date.now();
  await assert.rejects(exec(context({ transport: bootingTransport() }), { kind: "wait-for-device", timeoutSeconds: 1, pollMs: 100 }), /did not reach the device state within 1 s \(ADB connection was not established/);
  assert.ok(Date.now() - started >= 900);
  const online = sandboxDevice();
  await assert.rejects(exec(context(online), { kind: "wait-for-device", state: "recovery", timeoutSeconds: 1, pollMs: 100 }), /the device is in device state, waiting for recovery/);
});

test("a cancelled wait stops at once", { skip: !posix }, async () => {
  const controller = new AbortController();
  const ctx = context({ transport: bootingTransport() }, { signal: controller.signal });
  const pending = exec(ctx, { kind: "wait-for-device", timeoutSeconds: 60, pollMs: 5000 });
  setTimeout(() => controller.abort(), 150);
  const started = Date.now();
  await assert.rejects(pending);
  assert.ok(Date.now() - started < 2000);
});

test("through the manager, wait-for-device retries a device that is not attached yet, while any other operation fails at once", { skip: !posix }, async () => {
  const device = sandboxDevice({ props: { "ro.product.model": "Cronos" } });
  let attempts = 0;
  const provider = {
    async borrowHardwareTransport() {
      attempts += 1;
      if (attempts < 3) throw new Error("No such device: usb-1.");
      return { transport: device.transport, async release() { device.transport.close(); } };
    },
  };
  const manager = new DeviceOperationManager("wait", provider, { async getInput() {}, async save() { return "saved"; } }, [adbFlasher]);
  const { id } = manager.start({ deviceId: "usb-1", protocol: "adb", action: "exec", options: { kind: "wait-for-device", timeoutSeconds: 5, pollMs: 100 } });
  const done = await until(() => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state) && manager.status(id));
  assert.equal(done.state, "succeeded", done.error);
  assert.equal(attempts, 3);
  assert.ok(done.events.some((event) => event.progress?.phase === "waiting"));

  attempts = 0;
  const impatient = manager.start({ deviceId: "usb-1", protocol: "adb", action: "detect" });
  const failed = await until(() => manager.status(impatient.id).state === "failed" && manager.status(impatient.id));
  assert.match(failed.error, /No such device/);
  assert.equal(attempts, 1, "no retry for an ordinary operation");

  const never = new DeviceOperationManager("wait2", { async borrowHardwareTransport() { throw new Error("No such device: usb-1."); } }, { async getInput() {}, async save() { return "saved"; } }, [adbFlasher]);
  const gaveUp = never.start({ deviceId: "usb-1", protocol: "adb", action: "exec", options: { kind: "wait-for-device", timeoutSeconds: 1, pollMs: 100 } });
  const timedOut = await until(() => never.status(gaveUp.id).state === "failed" && never.status(gaveUp.id));
  assert.match(timedOut.error, /did not become available within 1 s: No such device/);
});

// ---------------------------------------------------------------------------
// agent tools
// ---------------------------------------------------------------------------

test("device_install needs an artifact and its digest, and the new exec kinds need no command", async () => {
  const starts = [];
  const bridge = {
    attached: true,
    list: () => [{ id: "usb-1", label: "Phone", kind: "usb", open: true }],
    async startOperation(request) { starts.push(request); return "operation-1"; },
  };
  const tool = (name) => DEVICE_OPERATION_TOOLS.find((candidate) => candidate.name === name);
  assert.match(await tool("device_install").handler({ device: "usb-1", protocol: "adb" }, { bridge }), /install requires a session artifact and its exact SHA-256/);
  assert.equal(starts.length, 0);
  assert.match(await tool("device_install").handler({ device: "usb-1", protocol: "adb", fileId: "apk-1", sha256: "a".repeat(64), options: { replace: true } }, { bridge }), /operation-1.*accepted/);
  for (const kind of ["root", "unroot", "usb", "wait-for-device", "tcpip"]) {
    assert.match(await tool("device_exec").handler({ device: "usb-1", protocol: "adb", options: { kind } }, { bridge }), /accepted/, kind);
  }
  assert.deepEqual(starts.map((request) => [request.action, request.options?.kind ?? "-"]), [["install", "-"], ["exec", "root"], ["exec", "unroot"], ["exec", "usb"], ["exec", "wait-for-device"], ["exec", "tcpip"]]);
  assert.match(await tool("device_exec").handler({ device: "usb-1", protocol: "adb", options: { kind: "shell" } }, { bridge }), /requires command/);
});
