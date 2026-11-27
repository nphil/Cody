import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEVICE_TOOLS } = await jiti.import("./tools.ts");
const { createWirelessTools, hasSelectedWirelessDevice } = await jiti.import("./wireless-tools.ts");
const { WirelessServiceError } = await jiti.import("./wireless-service.ts");
const { WIRELESS_MAX_FILE_BYTES } = await jiti.import("./wireless-types.ts");

const linux = { skip: process.platform !== "linux" };
const bound = { sessionId: "bound-chat" };
const result = (stdout = Buffer.alloc(0), exitCode = 0, stderr = Buffer.alloc(0)) => ({ stdout, stderr, exitCode });

function toolsFor(handlers = {}) {
  const calls = [];
  const service = {
    agentRun: async (...args) => { calls.push(["run", ...args]); return result(Buffer.from("Android output")); },
    agentPull: async (id, path, saveBytes, signal) => {
      const downloaded = result(Buffer.from("Android output"));
      calls.push(["pull", id, path, signal]);
      await saveBytes(downloaded.stdout, signal ?? new AbortController().signal);
      return downloaded;
    },
    agentPush: async (id, path, loadBytes, signal) => {
      const bytes = await loadBytes(signal ?? new AbortController().signal);
      calls.push(["push", id, path, bytes, signal]);
      return result();
    },
    requestApproval: (...args) => { calls.push(["request", ...args]); return { id: "request-1", expiresAt: Date.parse("2030-01-01T00:00:00.000Z") }; },
    approvalResult: (...args) => { calls.push(["status", ...args]); return { state: "pending" }; },
    ...handlers,
  };
  const tools = new Map(createWirelessTools(() => service).map((tool) => [tool.name, tool.handler]));
  return { calls, run: (name, args, context = bound) => tools.get(`wireless_${name}`)(args, context) };
}

async function workspace(t) {
  const root = await realpath(await mkdtemp(join(process.env.CODY_DATA_SCRATCH || tmpdir(), "wireless-tool-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  return { root, cwd, context: { ...bound, cwd } };
}

function installService(t, service) {
  const original = globalThis.__codyWirelessService;
  globalThis.__codyWirelessService = service;
  t.after(() => { globalThis.__codyWirelessService = original; });
}

test("diagnostics and log reads carry only structured data and the dispatcher's chat", async () => {
  const { run, calls } = toolsFor();
  const signal = new AbortController().signal;
  const injected = { sessionId: "other-chat", device: "another-tablet", host: "192.0.2.1", elevated: true };
  assert.match(await run("inspect", { ...injected, query: "battery" }, { ...bound, signal }), /Android output/);
  assert.match(await run("logcat", { ...injected, buffer: "crash", lines: 12, tag: "app", priority: "E" }), /Exit code: 0/);
  assert.deepEqual(calls, [
    ["run", "bound-chat", { kind: "inspect", query: "battery", filter: undefined }, signal],
    ["run", "bound-chat", { kind: "logcat", buffer: "crash", lines: 12, tag: "app", priority: "E" }, undefined],
  ]);
  assert.match(await run("inspect", { query: "shell", command: "id" }), /Choose a diagnostic query/);
  assert.match(await run("logcat", { lines: 1.5 }), /positive whole number/);
  assert.match(await run("inspect", { query: "battery", sessionId: "bound-chat" }, {}), /needs an authorized Cody chat/);
  assert.equal(calls.length, 2, "invalid calls never dispatch");
});

test("arbitrary commands need an explicit elevation choice and only request approval", async () => {
  const { run, calls } = toolsFor();
  assert.match(await run("request_command", { command: "id" }), /Set elevated/);
  const text = await run("request_command", { command: " id ", elevated: true, reason: "Check user", decision: "approve", remember: true });
  assert.match(text, /Waiting for approval.*Request ID: request-1.*wireless_command_status/);
  assert.match(await run("command_status", { requestId: "request-1", sessionId: "other-chat", decision: "approve" }), /Still waiting/);
  assert.deepEqual(calls, [
    ["request", "bound-chat", { command: " id ", elevated: true, reason: "Check user" }],
    ["status", "bound-chat", "request-1"],
  ]);
});

test("completed output is bounded and a lost result does not cause another command", async () => {
  const { run, calls } = toolsFor({
    approvalResult: () => ({ state: "finished", error: { code: "completion_unknown", message: "Tablet disconnected." } }),
  });
  assert.match(await run("command_status", { requestId: "request-1" }), /Tablet disconnected.*Check what changed.*did not replay/);
  assert.deepEqual(calls, []);
  const large = toolsFor({ agentRun: async () => result(Buffer.alloc(100_000, 65), 0, Buffer.alloc(100_000, 66)) });
  const text = await large.run("logcat", {});
  assert.match(text, /Output shortened/);
  assert.ok(Buffer.byteLength(text) < 33_000);
});

test("device_list shows a selected tablet without an attached browser or endpoint details", async (t) => {
  let status = "offline";
  let label = "Study tablet";
  installService(t, {
    agentSnapshot: (id) => ({
      supported: true, status, rootRequests: [],
      device: id === bound.sessionId ? { label, host: "192.0.2.1", connectPort: 34217 } : null,
    }),
  });
  const handler = DEVICE_TOOLS.find((tool) => tool.name === "device_list").handler;
  const bridge = { attached: false };
  const text = await handler({}, { bridge, ...bound });
  label = "192.0.2.1:34217";
  assert.doesNotMatch(await handler({}, { bridge, ...bound }), /192\.0\.2\.1|34217/, "an address fallback label is private too");
  assert.match(text, /Study tablet.*offline/);
  assert.doesNotMatch(text, /192\.0\.2\.1|34217/);
  assert.equal(hasSelectedWirelessDevice(bound.sessionId), true, "a link drop does not change the roster");
  status = "connected";
  assert.match(await handler({}, { bridge, ...bound }), /browser does not need to stay open/);
  assert.equal(hasSelectedWirelessDevice("another-chat"), false);
  assert.match(await handler({}, { bridge, sessionId: "another-chat" }), /no tablet selected/);
});

test("transfers use only real workspace files and publish a pull without overwriting", linux, async (t) => {
  const { root, cwd, context } = await workspace(t);
  const outside = join(root, "secret");
  await writeFile(outside, "outside");
  await symlink(outside, join(cwd, "symlink"));
  await link(outside, join(cwd, "hardlink"));
  await symlink(root, join(cwd, "elsewhere"));
  await writeFile(join(cwd, "oversize"), "");
  await truncate(join(cwd, "oversize"), WIRELESS_MAX_FILE_BYTES + 1);
  await writeFile(join(cwd, "send.bin"), Buffer.of(0, 233, 255));

  const { run, calls } = toolsFor();
  const send = { action: "push", path: "/sdcard/send.bin" };
  for (const workspacePath of ["../secret", outside, ".secret", "symlink", "hardlink", "elsewhere/secret", "oversize"]) {
    assert.doesNotMatch(await run("files", { ...send, workspacePath }, context), /Pushed/);
  }
  assert.equal(calls.length, 0, "unsafe or oversized local sources never reach Android");
  assert.match(await run("files", { ...send, workspacePath: "send.bin" }, context), /Pushed 3 bytes/);
  assert.deepEqual(calls[0], ["push", "bound-chat", send.path, Buffer.of(0, 233, 255), undefined]);

  const receive = { action: "pull", path: "/sdcard/readme.txt" };
  assert.match(await run("files", { ...receive, workspacePath: "symlink" }, context), /nothing was overwritten/);
  assert.match(await run("files", { ...receive, workspacePath: "elsewhere/created" }, context), /real workspace path/);
  await assert.rejects(readFile(join(root, "created")), { code: "ENOENT" });
  assert.equal(await readFile(outside, "utf8"), "outside");
  assert.equal(await run("files", { ...receive, workspacePath: "readme.txt" }, context), `Saved "readme.txt" (14 bytes, SHA-256 ${createHash("sha256").update("Android output").digest("hex")}).`);
  assert.equal(await readFile(join(cwd, "readme.txt"), "utf8"), "Android output");
  assert.deepEqual(calls.at(-1), ["pull", "bound-chat", receive.path, undefined]);
});

test("a push refused by the service reports that refusal before opening the workspace file", linux, async (t) => {
  const { context } = await workspace(t);
  let reservations = 0;
  const { run } = toolsFor({
    agentPush(id, path, loadBytes) {
      reservations++;
      assert.equal(id, bound.sessionId);
      assert.equal(path, "/sdcard/write.bin");
      assert.equal(typeof loadBytes, "function");
      throw new WirelessServiceError("busy", "Wireless ADB is busy. No command was sent.");
    },
  });
  const text = await run("files", { action: "push", path: "/sdcard/write.bin", workspacePath: "not-present.bin" }, context);
  assert.match(text, /Wireless ADB is busy\. No command was sent/);
  assert.equal(reservations, 1, "a missing source cannot fail before the service checks capacity");
});

test("a reserved push source uses the connection's cancellation signal, not just the caller's", linux, async (t) => {
  const { cwd, context } = await workspace(t);
  await writeFile(join(cwd, "write.bin"), "data");
  const caller = new AbortController();
  const connection = new AbortController();
  const { run } = toolsFor({
    async agentPush(_id, _path, loadBytes, signal) {
      assert.equal(signal, caller.signal);
      const read = loadBytes(connection.signal);
      connection.abort();
      await assert.rejects(read, { name: "AbortError" });
      throw new WirelessServiceError("cancelled", "The tablet changed. No file was sent.");
    },
  });
  const text = await run("files", { action: "push", path: "/sdcard/write.bin", workspacePath: "write.bin" }, { ...context, signal: caller.signal });
  assert.match(text, /The tablet changed\. No file was sent/);
  assert.equal(caller.signal.aborted, false);
});

test("failed or cancelled downloads never appear as workspace files", linux, async (t) => {
  const { cwd, context } = await workspace(t);
  const args = { action: "pull", path: "/sdcard/notes", workspacePath: "notes" };
  const failed = toolsFor({ agentPull: async () => result(Buffer.from("partial bytes"), 1, Buffer.from("transfer failed")) });
  const text = await failed.run("files", args, context);
  assert.match(text, /Nothing was saved.*Exit code: 1/s);
  assert.doesNotMatch(text, /partial bytes/);
  const stop = new AbortController();
  const cancelled = toolsFor({
    async agentPull(id, path, saveBytes, signal) {
      assert.equal(id, bound.sessionId);
      assert.equal(path, args.path);
      assert.equal(signal, stop.signal);
      await assert.rejects(saveBytes(Buffer.from("not saved"), AbortSignal.abort()), { name: "AbortError" });
      throw new WirelessServiceError("cancelled", "The tablet download was cancelled.");
    },
  });
  assert.match(await cancelled.run("files", args, { ...context, signal: stop.signal }), /cancelled/);
  assert.equal(stop.signal.aborted, false, "the connection can cancel publication independently of the caller");
  await assert.rejects(readFile(join(cwd, "notes")), { code: "ENOENT" });
});

test("an interrupted push reports uncertain completion and is not retried", linux, async (t) => {
  const { cwd, context } = await workspace(t);
  await writeFile(join(cwd, "write.bin"), "data");
  let attempts = 0;
  const { run } = toolsFor({ agentPush: async (_id, _path, loadBytes) => {
    attempts++;
    await loadBytes(new AbortController().signal);
    throw new WirelessServiceError("completion_unknown", "The connection ended before a reply.");
  } });
  assert.match(await run("files", { action: "push", path: "/sdcard/write.bin", workspacePath: "write.bin" }, context), /Check what changed.*did not replay/);
  assert.equal(attempts, 1);
});

test("the internal route rejects a different session and only dispatches bound wireless tools", async (t) => {
  process.env.CODY_INTERNAL_DISPLAY_SECRET = randomBytes(32).toString("base64url");
  const { issueDisplayCapability } = await jiti.import("../display/capability.ts");
  const { peekDeviceBridge } = await jiti.import("./bus.ts");
  const { POST } = await jiti.import("../../app/api/internal/devices/route.ts");
  const signal = new AbortController();
  const calls = [];
  installService(t, { agentRun: async (id, operation, signal) => { calls.push([id, operation, signal]); return result(); } });
  const sessionId = "wireless-route-chat";
  const capability = issueDisplayCapability(sessionId);
  const post = (sid, tool, args) => POST(new Request("http://localhost/api/internal/devices", {
    method: "POST", headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, tool, arguments: args }), signal: signal.signal,
  }));
  assert.equal((await post("other-chat", "wireless_inspect", { query: "identity" })).status, 403);
  assert.equal((await post(sessionId, "wireless_approve", {})).status, 400);
  assert.equal((await post(sessionId, "wireless_pair", {})).status, 400);
  assert.equal(calls.length, 0);
  const response = await post(sessionId, "wireless_inspect", { query: "identity", sessionId: "other-chat" });
  assert.equal(response.status, 200);
  assert.match((await response.json()).text, /Exit code: 0/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), [sessionId, { kind: "inspect", query: "identity", filter: undefined }]);
  signal.abort();
  assert.ok(calls[0][2].aborted, "request cancellation reaches the service signal");
  assert.equal(peekDeviceBridge(sessionId), null, "a wireless call does not create a browser bridge");
});
