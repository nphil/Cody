// Runs in a Docker build step without network access except loopback. Uses an
// AOSP pairing peer and then a fixture for STLS/CNXN and one read-only command.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createTlsServer } from "node:tls";
import { promisify } from "node:util";

const exec = promisify(execFile);
const binary = "/usr/local/libexec/cody/adb-wireless";
const sandbox = await mkdtemp(join(tmpdir(), "adb-smoke-"));
const home = join(sandbox, "home");
const privateKey = join(home, ".android", "adbkey");
const path = join(sandbox, "adb.sock");
const spec = `localfilesystem:${path}`;
const guid = "adb-CodyTest-123456";
const property = "/system/bin/getprop persist.adb.wifi.guid";
const banner = "device::ro.product.name=fixture;ro.product.model=cody;ro.product.device=fixture;features=shell_v2;";
const adbVersion = 0x01000001;
const stlsVersion = 0x01000000;
const commandOptions = { timeout: 12_000, maxBuffer: 8192 };

function packet(command, arg0, arg1, data = "") {
  const payload = Buffer.from(data);
  const header = Buffer.alloc(24);
  header.write(command, "ascii");
  header.writeUInt32LE(arg0, 4);
  header.writeUInt32LE(arg1, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(payload.reduce((sum, byte) => sum + byte, 0), 16);
  header.writeUInt32LE((header.readUInt32LE(0) ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, payload]);
}

async function read(socket, count) {
  for (;;) {
    const data = socket.read(count);
    if (data?.length === count) return data;
    assert(!data && !socket.destroyed && !socket.readableEnded, "ADB fixture lost its peer");
    // `read(n)` may return null until the full frame arrives, even at EOF.
    const { promise, resolve } = Promise.withResolvers();
    const wake = () => {
      socket.off("readable", wake).off("close", wake).off("end", wake);
      resolve();
    };
    socket.once("readable", wake).once("close", wake).once("end", wake);
    await promise;
  }
}

async function message(socket) {
  const h = await read(socket, 24);
  const length = h.readUInt32LE(12);
  assert(length <= 1024 * 1024);
  return { command: h.toString("ascii", 0, 4), id: h.readUInt32LE(4), data: length ? await read(socket, length) : Buffer.alloc(0) };
}

function frame(kind, payload) {
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function certificate(label, subject, key) {
  const output = join(sandbox, `${label}.pem`);
  await exec("openssl", ["req", "-new", "-x509", "-key", key, "-days", "1", "-subj", subject, "-out", output], commandOptions);
  return readFile(output);
}

async function checkPairing(code, match, key) {
  const peer = spawn("/tmp/adb-wireless-pairing-peer", [join(sandbox, "server.pem"), key], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const peerClosed = once(peer, "close");
  peerClosed.catch(() => {});
  const lines = createInterface({ input: peer.stdout });
  let server, serverClosed;
  try {
    const [port] = await once(lines, "line", { signal: AbortSignal.timeout(3000) });
    assert.match(port, /^\d{4,5}$/);
    const address = `127.0.0.1:${port}`;
    const env = {
      HOME: home, TMPDIR: sandbox, LC_ALL: "C", CODY_ADB_PARENT_PID: String(process.pid),
      CODY_ADB_PAIR_ADDRESS: address, CODY_ADB_CLIENT_LABEL: "Cody@deadbeef",
    };
    server = spawn(binary, ["-L", spec, "server", "nodaemon", "--reply-fd", "3"], {
      env, cwd: sandbox, stdio: ["ignore", "ignore", "inherit", "pipe"],
    });
    serverClosed = once(server, "close");
    const ack = [];
    for await (const part of server.stdio[3]) ack.push(part);
    assert.equal(Buffer.concat(ack).toString(), "OK\n");
    const pair = exec(binary, ["-L", spec, "pair", address], { ...commandOptions, env });
    pair.child.stdin.on("error", () => {});
    pair.child.stdin.end(`${code}\n`);
    if (match) assert.equal((await pair).stdout, `Enter pairing code: Successfully paired to ${address} [guid=${guid}]\n`);
    else await assert.rejects(pair, (error) => error.code === 1);
    assert.deepEqual(await peerClosed, [match ? 0 : 1, null]);
  } finally {
    lines.close();
    peer.kill("SIGKILL");
    server?.kill("SIGKILL");
    await Promise.allSettled([peerClosed, serverClosed]);
    await rm(path, { force: true });
  }
}

async function checkPeer(mode, keyPath, cert) {
  const sockets = new Set();
  let dialed = 0;
  let inspect;
  const observed = Promise.withResolvers();
  // Register before listen so every possible dial, including an unexpected
  // retry or probe, is counted.
  const peer = createServer((socket) => {
    dialed++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(6_000, () => socket.destroy());
    if (!inspect) return socket.destroy();
    void inspect(socket).then(observed.resolve, observed.reject);
  });
  observed.promise.catch(() => {});
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const address = `127.0.0.1:${peer.address().port}`;
  const env = { HOME: home, TMPDIR: sandbox, LC_ALL: "C", CODY_ADB_PARENT_PID: String(process.pid), CODY_ADB_CONNECT_ADDRESS: address };
  const adb = async (...args) => (await exec(binary, ["-L", spec, ...args], { ...commandOptions, env })).stdout;
  const server = spawn(binary, ["-L", spec, "server", "nodaemon", "--reply-fd", "3"], {
    env, cwd: sandbox, stdio: ["ignore", "ignore", "inherit", "pipe"],
  });
  const exited = once(server, "close");
  try {
    const ack = [];
    for await (const part of server.stdio[3]) ack.push(part);
    assert.equal(Buffer.concat(ack).toString(), "OK\n");
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(privateKey)).mode & 0o777, 0o600);
    assert.equal(await adb("devices", "-l"), "List of devices attached\n\n");
    assert.equal(dialed, 0);
    assert.equal(await adb("connect", "127.0.0.1:12345"), "Connection address was not selected\n");
    const hostPublicKey = createPublicKey(await readFile(privateKey)).export({ type: "spki", format: "der" });
    const clientFingerprint = createHash("sha256").update(hostPublicKey).digest("hex").toUpperCase();
    const acceptableIssuer = await certificate(`issuer-${mode}`, `/O=AdbKey-0/CN=${mode === "wrong-key" ? "0".repeat(64) : clientFingerprint}`, keyPath);
    const tls = createTlsServer({
      key: await readFile(keyPath), cert, ca: [acceptableIssuer], requestCert: true, rejectUnauthorized: false,
      minVersion: mode === "tls12" ? "TLSv1.2" : "TLSv1.3",
      maxVersion: mode === "tls12" ? "TLSv1.2" : "TLSv1.3",
    });
    inspect = async (raw) => {
      assert.equal((await message(raw)).command, "CNXN");
      if (mode === "legacy") {
        raw.write(packet("CNXN", adbVersion, 1024 * 1024, banner));
        // The actual native binary must close, without acknowledging legacy.
        let plaintextBytes = 0;
        raw.on("data", (chunk) => { plaintextBytes += chunk.length; });
        await once(raw, "end");
        assert.equal(plaintextBytes, 0);
        assert.equal(raw.readableLength, 0);
        return;
      }
      raw.write(packet("STLS", stlsVersion, 0));
      assert.equal((await message(raw)).command, "STLS");
      if (mode !== "tls13") {
        const rejected = once(tls, "tlsClientError");
        tls.once("secureConnection", (socket) => {
          // A client that accepts the wrong issuer must not pass this test.
          socket.write(packet("CNXN", adbVersion, 1024 * 1024, banner));
        });
        tls.emit("connection", raw);
        await rejected;
        return;
      }
      const secure = Promise.withResolvers();
      tls.once("secureConnection", secure.resolve);
      tls.once("tlsClientError", secure.reject);
      tls.emit("connection", raw);
      const socket = await secure.promise;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      assert.equal(socket.getProtocol(), "TLSv1.3");
      assert.deepEqual(socket.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" }), hostPublicKey);
      socket.write(packet("CNXN", adbVersion, 1024 * 1024, banner));
      const { command, id, data } = await message(socket);
      assert.equal(command, "OPEN");
      assert.equal(data.toString().replace(/\0$/, ""), `shell,v2,raw:${property}`);
      socket.write(packet("OKAY", 1, id));
      socket.write(packet("WRTE", 1, id, Buffer.concat([frame(1, Buffer.from(`${guid}\n`)), frame(3, Buffer.from([0]))])));
      // `adb shell` can send its stdin-close frame while we're flushing output.
      for (;;) {
        const incoming = await message(socket);
        if (incoming.command === "OKAY") break;
        assert.equal(incoming.command, "WRTE");
        socket.write(packet("OKAY", 1, id));
      }
      socket.write(packet("CLSE", 1, id));
    };
    const connected = await adb("connect", address);
    if (mode === "tls13") {
      assert.equal(connected, `connected to ${address}\n`);
      assert.match((await adb("devices", "-l")).trimEnd(), / device +.*transport_id:\d+$/);
      assert.equal(await adb("-s", address, "shell", "-n", "-T", property), `${guid}\n`);
    } else {
      assert.doesNotMatch(connected, /(?:already )?connected to/);
      assert.equal(await adb("devices", "-l"), "List of devices attached\n\n");
    }
    await observed.promise;
    for (const socket of sockets) socket.destroy();
    // The native server cannot replay a broken link behind the GUID check.
    await delay(600);
    assert.equal(dialed, 1);
    assert.equal(await adb("devices", "-l"), "List of devices attached\n\n");
  } finally {
    for (const socket of sockets) socket.destroy();
    peer.close();
    server.kill("SIGKILL");
    await exited;
    await rm(path, { force: true });
  }
}

try {
  assert.equal((await exec(binary, ["cody-wireless-abi"], commandOptions)).stdout, "cody-adb-wireless-v1\n");
  await mkdir(join(home, ".android"), { recursive: true, mode: 0o700 });
  const key = join(sandbox, "fixture.key");
  await exec("openssl", ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", key], commandOptions);
  const cert = await certificate("server", "/CN=Cody fixture only", key);
  await checkPairing("999999", false, key);
  await checkPairing("012345", true, key);
  for (const mode of ["legacy", "tls12", "wrong-key", "tls13"]) await checkPeer(mode, key, cert);
  console.log("Private native adb: correct/wrong six-digit pairing, strict TLS 1.3 read-only shell, and no replay verified.");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
