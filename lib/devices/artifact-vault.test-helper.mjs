import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * A disk that misbehaves on demand, for the places the vault writes: a slice appended to a partial copy (`.N.part`)
 * and the archive as it is built (`.archive.part`). Every other handle is the real one, and the data really reaches the
 * real disk; the stand-in only decides how much of each write is accepted, whether it fails, stops, waits or arrives
 * damaged. It has to be in place BEFORE the vault is loaded: the vault keeps the `open` it found. `setupFakeServer` and
 * the vault's own tests both call this first; calling it again returns the same disk.
 */
export function installFlakyDisk() {
  const scope = globalThis;
  if (scope.__codyFlakyDisk) return scope.__codyFlakyDisk;
  const fsPromises = createRequire(import.meta.url)("node:fs/promises");
  const realOpen = fsPromises.open;
  const fs = createRequire(import.meta.url)("node:fs");
  const realStatfs = fs.statfsSync;

  const disk = {
    /** Slice appends: bytes taken per write, and the number of writes after which the disk stops taking any. */
    appends: { limit: Infinity, stallAfter: Infinity, calls: 0 },
    /**
     * The archive being written, counted from the moment it is opened: bytes taken per write; the byte after which the
     * disk is full (a write fails with ENOSPC) or just stops taking data (a write that stores nothing); the byte whose
     * bit is flipped on its way to the disk; a hold (see holdArchive); how many archives were opened and bytes accepted.
     */
    archive: { limit: Infinity, fullAfter: Infinity, stallAfter: Infinity, corruptAt: undefined, hold: undefined, opened: 0, accepted: 0 },
    /** The finished archives the vault opened for reading, in order: how a test sees whether a manifest was read again. */
    reads: [],
    /** Makes the archive write wait once `afterBytes` of it are on the disk; `release()` lets it go on. */
    holdArchive(afterBytes = 0) {
      const gate = Promise.withResolvers();
      const reached = Promise.withResolvers();
      disk.archive.hold = { afterBytes, gate, reached };
      return {
        reached: reached.promise,
        release() {
          disk.archive.hold = undefined;
          gate.resolve();
        },
      };
    },
    /** What the disk reports as free, in bytes, instead of the real figure; undefined asks the real disk. */
    availableBytes: undefined,
    reset() {
      Object.assign(disk.appends, { limit: Infinity, stallAfter: Infinity, calls: 0 });
      Object.assign(disk.archive, { limit: Infinity, fullAfter: Infinity, stallAfter: Infinity, corruptAt: undefined, hold: undefined, opened: 0, accepted: 0 });
      disk.reads.length = 0;
      disk.availableBytes = undefined;
    },
  };

  const wrap = (handle, write) =>
    new Proxy(handle, {
      get(target, key) {
        if (key === "write") return (buffer, offset = 0, length = buffer.byteLength - offset, position = null) => write(target, buffer, offset, length, position);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  fs.statfsSync = (...args) => {
    const real = realStatfs(...args);
    if (disk.availableBytes === undefined) return real;
    const bsize = Number(real.bsize) || 4096;
    return { ...real, bsize, bavail: Math.floor(disk.availableBytes / bsize), blocks: Number(real.blocks) };
  };
  // A module that took `fs` as an ES module (this file does, for its own reads) holds the builtin's facade, which only learns of a patched function when told.
  syncBuiltinESMExports();

  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });

  fsPromises.open = async (...args) => {
    const handle = await realOpen(...args);
    const [file, flags] = args;
    if (flags === "a") {
      return wrap(handle, async (target, buffer, offset, length, position) => {
        disk.appends.calls += 1;
        if (disk.appends.calls > disk.appends.stallAfter) return { bytesWritten: 0, buffer };
        return target.write(buffer, offset, Math.min(length, disk.appends.limit), position);
      });
    }
    if (flags === "w" && typeof file === "string" && file.endsWith(".archive.part")) {
      disk.archive.opened += 1;
      disk.archive.accepted = 0;
      return wrap(handle, async (target, buffer, offset, length, position) => {
        const { archive } = disk;
        const hold = archive.hold;
        if (hold && archive.accepted >= hold.afterBytes) {
          hold.reached.resolve();
          await hold.gate.promise;
        }
        const room = Math.min(archive.fullAfter, archive.stallAfter) - archive.accepted;
        if (room <= 0) {
          if (archive.accepted >= archive.fullAfter) throw enospc();
          return { bytesWritten: 0, buffer };
        }
        const take = Math.min(length, archive.limit, room);
        let chunk = buffer.subarray(offset, offset + take);
        if (archive.corruptAt !== undefined && archive.corruptAt >= archive.accepted && archive.corruptAt < archive.accepted + take) {
          chunk = Buffer.from(chunk);
          chunk[archive.corruptAt - archive.accepted] ^= 0x01;
        }
        const { bytesWritten } = await target.write(chunk, 0, chunk.length, position);
        archive.accepted += bytesWritten;
        return { bytesWritten, buffer };
      });
    }
    if (flags === "r" && typeof file === "string" && file.endsWith(".zip")) disk.reads.push(file);
    return handle;
  };

  syncBuiltinESMExports();
  scope.__codyFlakyDisk = disk;
  return disk;
}

/** Which of the real tools that read archives this machine has: a test that needs one skips politely without it. */
export const archiveTools = {
  unzip: spawnSync("unzip", ["-v"], { stdio: "ignore" }).status !== null,
  python: spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== null,
  sha256sum: spawnSync("sha256sum", ["--version"], { stdio: "ignore" }).status !== null,
};

/** Asserts that every real archive tool on this machine accepts the file: `unzip -t` and `python3 -m zipfile -t`. */
export function assertArchiveOpens(assert, archive) {
  if (archiveTools.unzip) {
    const tested = spawnSync("unzip", ["-t", archive], { encoding: "utf8" });
    assert.equal(tested.status, 0, `unzip -t: ${tested.stdout}${tested.stderr}`);
    assert.match(tested.stdout, /No errors detected/);
  }
  if (archiveTools.python) {
    const tested = spawnSync("python3", ["-m", "zipfile", "-t", archive], { encoding: "utf8" });
    assert.equal(tested.status, 0, `python3 -m zipfile -t: ${tested.stdout}${tested.stderr}`);
  }
}

/** Every entry of an archive as Cody's own reader (lib/devices/zip-archive.ts) opens it: name -> { entry, bytes }. */
export async function readArchive(archive) {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { openZip } = await jiti.import("./zip-archive.ts");
  const zip = await openZip(new Blob([readFileSync(archive)]));
  const entries = new Map();
  for (const entry of zip.entries) entries.set(entry.name, { entry, bytes: Buffer.from(await (await zip.open(entry)).arrayBuffer()) });
  return entries;
}

/**
 * A `fetch` that talks to the real artifact-vault handlers in this process, so the page's uploader, the store and the
 * server's routes are exercised together, with faults the network can really produce: a dropped connection, a body
 * that arrives damaged, an answer that is lost after the server acted on the request.
 *
 * Call `await setupFakeServer()` once per test file (it points the accounts directory at a scratch directory so every
 * chat is open to the caller) and `fakeServer(options)` for each scenario. The result carries the flaky `disk`.
 */
export async function setupFakeServer() {
  const scratch = mkdtempSync(join(tmpdir(), "cody-fake-server-"));
  process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
  process.env.CODY_ACCOUNTS_DIR = join(scratch, "accounts");
  delete process.env.CODY_PASSWORD;
  delete process.env.CODY_REQUIRE_ACCOUNTS;
  delete process.env.OMP_WEB_PASSWORD;
  const disk = installFlakyDisk();
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const http = await jiti.import("./artifact-vault-http.ts");
  const vault = await jiti.import("./artifact-vault.ts");
  let counter = 0;
  return {
    scratch,
    http,
    vault,
    disk,
    fakeServer(limits = {}) {
      counter += 1;
      const config = { root: join(scratch, `vault-${counter}`), limits: { ...vault.DEFAULT_VAULT_LIMITS, minFreeBytes: 0, ...limits } };
      const log = [];
      const faults = { network: 0, lostAnswers: 0, corrupt: 0, status: [] };
      const route = async (request, method, path) => {
        const saveId = /^\/api\/devices\/artifacts\/saves\/([^/]+)$/.exec(path)?.[1];
        if (path === "/api/devices/artifacts/saves") return method === "POST" ? http.handleBegin(request, config) : http.handleList(request, config);
        if (saveId === undefined) return new Response("not found", { status: 404 });
        if (method === "GET") return http.handleStatus(request, saveId, config);
        if (method === "PUT") return http.handleSlice(request, saveId, config);
        if (method === "DELETE") return http.handleDelete(request, saveId, config);
        return http.handleAction(request, saveId, config);
      };
      const fetch = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url, "http://cody.test");
        const method = init.method ?? "GET";
        if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
        log.push({ method, path: url.pathname, search: url.search, ...(typeof init.body === "string" ? { body: init.body } : {}) });
        if (faults.network > 0) {
          faults.network -= 1;
          throw new TypeError("fetch failed");
        }
        const forced = faults.status.shift();
        if (forced) return Response.json({ error: forced.error ?? "refused", ...(forced.code ? { code: forced.code } : {}) }, { status: forced.status });
        const headers = new Headers(init.headers);
        let body = init.body;
        if (body instanceof Blob) {
          let bytes = Buffer.from(await body.arrayBuffer());
          if (method === "PUT" && faults.corrupt > 0) {
            faults.corrupt -= 1;
            bytes = Buffer.from(bytes);
            bytes[0] ^= 0xff;
          }
          headers.set("content-length", String(bytes.length));
          body = bytes;
        }
        const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
        const response = await route(request, method, url.pathname);
        if (faults.lostAnswers > 0 && method !== "GET") {
          faults.lostAnswers -= 1;
          throw new TypeError("fetch failed: the answer never arrived");
        }
        return response;
      };
      return { fetch, config, log, faults };
    },
  };
}
