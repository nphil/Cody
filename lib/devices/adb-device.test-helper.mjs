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
 * install` (a fixed reply, or a `packageManager()`), `getprop`, and the replies
 * of adbd's restart services. `syncFault` breaks the first staged write: "corrupt"
 * flips a byte on its way to storage, "no-space" stores half of it and fails.
 */
export function sandboxDevice({ props = {}, pm = { output: "Success", status: 0 }, answers = {}, features = "", state, syncFault } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cody-adb-device-"));
  const real = (text) => text.replaceAll("/data/local/tmp", root);
  const pmCalls = [];
  const writes = [];
  let pending = Buffer.alloc(0);
  let current;
  let fault = syncFault;
  const transport = fakeAdb({
    features,
    state,
    output(service) {
      if (service === "sync:") return undefined;
      if (service in answers) return answers[service];
      if (!service.startsWith("exec:")) return undefined;
      const command = service.slice(5);
      if (command.includes("pm install")) {
        const staged = /'(\/data\/local\/tmp\/[^']+\.apk)'/.exec(command)?.[1];
        const flags = (/pm install((?: -\w)*)/.exec(command)?.[1] ?? "").split(/\s+/).filter(Boolean);
        pmCalls.push({ command, flags, apk: staged ? readFileSync(real(staged)) : undefined });
        const reply = typeof pm === "function" ? pm({ command, flags }) : pm;
        return `${reply.output}\n__CODY_ADB_STATUS__${reply.status}\n`;
      }
      const property = /^getprop\s+'?([\w.-]+)'?/.exec(command)?.[1];
      if (property) return `${props[property] ?? ""}\n`;
      const ran = spawnSync("/bin/sh", ["-c", real(command)], { encoding: "utf8" });
      return ran.stdout + ran.stderr;
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

/** A transport whose daemon never answers: authentication fails at once, like a device that is still booting. */
export function bootingTransport() {
  return {
    kind: "usb",
    async read() { throw new Error("device not ready"); },
    async write() {},
    close() {},
  };
}
