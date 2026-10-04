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
 * An adbd at the USB packet boundary whose shell is REAL: every shell command
 * Cody sends (mkdir, cat, mv, wc, sha256sum, rm, test ...) runs in /bin/sh with
 * /data/local/tmp mapped onto a private temporary directory, so staging, hash
 * checks and cleanup behave exactly as on a device. Only what a host cannot
 * provide is faked: the sync protocol (writes land in that directory), `pm
 * install`, `getprop`, and the replies of adbd's restart services.
 */
export function sandboxDevice({ props = {}, pm = { output: "Success", status: 0 }, answers = {}, features = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cody-adb-device-"));
  const real = (text) => text.replaceAll("/data/local/tmp", root);
  const pmCalls = [];
  const writes = [];
  let pending = Buffer.alloc(0);
  let current;
  const transport = fakeAdb({
    features,
    output(service) {
      if (service === "sync:") return undefined;
      if (service in answers) return answers[service];
      if (!service.startsWith("exec:")) return undefined;
      const command = service.slice(5);
      if (command.includes("pm install")) {
        const staged = /'(\/data\/local\/tmp\/[^']+\.apk)'/.exec(command)?.[1];
        pmCalls.push({ command, apk: staged ? readFileSync(real(staged)) : undefined });
        return `${pm.output}\n__CODY_ADB_STATUS__${pm.status}\n`;
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
