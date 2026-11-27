import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { WirelessTransport, WirelessTransportError, parseWirelessAddress, wirelessClientName } = await jiti.import("./wireless-transport.ts");

const scope = { ownerId: "owner-1", sessionId: "chat-1" };
const otherChat = { ...scope, sessionId: "chat-2" };
const otherOwner = { ...scope, ownerId: "owner-2" };
const pairing = "192.168.20.2:43115";
const tablet = "192.168.20.2:43211";
const options = { skip: process.platform !== "linux", timeout: 8_000 };
const fault = (code) => (error) => error instanceof WirelessTransportError && error.code === code;
const shell = (cmd) => ["shell", "-T", cmd];

async function fixture(t) {
  const sandbox = await mkdtemp(join(tmpdir(), "wireless-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const binary = join(sandbox, "adb.mjs");
  const root = join(sandbox, "custody");
  const script = await readFile(new URL("./wireless-transport.test-helper.mjs", import.meta.url), "utf8");
  await writeFile(binary, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  return { adapter: new WirelessTransport({ binary, root }), binary, root };
}

async function homes(root) {
  const directories = await readdir(root);
  return (await Promise.all(directories.map(async (dir) => (await readdir(join(root, dir))).map((id) => join(root, dir, id))))).flat();
}

test("wireless route only accepts an explicit canonical private IPv4 and high port", () => {
  for (const address of ["10.0.0.2:9000", "192.168.0.1:65535", "172.16.0.8:1024", "172.31.0.8:39243"]) {
    assert.equal(parseWirelessAddress(address), address);
  }
  for (const address of [
    "localhost:12345", "127.0.0.1:12345", "192.168.1.2", "192.168.1.2:5555", "192.168.1.2:5037",
    "192.168.01.2:12345", "192.168.256.2:12345", "192.168.1.2:012345", "192.168.1.2:65536",
    "192.168.1.2:12345\n", " 192.168.1.2:12345", "172.32.0.8:12345", "100.64.0.2:12345",
    "169.254.1.2:12345", "[fd00::2]:12345", "8.8.8.8:12345", "192.168.1.2:443",
  ]) assert.throws(() => parseWirelessAddress(address), fault("invalid_address"), address);
});

test("pairing via stdin stores a unique, private key and GUID for each chat, with revocation", options, async (t) => {
  const { adapter, binary, root } = await fixture(t);
  assert(adapter.available());
  await assert.rejects(adapter.pair(scope, pairing, "012345\n"), fault("invalid_code"));
  await assert.rejects(adapter.pair(scope, pairing, "999999"), fault("pairing_failed"));
  assert.deepEqual(await homes(root), []);
  const id = await adapter.pair(scope, pairing, "012345");
  const [home] = await homes(root);
  assert.equal(wirelessClientName(id), `Cody@${id.slice(0, 8)}`);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(home), [".android", "guid"]);
  assert.deepEqual(await readdir(join(home, ".android")), ["adbkey"]);
  assert.equal(await readFile(join(home, "guid"), "utf8"), "adb-fixture-ABCDEF");
  assert.equal((await stat(join(home, "guid"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, ".android", "adbkey"))).mode & 0o777, 0o600);
  await assert.rejects(adapter.connect(otherChat, id, tablet), fault("not_found"));
  await assert.rejects(adapter.connect(otherOwner, id, tablet), fault("not_found"));
  const otherId = await adapter.pair(otherChat, pairing, "012345");
  assert.notEqual(otherId, id);
  const [otherHome] = (await homes(root)).filter((path) => path !== home);
  assert.notDeepEqual(await readFile(join(home, ".android", "adbkey")), await readFile(join(otherHome, ".android", "adbkey")));
  // The custody home, not the previous daemon or its selected port, is reused.
  const restarted = new WirelessTransport({ binary, root });
  const link = await restarted.connect(scope, id, "192.168.20.2:43213");
  t.after(() => link.close());
  await restarted.revoke(scope, id);
  assert(link.closed.aborted);
  await restarted.revoke(scope, id);
  await assert.rejects(restarted.connect(scope, id, tablet), fault("not_found"));
  assert.deepEqual(await homes(root), [otherHome]);
  await restarted.reap(otherChat, new Set([otherId]));
  assert.deepEqual(await homes(root), [otherHome]);
  await restarted.reap(otherChat, new Set());
  assert.deepEqual(await homes(root), []);
});

test("each new connection checks the paired GUID before handing out a shell", options, async (t) => {
  const { adapter } = await fixture(t);
  const id = await adapter.pair(scope, pairing, "012345");
  await assert.rejects(adapter.connect(scope, id, "192.168.20.2:43212"), fault("identity_mismatch"));
  const link = await adapter.connect(scope, id, tablet);
  t.after(() => link.close());
  assert.deepEqual(await link.run(shell("read-only")), { stdout: Buffer.from("metadata"), stderr: Buffer.alloc(0), exitCode: 0 });
  await adapter.disconnect(scope, id);
  assert(link.closed.aborted);
  await assert.rejects(adapter.connect(scope, id, "192.168.20.2:43212"), fault("identity_mismatch"));
});

test("reports the failed reconnect stage without leaking native diagnostics or dropping the pairing", options, async (t) => {
  const { adapter } = await fixture(t);
  const id = await adapter.pair(scope, pairing, "012345");
  for (const [port, code] of [
    [43214, "connection_rejected"],
    [43215, "transport_not_ready"],
    [43216, "transport_unsupported"],
    [43217, "guid_check_failed"], // Nonzero exit.
    [43218, "guid_check_failed"], // No identity, despite a successful exit.
    [43219, "guid_check_failed"], // Link closed without an exit result.
    [43220, "connection_authentication_failed"],
    [43221, "connection_not_established"],
    [43222, "connection_rejected"], // An unrecognized reply with an auth-like prefix.
  ]) {
    await assert.rejects(adapter.connect(scope, id, `192.168.20.2:${port}`), (error) => {
      assert(error instanceof WirelessTransportError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /raw diagnostic|adbkey|adb-fixture-ABCDEF|192\.168\.20\.2/);
      return true;
    });
  }
  const link = await adapter.connect(scope, id, tablet);
  t.after(() => link.close());
  assert.equal((await link.run(shell("read-only"))).exitCode, 0);
});

test("shell-v2 streams binary data, bounds output, and requires the remote exit frame", options, async (t) => {
  const { adapter } = await fixture(t);
  const id = await adapter.pair(scope, pairing, "012345");
  const link = await adapter.connect(scope, id, tablet);
  t.after(() => link.close());
  const payload = Buffer.alloc(65_543, 0xff);
  payload[2] = 0;
  const streamed = [];
  assert.deepEqual(await link.run(shell("echo-input"), {
    stdin: payload, maxOutputBytes: 70_000, onStdout: (chunk) => streamed.push(chunk),
  }), { stdout: payload, stderr: Buffer.from("fixture stderr"), exitCode: 7 });
  assert.deepEqual(Buffer.concat(streamed), payload);
  await assert.rejects(link.run(shell("read-only"), { maxOutputBytes: 3 }), fault("output_limit"));
  const cancellation = new AbortController();
  await assert.rejects(link.run(shell("wait"), { signal: cancellation.signal, onStdout: () => cancellation.abort() }), fault("cancelled"));
  await assert.rejects(link.run(shell("wait"), { timeoutMs: 150 }), fault("timeout"));
  const lost = Promise.withResolvers();
  link.closed.addEventListener("abort", lost.resolve, { once: true });
  await assert.rejects(link.run(shell("lose-link")), fault("connection_lost"));
  await lost.promise;
  await assert.rejects(link.run(shell("read-only")), fault("connection_lost"));
});
