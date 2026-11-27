// Installed with the test process's Node shebang. Simulates the private host
// socket, not Android or encryption; it never opens TCP or touches a device.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const { HOME: home, CODY_ADB_PAIR_ADDRESS: pair, CODY_ADB_CONNECT_ADDRESS: connect, CODY_ADB_PARENT_PID: parent, CODY_ADB_CLIENT_LABEL: label } = process.env;
const guid = "adb-fixture-ABCDEF";
assert.equal(parent, String(process.ppid));
assert.equal(process.env.ADB_SERVER_SOCKET, undefined);
assert.equal(process.env.ADB_TRACE, undefined);
assert.equal(process.env.ADB_VENDOR_KEYS, undefined);

if (args.join(" ") === "cody-wireless-abi") {
  console.log("cody-adb-wireless-v1");
} else {
  const [flag, spec, command, ...rest] = args;
  assert.equal(flag, "-L");
  assert(spec.startsWith("localfilesystem:"));
  const path = spec.slice("localfilesystem:".length);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.match(label, /^Cody@[a-f0-9]{8}$/);
  assert.notEqual(Boolean(pair), Boolean(connect));
  assert.equal(process.env.ADB_USB, "0");
  assert.equal(process.env.ADB_MDNS, "0");
  assert.equal(process.env.ADB_EMU, "0");
  if (command === "pair") {
    assert.deepEqual(rest, [pair]);
    const input = readFileSync(0, "utf8");
    assert.match(input, /^[0-9]{6}\n$/);
    assert(!Object.values(process.env).includes(input.trim()));
    if (input === "012345\n") {
      writeFileSync(join(home, ".android", "adb_known_hosts.pb"), "unused mDNS cache", { mode: 0o600 });
      console.log(`Enter pairing code: Successfully paired to ${pair} [guid=${guid}]`);
    } else process.exitCode = 1;
  } else {
    assert.equal(command, "server");
    assert.deepEqual(rest, ["nodaemon", "--reply-fd", "3"]);
    process.umask(0o077);
    const key = join(home, ".android", "adbkey");
    if (!existsSync(key)) writeFileSync(key, randomBytes(32), { mode: 0o600, flag: "wx" });
    serve(path);
  }
}

function protocol(text) {
  return Buffer.byteLength(text).toString(16).padStart(4, "0") + text;
}

function frame(kind, data) {
  const payload = Buffer.from(data);
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function serve(path) {
  let verified = false;
  const trackers = new Set();
  const listed = `${connect}   device product:fixture model:Cody device:tablet transport_id:7\n`;
  createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let selected = false;
    let echo = false;
    const input = [];
    socket.on("error", () => {});
    socket.on("close", () => trackers.delete(socket));
    socket.on("data", (part) => {
      buffer = Buffer.concat([buffer, part]);
      while (true) {
        if (echo) {
          if (buffer.length < 5) break;
          const size = buffer.readUInt32LE(1);
          if (buffer.length < 5 + size) break;
          if (buffer[0] === 4) {
            assert.equal(size, 0);
            socket.end(Buffer.concat([...input.map((payload) => frame(1, payload)), frame(2, "fixture stderr"), frame(3, [7])]));
            break;
          }
          assert.equal(buffer[0], 0);
          input.push(buffer.subarray(5, 5 + size));
          buffer = buffer.subarray(5 + size);
          continue;
        }
        if (buffer.length < 4) break;
        const size = Number.parseInt(buffer.toString("ascii", 0, 4), 16);
        assert(Number.isFinite(size));
        if (buffer.length < 4 + size) break;
        const req = buffer.toString("utf8", 4, size + 4);
        buffer = buffer.subarray(4 + size);
        assert(connect, "The pairing daemon must not handle host selection or shell");
        if (req === `host:connect:${connect}`) socket.end(`OKAY${protocol(`connected to ${connect}`)}`);
        else if (req === "host:devices-l") socket.end(`OKAY${protocol(listed)}`);
        else if (req === "host:track-devices-l") {
          trackers.add(socket);
          socket.write(`OKAY${protocol(listed)}`);
        } else if (req === "host:transport-id:7") {
          selected = true;
          socket.write("OKAY");
        } else {
          assert(selected && req.startsWith("shell,v2,raw:"));
          const cmd = req.slice("shell,v2,raw:".length);
          if (cmd === "/system/bin/getprop persist.adb.wifi.guid") {
            verified = !connect.endsWith(":43212");
            socket.removeAllListeners("data");
            socket.end(Buffer.concat([Buffer.from("OKAY"), frame(1, `${verified ? guid : "adb-other-tablet"}\n`), frame(3, [0])]));
            break;
          }
          assert(verified, "The requested shell command must wait for the identity probe");
          if (cmd === "echo-input") {
            echo = true;
            socket.write("OKAY");
            continue;
          }
          if (cmd === "lose-link") {
            socket.removeAllListeners("data");
            socket.end("OKAY");
            for (const tracking of trackers) tracking.write("0000");
            break;
          }
          if (cmd === "wait") {
            socket.removeAllListeners("data");
            socket.write(Buffer.concat([Buffer.from("OKAY"), frame(1, "waiting")]));
            break;
          }
          assert.equal(cmd, "read-only");
          // Split both the OKAY prefix and the following shell-v2 frame.
          socket.removeAllListeners("data");
          socket.write("OK");
          const result = Buffer.concat([Buffer.from("AY"), frame(1, "metadata"), frame(3, [0])]);
          setTimeout(() => socket.write(result.subarray(0, 4)), 5);
          setTimeout(() => socket.end(result.subarray(4)), 10);
          break;
        }
      }
    });
  }).listen(path, () => {
    writeSync(3, "OK\n");
    closeSync(3);
  });
}
