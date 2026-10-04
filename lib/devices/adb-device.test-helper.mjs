import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeAdb } from "./adb.test-helper.mjs";

function syncPacket(id, bytes = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.write(id);
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

/**
 * The package manager behind `pm install`, with Android's real option rules. From
 * Android 9 (API 28) replacing an installed app is the default, `-r` is ignored
 * and `-R` turns replacement off; before that replacement needs `-r`, an absent
 * flag already refuses it, and `-R` is an unknown option.
 */
export function packageManager({ sdk = 34, installed = false } = {}) {
  const state = { installed, installs: 0, replaced: false, calls: [] };
  const known = sdk >= 28 ? ["-r", "-R", "-d", "-g", "-t"] : ["-r", "-d", "-g", "-t"];
  const handler = ({ flags }) => {
    state.calls.push(flags);
    const unknown = flags.find((flag) => !known.includes(flag));
    if (unknown) return { output: `Error: java.lang.IllegalArgumentException: Unknown option ${unknown}`, status: 1 };
    const replacing = sdk >= 28 ? !flags.includes("-R") : flags.includes("-r");
    if (state.installed && !replacing) return { output: "Failure [INSTALL_FAILED_ALREADY_EXISTS: Attempt to re-install com.example.cronos without first uninstalling.]", status: 1 };
    state.replaced = state.installed;
    state.installed = true;
    state.installs += 1;
    return { output: "Success", status: 0 };
  };
  return Object.assign(handler, { state });
}

/**
 * An adbd at the USB packet boundary whose shell is REAL: every shell command
 * Cody sends (mkdir, cat, mv, wc, sha256sum, rm, test ...) runs in /bin/sh with
 * /data/local/tmp mapped onto a private temporary directory, so staging, hash
 * checks and cleanup behave exactly as on a device. Only what a host cannot
 * provide is faked: the sync protocol (writes land in that directory), `pm
 * install` (a fixed reply, a `packageManager()`, or a function returning
 * undefined for a package manager that never answers), `getprop`, and the replies
 * of adbd's restart services. `syncFault` breaks the first staged write: "corrupt"
 * flips a byte on its way to storage, "no-space" stores half of it and fails,
 * "disconnect" stores nothing and fails with a message that says the USB
 * transport was lost (what a copy that has to be resumed looks like).
 * `root` makes a second connection to the same device (after a reconnect) see the
 * first one's storage, `onService` sees every service the host opens, and with
 * `features: "shell_v2"` shell commands arrive over the shell protocol.
 */
export function sandboxDevice({ props = {}, pm = { output: "Success", status: 0 }, answers = {}, features = "", state, syncFault, root: sharedRoot, onService, silentOpen } = {}) {
  const root = sharedRoot ?? mkdtempSync(join(tmpdir(), "cody-adb-device-"));
  const real = (text) => text.replaceAll("/data/local/tmp", root);
  const pmCalls = [];
  const writes = [];
  let pending = Buffer.alloc(0);
  let current;
  let fault = syncFault;
  const frame = (id, data) => {
    const header = Buffer.alloc(5);
    header[0] = id;
    header.writeUInt32LE(data.length, 1);
    return Buffer.concat([header, data]);
  };
  const transport = fakeAdb({
    features,
    state,
    silentOpen,
    output(service) {
      onService?.(service);
      if (service === "sync:") return undefined;
      if (service in answers) return answers[service];
      const v2 = service.startsWith("shell,v2,raw:");
      if (!v2 && !service.startsWith("exec:")) return undefined;
      const command = service.slice(v2 ? "shell,v2,raw:".length : 5);
      // What a command printed and how it ended; the shell protocol carries the streams and the exit code in packets of their own.
      const reply = (stdout, stderr, status) => (v2 ? Buffer.concat([frame(1, Buffer.from(stdout)), frame(2, Buffer.from(stderr)), frame(3, Buffer.from([status]))]) : stdout + stderr);
      if (command.includes("pm install")) {
        const staged = /'(\/data\/local\/tmp\/[^']+\.apk)'/.exec(command)?.[1];
        const flags = (/pm install((?: -\w)*)/.exec(command)?.[1] ?? "").split(/\s+/).filter(Boolean);
        pmCalls.push({ command, flags, apk: staged ? readFileSync(real(staged)) : undefined });
        const answer = typeof pm === "function" ? pm({ command, flags }) : pm;
        if (answer === undefined) return undefined;
        return reply(`${answer.output}\n__CODY_ADB_STATUS__${answer.status}\n`, "", answer.status);
      }
      const property = /^getprop\s+'?([\w.-]+)'?/.exec(command)?.[1];
      if (property) return reply(`${props[property] ?? ""}\n`, "", 0);
      const ran = spawnSync("/bin/sh", ["-c", real(command)], { encoding: "utf8" });
      return reply(ran.stdout, ran.stderr, ran.status ?? 1);
    },
    onInput(service, data, send) {
      if (service !== "sync:") return;
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 8) {
        const id = pending.toString("ascii", 0, 4);
        const length = id === "DONE" ? 0 : pending.readUInt32LE(4);
        if (pending.length < 8 + length) return;
        const payload = pending.subarray(8, 8 + length);
        pending = pending.subarray(8 + length);
        if (id === "SEND") current = { path: payload.toString().split(",")[0], chunks: [] };
        else if (id === "DATA") current.chunks.push(Buffer.from(payload));
        else if (id === "DONE") {
          const bytes = Buffer.concat(current.chunks);
          mkdirSync(dirname(real(current.path)), { recursive: true });
          if (fault === "corrupt") bytes[0] ^= 1;
          if (fault === "no-space") {
            writeFileSync(real(current.path), bytes.subarray(0, Math.floor(bytes.length / 2)));
            current = undefined;
            fault = undefined;
            send(syncPacket("FAIL", Buffer.from("No space left on device")));
            continue;
          }
          if (fault === "disconnect") {
            current = undefined;
            fault = undefined;
            send(syncPacket("FAIL", Buffer.from("USB transport disconnected")));
            continue;
          }
          fault = undefined;
          writeFileSync(real(current.path), bytes);
          writes.push({ path: current.path, bytes });
          current = undefined;
          send(syncPacket("OKAY"));
        }
      }
    },
  });
  return { transport, root, real, pmCalls, writes, services: transport.services };
}


/**
 * A transport whose daemon never answers anything, not even the CONNECT: a device that is
 * waiting for its user to approve an RSA key, or has stopped responding. A read ends only when
 * its signal does; `writes` counts what the host has sent.
 */
export function mutedTransport() {
  const transport = {
    kind: "usb",
    writes: 0,
    read(_length, _timeoutMs, signal) {
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    async write() { transport.writes += 1; },
    close() {},
  };
  return transport;
}

/** A transport whose daemon never answers: authentication fails at once, like a device that is still booting. */
export function bootingTransport() {
  return {
    kind: "usb",
    async read() { throw new Error("device not ready"); },
    async write() {},
    close() {},
  };
}
