import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const authDir = mkdtempSync(join(tmpdir(), "cody-wireless-auth-"));
process.on("exit", () => rmSync(authDir, { recursive: true, force: true }));
process.env.CODY_ACCOUNTS_DIR = join(authDir, "accounts");
process.env.PI_CODING_AGENT_DIR = join(authDir, "agent");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { WirelessService } = await jiti.import("./wireless-service.ts");
const { prepareWirelessOperation, prepareWirelessPull, prepareWirelessPush, WIRELESS_CONNECTION_PROBE } = await jiti.import("./wireless-service-command.ts");
const { WirelessTransportError } = await jiti.import("./wireless-transport.ts");
const { WIRELESS_MAX_FILE_BYTES } = await jiti.import("./wireless-types.ts");
const { createWirelessOriginGate, verifiedWirelessOrigin } = await jiti.import("./wireless-origin.ts");
const { handleWirelessGet, handleWirelessPost, handleWirelessShell } = await jiti.import("./wireless-service-http.ts");
const { createUser, findUserById } = await jiti.import("../auth/users.ts");
const { getSessionOwner, setSessionOwner } = await jiti.import("../auth/session-owners.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");

const PAYLOAD = { action: "pair", sessionId: "chat-a", host: "192.168.201.181", pairingPort: 40123, connectPort: 45675, code: "771804" };
const PAIRING_ID = "d0".repeat(16);
const result = (stdout = "", exitCode = 0, stderr = "") => ({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode });

function fakeTransport() {
  const transport = {
    events: [], links: [], commands: [],
    available: () => true,
    async reap(scope, keep) { this.events.push(["reap", scope.sessionId, [...keep]]); },
    async pair(scope, address, code, signal) {
      this.events.push(["pair", scope.sessionId, address]);
      return this.atPair ? this.atPair(code, signal) : PAIRING_ID;
    },
    async connect(scope, id, address, signal) {
      this.events.push(["connect", scope.sessionId, id, address]);
      await this.atConnect?.(address, signal);
      const closed = new AbortController();
      const link = {
        address, closed: closed.signal,
        close: async () => closed.abort(),
        run: async (args, options) => {
          assert.deepEqual(args.slice(0, 2), ["shell", "-T"]);
          if (args[2] === WIRELESS_CONNECTION_PROBE) return result("Test tablet\n", this.rootAdbd ? 73 : 0);
          this.commands.push({ command: args[2], options });
          return this.atRun ? this.atRun(args[2], options) : result("hello");
        },
      };
      this.links.push(link);
      return link;
    },
    async disconnect(scope) {
      this.events.push(["disconnect", scope.sessionId]);
      await this.links.at(-1)?.close();
    },
    async revoke(scope, id) {
      this.events.push(["revoke", scope.sessionId, id]);
      await this.links.at(-1)?.close();
      await this.atRevoke?.();
    },
  };
  return transport;
}

function fixture(t, { transport = fakeTransport(), owners = new Map([["chat-a", "alice"], ["chat-b", "bob"]]), retryMs = 60_000, initial } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cody-wireless-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "devices.json");
  if (initial) writeFileSync(path, initial, { mode: 0o600 });
  let now = Date.now();
  const service = new WirelessService({ path, transport, ownsSession: (owner, id) => owners.get(id) === owner, now: () => now, retryMs });
  const action = (name, extra = {}) => service.pageAction("alice", {
    action: name, sessionId: "chat-a", selectionId: service.pageSnapshot("alice", "chat-a").device?.selectionId, ...extra,
  });
  return { transport, service, action, path, advance: (ms) => { now += ms; } };
}

async function until(read) {
  for (let cycle = 0; cycle < 150; cycle++) {
    if (read()) return;
    await delay(2);
  }
  assert.fail("The wireless transition did not settle");
}

test("pairs one exact private endpoint and persists only scoped metadata, not the code or browser connection", async (t) => {
  const { service, action, path, transport } = fixture(t);
  const observed = [];
  const unsubscribe = service.subscribe("chat-a", () => observed.push(service.pageSnapshot("alice", "chat-a").status));
  transport.atPair = (code) => { assert.equal(code, PAYLOAD.code); return PAIRING_ID; };
  for (const invalid of [
    { host: "tablet.example" }, { host: "127.0.0.1" }, { host: "169.254.169.254" }, { host: "8.8.8.8" },
    { host: "192.168.001.2" }, { host: "::ffff:192.168.1.1" }, { host: "192.168.1.1@localhost" },
    { pairingPort: 5037 }, { connectPort: 5555 }, { connectPort: PAYLOAD.pairingPort }, { code: "77x804" },
  ]) await assert.rejects(service.pageAction("alice", { ...PAYLOAD, ...invalid }), { status: 400 });
  assert.deepEqual(transport.events, []);
  const paired = await service.pageAction("alice", PAYLOAD);
  assert.equal(paired.status, "connected");
  assert.equal(paired.device.label, "Test tablet");
  assert.equal(paired.device.clientName, "Cody@d0d0d0d0");
  assert.deepEqual(observed, ["pairing", "offline", "connecting", "connected"]);
  const stored = readFileSync(path, "utf8");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(stored.includes(PAYLOAD.code), false);
  assert.equal(stored.includes(String(PAYLOAD.pairingPort)), false);
  assert.deepEqual(transport.events.find(([op]) => op === "connect").slice(2), [PAIRING_ID, `${PAYLOAD.host}:${PAYLOAD.connectPort}`]);
  assert.equal(service.agentSnapshot("chat-b").device, null);
  assert.throws(() => service.agentRun("chat-b", { kind: "inspect", query: "identity" }), { code: "needs_pairing" });
  assert.throws(() => service.pageSnapshot("bob", "chat-a"), { status: 404 });
  assert.equal((await service.agentRun("chat-a", { kind: "inspect", query: "battery" })).stdout.toString(), "hello");
  unsubscribe();

  const restart = fixture(t, { initial: stored, retryMs: 5 });
  await until(() => restart.service.agentSnapshot("chat-a").status === "connected");
  assert.equal(restart.transport.events.some(([op]) => op === "pair"), false);
  await restart.action("forget");

  assert.equal((await action("disconnect")).status, "disconnected");
  const disconnected = fixture(t, { initial: readFileSync(path, "utf8"), retryMs: 5 });
  await delay(20);
  assert.equal(disconnected.service.agentSnapshot("chat-a").status, "disconnected");
  assert.equal(disconnected.transport.events.some(([op]) => op === "connect"), false);
  await disconnected.action("forget");
  assert.equal((await action("forget")).device, null);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).records, []);
});

test("a failed code leaks no child error text and pairing attempts are rate-limited", async (t) => {
  const { service, transport } = fixture(t);
  transport.atPair = (code) => { throw Object.assign(new WirelessTransportError("pairing_failed"), { message: `private diagnostic ${code}` }); };
  for (let tryNo = 0; tryNo < 5; tryNo++) {
    await assert.rejects(service.pageAction("alice", PAYLOAD), (error) => error.code === "pairing_failed" && !error.message.includes(PAYLOAD.code));
  }
  const snapshot = service.pageSnapshot("alice", "chat-a");
  assert.equal(snapshot.device, null);
  assert.equal(JSON.stringify(snapshot).includes(PAYLOAD.code), false);
  await assert.rejects(service.pageAction("alice", PAYLOAD), { code: "limit", status: 429 });
  assert.equal(transport.events.filter(([op]) => op === "pair").length, 5);
});

test("a changed port is saved only after identity and ordinary-shell checks", async (t) => {
  const { service, transport, action } = fixture(t);
  await service.pageAction("alice", PAYLOAD);
  transport.atConnect = (address) => {
    if (address.endsWith(":41234")) throw new WirelessTransportError("identity_mismatch");
  };
  const rejected = await action("connect", { connectPort: 41234 });
  assert.equal(rejected.device.connectPort, PAYLOAD.connectPort);
  assert.equal(rejected.error.code, "identity_mismatch");
  assert.throws(() => service.agentRun("chat-a", { kind: "inspect", query: "identity" }), { code: "not_connected" });
  transport.rootAdbd = true;
  assert.equal((await action("connect")).error.code, "ordinary_shell_required");
  transport.rootAdbd = false;
  const connected = await action("connect", { connectPort: 41235 });
  assert.equal(connected.device.connectPort, 41235);
  assert.equal(connected.status, "connected");
  assert.equal(transport.commands.length, 0);
  await action("forget");
});

test("connect loss invalidates a pending approval; a new approval runs one exact command only", async (t) => {
  const { service, transport, action, advance } = fixture(t, { retryMs: 5 });
  await service.pageAction("alice", PAYLOAD);
  const command = "echo 'tablet' && id";
  const stale = service.requestApproval("chat-a", { command, elevated: true });
  assert.throws(() => service.requestApproval("chat-a", { command }), { code: "invalid_operation" });
  assert.equal(transport.commands.length, 0);
  await transport.links.at(-1).close();
  assert.equal(service.approvalResult("chat-a", stale.id).state, "cancelled");
  await until(() => service.agentSnapshot("chat-a").status === "connected");
  await assert.rejects(action("root", { requestId: stale.id, decision: "approve" }), { code: "approval_not_pending" });
  const expired = service.requestApproval("chat-a", { command, elevated: false });
  advance(120_001);
  await assert.rejects(action("root", { requestId: expired.id, decision: "approve" }), { code: "approval_not_pending" });
  assert.equal(service.approvalResult("chat-a", expired.id).state, "expired");
  const denied = service.requestApproval("chat-a", { command, elevated: true });
  await action("root", { requestId: denied.id, decision: "deny" });
  assert.equal(service.approvalResult("chat-a", denied.id).state, "denied");
  const approved = service.requestApproval("chat-a", { command, elevated: true });
  const first = action("root", { requestId: approved.id, decision: "approve" });
  await assert.rejects(action("root", { requestId: approved.id, decision: "approve" }), { code: "approval_not_pending" });
  await first;
  await until(() => service.approvalResult("chat-a", approved.id).state === "finished");
  assert.equal(service.approvalResult("chat-a", approved.id).result.stdout.toString(), "hello");
  assert.equal(transport.commands.length, 1);
  assert.ok(transport.commands[0].command.endsWith("exec /system/bin/su -c 'echo '\\''tablet'\\'' && id'"));

  const arbitrary = service.requestApproval("chat-a", { command: "su -c id", elevated: false });
  assert.equal(transport.commands.length, 1);
  const pending = Promise.withResolvers();
  transport.atRun = () => pending.promise;
  await action("root", { requestId: arbitrary.id, decision: "approve" });
  assert.ok(transport.commands[1].command.endsWith("exec /system/bin/sh -c 'su -c id'"));
  assert.equal((await action("connect", { connectPort: 41236 })).status, "connected");
  assert.equal(transport.commands[1].options.signal.aborted, true);
  pending.resolve(result());
  await until(() => service.approvalResult("chat-a", arbitrary.id).state === "finished");
  assert.equal(service.approvalResult("chat-a", arbitrary.id).error.code, "completion_unknown");
  assert.equal(transport.commands.length, 2);
  await action("forget");
});

test("a late push result after disconnect is unknown; reconnect never resends it", async (t) => {
  const { service, transport, action } = fixture(t, { retryMs: 5 });
  await service.pageAction("alice", PAYLOAD);
  const pending = Promise.withResolvers();
  transport.atRun = () => pending.promise;
  const outcome = assert.rejects(service.agentPush("chat-a", "/sdcard/Download/example.bin", async () => Buffer.from([0, 255])), { code: "completion_unknown" });
  await until(() => transport.commands.length === 1);
  assert.deepEqual(transport.commands[0].options.stdin, Buffer.from([0, 255]));
  await action("disconnect");
  assert.equal(transport.commands[0].options.signal.aborted, true);
  pending.resolve(result());
  await outcome;
  await action("connect");
  assert.equal(transport.commands.length, 1);
  await action("forget");
});

test("push validates and reserves the pinned link before reading workspace bytes", async (t) => {
  const { service, transport, action } = fixture(t);
  let reads = 0;
  const read = async () => { reads++; return Buffer.from([1]); };
  assert.throws(() => service.agentPush("chat-a", "/sdcard/Download/a", read), { code: "needs_pairing" });
  await service.pageAction("alice", PAYLOAD);
  assert.throws(() => service.agentPush("chat-a", "/dev/block/a", read), { code: "path_not_allowed" });
  await assert.rejects(service.agentPush("chat-a", "/sdcard/Download/a", read, AbortSignal.abort()), { code: "cancelled" });
  assert.equal(reads, 0);
  const localError = new Error("Could not read the selected workspace file");
  await assert.rejects(service.agentPush("chat-a", "/sdcard/Download/a", async () => { throw localError; }), localError);
  assert.equal(transport.commands.length, 0);

  const pending = Promise.withResolvers();
  let pinned;
  const old = assert.rejects(service.agentPush("chat-a", "/sdcard/Download/a", (signal) => {
    pinned = signal;
    return pending.promise;
  }), { code: "cancelled" });
  await assert.rejects(service.agentPush("chat-a", "/sdcard/Download/b", read), { code: "busy" });
  assert.equal(reads, 0);
  const replaced = await action("connect", { connectPort: 41235 });
  assert.equal(replaced.status, "connected");
  assert.equal(pinned.aborted, true);
  pending.resolve(Buffer.from([1]));
  await old;
  assert.equal(transport.commands.length, 0);
  await service.agentPush("chat-a", "/sdcard/Download/b", read);
  assert.equal(reads, 1);
  assert.equal(transport.commands.length, 1);
  await action("forget");
});

test("pull holds tablet and global capacity until a cancelled or failed workspace save settles", async (t) => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    ownerId: `owner-${index}`, sessionId: `pull-${index}`, host: `192.168.201.${181 + index}`,
  }));
  const { service, transport } = fixture(t, { owners: new Map(sessions.map(({ ownerId, sessionId }) => [sessionId, ownerId])) });
  for (const { ownerId, sessionId, host } of sessions) {
    await service.pageAction(ownerId, { ...PAYLOAD, sessionId, host });
  }
  const inspect = (index) => service.agentRun(sessions[index].sessionId, { kind: "inspect", query: "identity" });
  const pulls = [];
  const pull = (index) => {
    const gate = Promise.withResolvers();
    const save = { gate };
    save.done = service.agentPull(sessions[index].sessionId, "/sdcard/notes", (bytes, signal) => {
      save.bytes = bytes;
      save.signal = signal;
      return gate.promise;
    });
    pulls.push(save);
    return save;
  };
  try {
    const first = pull(0);
    await until(() => first.signal);
    assert.equal(first.bytes.toString(), "hello");
    assert.equal(first.signal, transport.commands[0].options.signal, "one cancellation signal covers download and save");
    await assert.rejects(inspect(0), { code: "busy" });
    for (let index = 1; index < 6; index++) pull(index);
    await until(() => pulls.every((save) => save.signal));
    await assert.rejects(inspect(6), { code: "busy" });

    const cancelled = assert.rejects(first.done, { code: "cancelled" });
    const { ownerId, sessionId } = sessions[0];
    const selectionId = service.pageSnapshot(ownerId, sessionId).device.selectionId;
    assert.equal((await service.pageAction(ownerId, { action: "connect", sessionId, selectionId, connectPort: 41235 })).status, "connected");
    assert.equal(first.signal.aborted, true);
    await assert.rejects(inspect(6), { code: "busy" });
    first.gate.reject(first.signal.reason);
    await cancelled;
    assert.equal((await inspect(6)).exitCode, 0);

    const diskError = new Error("Unable to save the workspace file");
    const failed = assert.rejects(pulls[1].done, (error) => error === diskError);
    pulls[1].gate.reject(diskError);
    await failed;
    assert.equal((await inspect(1)).exitCode, 0);

    transport.atRun = () => result("incomplete", 1);
    assert.equal((await service.agentPull(sessionId, "/sdcard/notes", () => assert.fail("failed downloads must not be saved"))).exitCode, 1);
  } finally {
    for (const { gate } of pulls) gate.resolve();
    await Promise.allSettled(pulls.map(({ done }) => done));
  }
});

test("stale confirmations cannot run a manual or approved command, reconnect, disconnect or forget another tablet", async (t) => {
  const { service, action, transport } = fixture(t);
  const first = await service.pageAction("alice", PAYLOAD);
  const selectionId = first.device.selectionId;
  const request = service.requestApproval("chat-a", { command: "id", elevated: true });
  await action("forget");
  const second = await service.pageAction("alice", { ...PAYLOAD, host: "192.168.201.182" });
  assert.notEqual(second.device.selectionId, selectionId);
  const count = transport.events.length;
  for (const name of ["connect", "disconnect", "forget"]) await assert.rejects(action(name, { selectionId }), { code: "selection_changed" });
  await assert.rejects(action("root", { selectionId, requestId: request.id, decision: "approve" }), { code: "selection_changed" });
  assert.throws(() => service.pageShell("alice", { sessionId: "chat-a", selectionId, command: "id", rootCapableConfirmed: true }), { code: "selection_changed" });
  assert.equal(transport.events.length, count);
  assert.equal(transport.commands.length, 0);
  assert.equal(service.pageSnapshot("alice", "chat-a").device.selectionId, second.device.selectionId);
  await action("forget");
});

test("deleting a chat revokes a late pairing and prevents a new pairing until owner deletion finishes", async (t) => {
  const { service, transport } = fixture(t);
  const entered = Promise.withResolvers();
  const allowReturn = Promise.withResolvers();
  transport.atPair = (_, signal) => { entered.resolve(signal); return allowReturn.promise; };
  const pending = assert.rejects(service.pageAction("alice", PAYLOAD), { code: "cancelled" });
  const signal = await entered.promise;
  const deleting = service.forgetSession("chat-a", "alice");
  assert.equal(signal.aborted, true);
  allowReturn.resolve(PAIRING_ID);
  await pending;
  await deleting;
  assert.equal(service.agentSnapshot("chat-a").status, "unpaired");
  assert.ok(transport.events.some(([op, , id]) => op === "revoke" && id === PAIRING_ID));
  assert.equal(transport.events.some(([op]) => op === "connect"), false);
  await assert.rejects(service.pageAction("alice", PAYLOAD), { code: "session_not_found" });
});

test("a revoke failure leaves no usable selection and a durable cleanup marker", async (t) => {
  const { service, transport, action, path } = fixture(t);
  await service.pageAction("alice", PAYLOAD);
  transport.atRevoke = () => { throw new Error("private path"); };
  await assert.rejects(action("forget"), (error) => error.code === "revoke_failed" && !error.message.includes("private path"));
  assert.equal(service.agentSnapshot("chat-a").device, null);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).records[0].revoked, true);
  await assert.rejects(action("connect"), { code: "needs_pairing" });
  transport.atRevoke = undefined;
  await service.forgetSession("chat-a", "alice");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).records, []);
});

test("structured operations never accept a shell command, block unsafe paths, and bound binary output", () => {
  for (const operation of [
    { kind: "shell", command: "su" }, { kind: "inspect", query: "properties", filter: "$(id)" },
    { kind: "inspect", query: "constructor" }, { kind: "inspect", query: "packages", filter: "-u" },
    { kind: "logcat", tag: "A; su", lines: 20 }, { kind: "logcat", lines: 1001 },
    { kind: "logcat", buffer: "all" }, { kind: "logcat", priority: "I;" },
    { kind: "pull", path: "/sdcard/Download/a" },
    { kind: "push", path: "/sdcard/Download/a" },
  ]) assert.throws(() => prepareWirelessOperation(operation), { status: 400 });
  for (const path of ["/dev/block/by-name/boot", "/data/adb/magisk", "/sdcard/../dev/block/a", "/sdcard//Download/x", "/sdcard\n/su", "/storage/emulated/0/Android/Data/file"]) {
    assert.throws(() => prepareWirelessPull(path), { code: "path_not_allowed" });
  }
  const pull = prepareWirelessPull("/sdcard/Download/';$(touch proof);.bin");
  assert.match(pull.command, /id -u.*= 2000/);
  assert.ok(pull.command.includes("'Download/'\\'';$(touch proof);.bin'"));
  assert.match(pull.command, /realpath -- "\$file"/);
  assert.equal(pull.maxOutputBytes, WIRELESS_MAX_FILE_BYTES);
  assert.throws(() => prepareWirelessPush("/sdcard/example")(Buffer.alloc(WIRELESS_MAX_FILE_BYTES + 1)), { status: 400 });
  const push = prepareWirelessPush("/sdcard/example")(Buffer.alloc(0));
  assert.match(push.command, /\[ ! -e "\$file" \] && \[ ! -L "\$file" \]/);
  assert.match(push.command, /set -C; cat > "\$file"/);
});

const WIRELESS_PATH = "/api/devices/wireless";
const WIRELESS_PROOF = "x-cody-internal-wireless-origin";
const PROXY = "172.28.0.2";
const BACKEND = "172.28.0.3";

function socketRequest(url, fields, remoteAddress, localAddress = BACKEND) {
  return { url, headers: Object.fromEntries(new Headers(fields)), rawHeaders: Object.entries(fields).flat(), socket: { remoteAddress, localAddress } };
}

test("launcher strips inbound proof on every path and checks the real proxy or loopback peer", () => {
  const env = { CODY_PUBLIC_ORIGIN: "https://cody.example.test", CODY_TRUSTED_PROXY_IP: PROXY };
  const mark = createWirelessOriginGate(env);
  const verified = (raw, headers = raw.headers) => verifiedWirelessOrigin(new Request("https://localhost:30177" + raw.url, { headers }), env);
  const forwarded = { Host: "cody.example.test", "X-Forwarded-Proto": "https" };
  const caddy = socketRequest(WIRELESS_PATH, forwarded, `::ffff:${PROXY}`);
  mark(caddy);
  assert.equal(verified(caddy), env.CODY_PUBLIC_ORIGIN);
  const signed = caddy.headers[WIRELESS_PROOF];
  assert.equal(verified(caddy, { [WIRELESS_PROOF]: signed.replace("cody.example.test", "other.example.test") }), undefined);

  for (const [path, peer, upgraded, headers] of [
    [WIRELESS_PATH, "192.168.1.5", false, { ...forwarded, "X-Forwarded-For": PROXY }],
    [WIRELESS_PATH, PROXY, false, { ...forwarded, "X-Forwarded-Proto": "https, http" }],
    [WIRELESS_PATH, PROXY, false, { ...forwarded, Host: "other.example.test", "X-Forwarded-Host": "cody.example.test" }],
    [WIRELESS_PATH, PROXY, true, forwarded],
    ["/api/display/native", PROXY, false, forwarded],
  ]) {
    const raw = socketRequest(path, { ...headers, "X-Cody-Internal-Wireless-Origin": signed }, peer);
    mark(raw, upgraded);
    assert.equal(verified(raw), undefined);
    assert.equal(raw.headers[WIRELESS_PROOF], undefined);
    assert.equal(raw.rawHeaders.some((field) => field.toLowerCase() === WIRELESS_PROOF), false);
  }

  const loop = (peer, local, headers = {}) => {
    const raw = socketRequest(WIRELESS_PATH, { Host: "127.0.0.1:30177", ...headers }, peer, local);
    mark(raw);
    return verified(raw);
  };
  assert.equal(loop("::ffff:127.0.0.1", "127.0.0.1"), "http://127.0.0.1:30177");
  assert.equal(loop("192.168.1.5", BACKEND), undefined);
  assert.equal(loop("127.0.0.1", BACKEND), undefined);
  assert.equal(loop("127.0.0.1", "127.0.0.1", { "X-Forwarded-For": "192.168.1.5" }), undefined);

  for (const configuration of [{ CODY_PUBLIC_ORIGIN: env.CODY_PUBLIC_ORIGIN }, { CODY_TRUSTED_PROXY_IP: PROXY }]) {
    const raw = socketRequest(WIRELESS_PATH, forwarded, PROXY);
    createWirelessOriginGate(configuration)(raw);
    assert.equal(raw.headers[WIRELESS_PROOF], undefined);
  }
});

test("only a same-origin signed-in owner page can pair, run a direct shell, or decide approvals", async (t) => {
  const alice = createUser({ username: "alice", fullName: "Alice", role: "member", passwordHash: "unused in test" });
  const bob = createUser({ username: "bob", fullName: "Bob", role: "member", passwordHash: "unused in test" });
  setSessionOwner("chat-a", alice.id);
  const owners = { get: (id) => {
    const owner = getSessionOwner(id);
    return owner && findUserById(owner) ? owner : undefined;
  } };
  const { service, transport } = fixture(t, { owners });
  const cookie = (user) => `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}`;
  const origin = "https://cody.nateshome.net";
  // Caddy's backend connection sets Host and X-Forwarded-Proto; Next may use an internal hostname in req.url.
  const url = `https://localhost:30177${WIRELESS_PATH}`;
  const proofKey = "CODY_INTERNAL_WIRELESS_ORIGIN_KEY";
  const oldKey = process.env[proofKey];
  const env = { CODY_PUBLIC_ORIGIN: origin, CODY_TRUSTED_PROXY_IP: PROXY };
  const mark = createWirelessOriginGate(env);
  process.env[proofKey] = env[proofKey];
  t.after(() => {
    if (oldKey === undefined) delete process.env[proofKey];
    else process.env[proofKey] = oldKey;
  });
  const request = (effectiveUrl, fields, { peer = PROXY, local = BACKEND, ...init } = {}) => {
    const headers = { "X-Forwarded-Proto": "https", ...fields };
    for (const field of Object.keys(headers)) if (headers[field] === null) delete headers[field];
    const { pathname, search } = new URL(effectiveUrl);
    const raw = socketRequest(pathname + search, headers, peer, local);
    mark(raw);
    return new Request(effectiveUrl, { ...init, headers: raw.headers });
  };
  const host = new URL(origin).host;
  const post = (body, headers = {}, handler = handleWirelessPost, { effectiveUrl = handler === handleWirelessShell ? `${url}/shell` : url, ...network } = {}) => handler(request(effectiveUrl, {
    Host: host, Origin: origin, Cookie: cookie(alice), "Content-Type": "application/json", ...headers,
  }, { ...network, method: "POST", body: JSON.stringify(body) }), service);
  const get = (sessionId, user) => handleWirelessGet(request(`${url}?sessionId=${sessionId}`, {
    Host: host, Cookie: cookie(user), "Sec-Fetch-Site": "same-origin",
  }), service);
  assert.equal((await post(PAYLOAD, { Authorization: "Bearer engine-capability" })).status, 403);
  assert.equal((await post(PAYLOAD, { Cookie: "" })).status, 401);
  assert.equal((await post(PAYLOAD, { Origin: "https://other.test" })).status, 403);
  for (const malformed of ["", "null", `${origin}/`, `${origin}, ${origin}`]) {
    assert.equal((await post(PAYLOAD, { Origin: malformed, "Sec-Fetch-Site": "same-origin" })).status, 403);
  }
  assert.equal((await post(PAYLOAD, { Origin: null, "Sec-Fetch-Site": "same-origin" })).status, 403);
  const insecure = `http://localhost:30177${WIRELESS_PATH}`;
  const untrusted = { peer: "192.168.1.5" };
  const spoofed = await post(PAYLOAD, { "X-Forwarded-Host": host }, handleWirelessPost, untrusted);
  const refusal = await spoofed.json();
  assert.equal(spoofed.status, 403);
  assert.equal(refusal.code, "secure_origin_required");
  assert.match(refusal.error, /CODY_PUBLIC_ORIGIN.*CODY_TRUSTED_PROXY_IP/);
  const bareNext = new Request(url, {
    method: "POST",
    headers: { Host: host, Origin: origin, Cookie: cookie(alice), "Content-Type": "application/json", [WIRELESS_PROOF]: `${origin} ${"A".repeat(43)}` },
    body: JSON.stringify(PAYLOAD),
  });
  assert.equal((await handleWirelessPost(bareNext, service)).status, 403);
  assert.equal((await post(PAYLOAD, { Origin: `http://${host}` }, handleWirelessPost, { ...untrusted, effectiveUrl: insecure })).status, 403);
  assert.equal((await post(PAYLOAD, { Origin: `http://${host}` })).status, 403);
  const loopback = await post({ ...PAYLOAD, sessionId: "unowned-chat" }, {
    Host: "localhost:30177", Origin: "http://localhost:30177", "X-Forwarded-Proto": null,
  }, handleWirelessPost, { effectiveUrl: insecure, peer: "127.0.0.1", local: "127.0.0.1" });
  assert.equal(loopback.status, 404, "trusted loopback reached the exact owner gate");
  assert.equal((await post(PAYLOAD, { Cookie: cookie(bob) })).status, 404);
  assert.equal(get("unowned-chat", alice).status, 404);
  assert.equal(transport.events.length, 0);
  const paired = await post(PAYLOAD, { "X-Forwarded-Proto": "https", "Sec-Fetch-Site": "same-origin" });
  assert.equal(paired.status, 200);
  assert.equal(paired.headers.get("cache-control"), "no-store");
  const payload = await paired.text();
  assert.equal(payload.includes(PAYLOAD.code), false);
  assert.equal(payload.includes(PAIRING_ID), false);
  assert.equal(get("chat-a", bob).status, 404);
  const ask = service.requestApproval("chat-a", { command: "id", elevated: true });
  const selectionId = JSON.parse(payload).device.selectionId;
  const decision = { action: "root", sessionId: "chat-a", selectionId, requestId: ask.id, decision: "approve", command: "different command" };
  assert.equal((await post(decision, { Authorization: "Basic dGVzdDp0ZXN0" })).status, 403);
  assert.equal((await post(decision, { Cookie: cookie(bob) })).status, 404);
  const shell = { sessionId: "chat-a", selectionId, command: "id" };
  assert.equal((await post({ ...shell, elevated: true }, {}, handleWirelessShell)).status, 400);
  const unconfirmed = await post({ ...shell, command: "su -c id", rootCapableConfirmed: false }, {}, handleWirelessShell);
  assert.equal((await unconfirmed.json()).code, "command_confirmation_required");
  assert.equal((await post(decision, { Origin: "" })).status, 403);
  assert.equal(transport.commands.length, 0);
  const direct = await post({ ...shell, rootCapableConfirmed: true }, {}, handleWirelessShell);
  assert.deepEqual(await direct.json(), { stdout: "hello", stderr: "", exitCode: 0 });
  assert.ok(transport.commands[0].command.endsWith("exec /system/bin/sh -c 'id'"));
  assert.equal((await post(decision)).status, 200);
  assert.ok(transport.commands[1].command.endsWith("exec /system/bin/su -c 'id'"));
  assert.equal((await post({ ...PAYLOAD, code: "1".repeat(10_000) })).status, 413);
  await service.forgetSession("chat-a", alice.id);
});
