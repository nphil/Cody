import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { link, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const scratch = mkdtempSync(join(process.env.CODY_DATA_SCRATCH || tmpdir(), "artifact-import-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.CODY_ACCOUNTS_DIR = join(scratch, "accounts");
process.env.CODY_INTERNAL_DISPLAY_SECRET = randomBytes(32).toString("base64url");
delete process.env.CODY_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.OMP_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEVICE_ARTIFACT_INPUT_TOOLS: tools } = await jiti.import("./artifact-input-tools.ts");
const { DeviceBridge } = await jiti.import("./bus.ts");
const { DeviceArtifactStore } = await jiti.import("./artifacts.ts");
const { runArtifactInput } = await jiti.import("./artifact-agent.ts");
const { withWorkspaceImage } = await jiti.import("./artifact-input-source.ts");
const { GET } = await jiti.import("../../app/api/devices/artifacts/import/route.ts");
const { createUser } = await jiti.import("../auth/users.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");
const { setSessionOwner } = await jiti.import("../auth/session-owners.ts");
const { validWorkspaceImport } = await jiti.import("./protocol.ts");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (op, args, ctx) => tools.find(tool => tool.name === `device_artifacts_${op}`).handler(args, ctx);
const linux = { skip: process.platform !== "linux" };

// The source, HTTP stream, digest checks, bridge and store are real. Only the browser storage engines stand in for OPFS/IDB.
function browser(t, fetch) {
  const writes = [];
  const spools = new Set();
  const files = new Map();
  const dir = {
    async getFileHandle(name) {
      spools.add(name);
      const parts = [];
      return {
        async createWritable() { return { async write(bytes) { writes.push(bytes.byteLength); parts.push(bytes); }, async close() {}, async abort() {} }; },
        async getFile() { return new Blob(parts); },
      };
    },
    async removeEntry(name) { assert.equal(spools.delete(name), true); },
  };
  const old = Object.getOwnPropertyDescriptor(navigator, "storage");
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => dir } });
  t.after(() => { if (old) Object.defineProperty(navigator, "storage", old); else delete navigator.storage; });
  const store = new DeviceArtifactStore({ fetch });
  store.persistence = {
    async put(session, row) { files.set(`${session}:${row.id}`, row); },
    async get(session, id) { return files.get(`${session}:${id}`); },
    async list(session) { return [...files].filter(([key]) => key.startsWith(session + ":")).map(([, v]) => v); },
  };
  // Hydrate also refreshes optional server-copy badges, unrelated to the local listing.
  store.refreshServerCopies = async () => {};
  return { store, writes, spools, files };
}

test("import and list: paged metadata for only this chat, no device command, same bytes independently hashed and committed", linux, async t => {
  const cwd = join(scratch, "project");
  await mkdir(join(cwd, "images"), { recursive: true });
  const bytes = randomBytes(576 * 1024 + 31);
  const relative = "images/recovery image.img";
  await writeFile(join(cwd, relative), bytes);
  const sessionId = "one";
  const { store, writes, files, spools } = browser(t, async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "same-origin");
    const req = new Request(new URL(url, "http://localhost"), { signal: init.signal });
    assert.equal(new URL(req.url).pathname, "/api/devices/artifacts/import");
    const response = await GET(req);
    response.blob = response.arrayBuffer = () => assert.fail("download must not buffer the file");
    return response;
  });
  const bridge = new DeviceBridge();
  const commands = [];
  bridge.attach(frame => {
    commands.push(frame.type);
    assert.ok(["artifacts.import", "artifacts.list"].includes(frame.type));
    runArtifactInput(store, sessionId, JSON.parse(JSON.stringify(frame)), new AbortController().signal).then(
      value => bridge.settle({ type: "result", id: frame.id, status: "ok", value }),
      error => bridge.settle({ type: "result", id: frame.id, status: "error", error: error.message }),
    );
  });
  const ctx = { bridge, cwd, sessionId };
  const file = JSON.parse(await run("import", { path: relative, sha256: digest(bytes).toUpperCase() }, ctx));
  assert.deepEqual(file, { fileId: file.fileId, name: "recovery image.img", size: bytes.length, sha256: digest(bytes), kind: "input", source: "server-file" });
  assert.ok(file.fileId && files.has(`one:${file.fileId}`));
  assert.ok(writes.length > 1 && writes.every(size => size < bytes.length));
  assert.equal(spools.size, 0);
  for (let i = 0; i < 100; i++) await store.save("one", `dump-${i}`, new Blob(["dump"]));
  await store.save("two", "another chat", new Blob(["other"]));
  const first = JSON.parse(await run("list", {}, ctx));
  const last = JSON.parse(await run("list", { offset: first.nextOffset }, ctx));
  assert.equal(first.total, 101);
  assert.equal(first.nextOffset, 100);
  assert.equal(last.nextOffset, null);
  const listed = [...first.artifacts, ...last.artifacts];
  assert.deepEqual(listed.find(f => f.fileId === file.fileId), file);
  assert.ok(listed.every(f => f.name !== "another chat"));
  assert.deepEqual(commands, ["artifacts.import", "artifacts.list", "artifacts.list"]);
});

test("no bytes when the expected digest, path, session or browser is wrong; no link, other root, hidden file or directory", linux, async () => {
  const cwd = join(scratch, "scoped");
  await mkdir(cwd);
  await writeFile(join(scratch, "private"), "secret");
  await writeFile(join(cwd, "regular"), "image");
  await writeFile(join(cwd, ".env"), "private");
  await mkdir(join(cwd, "folder"));
  await symlink(join(scratch, "private"), join(cwd, "linked"));
  await symlink(scratch, join(cwd, "parent"));
  await link(join(scratch, "private"), join(cwd, "hard"));
  const bridge = new DeviceBridge();
  const ctx = { sessionId: "s", cwd, bridge };
  assert.match(await run("import", { path: "regular" }, ctx), /No browser/);
  bridge.attach(() => assert.fail("must never ask the browser"));
  for (const path of ["../private", join(scratch, "private"), "https://host/img", "linked", "hard", "parent/private", "folder", ".env", "C:\\private"]) {
    assert.doesNotMatch(await run("import", { path }, ctx), /fileId|must never ask/);
  }
  assert.match(await run("import", { path: "regular", sha256: "0".repeat(64) }, ctx), /does not match/);
  assert.match(await run("import", { path: "regular", sha256: "short" }, ctx), /64-character/);
  assert.match(await run("import", { path: "regular", cwd, sessionId: "fake" }, { bridge }), /no authorized session/);
  assert.match(await run("list", { offset: -1 }, ctx), /nonnegative/);
  assert.match(await run("list", { sessionId: "fake" }, { bridge }), /authorized session/);
});

test("changed or truncated input never becomes an artifact; partial spools are cleaned", async t => {
  const image = { token: randomUUID(), name: "test.img", size: 4, sha256: digest("good") };
  let incoming;
  const { store, spools, files } = browser(t, async () => new Response(incoming));
  for (const [body, error] of [["evil", /SHA-256/], ["few", /byte count/], ["excess", /exceeded/]]) {
    incoming = body;
    await assert.rejects(store.importAuthorizedFile("s", image), error);
    assert.equal(files.size, 0);
    assert.equal(spools.size, 0);
  }
  for (const value of ["/private", { ...image, token: "https://elsewhere/" }, { ...image, name: "../test" }, { ...image, size: -1 }]) assert.equal(validWorkspaceImport(value), false);
});

test("download is bound to an authorized browser and session, consumes its ticket once, and cannot be redirected by renaming the source", linux, async () => {
  const alice = createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  const bob = createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });
  setSessionOwner("owned", alice.id);
  const cwd = join(scratch, "pinned");
  await mkdir(cwd);
  await writeFile(join(cwd, "input"), "original");
  const get = (image, user, sid = "owned") => GET(new Request(`http://localhost/api/devices/artifacts/import?sessionId=${sid}&token=${image.token}`, {
    headers: user ? { Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` } : {},
  }));
  const used = await withWorkspaceImage("owned", cwd, "input", undefined, async image => {
    assert.equal((await get(image)).status, 401);
    assert.equal((await get(image, bob)).status, 404);
    assert.equal((await get(image, alice, "other")).status, 404);
    await rename(join(cwd, "input"), join(cwd, "original"));
    await symlink(join(scratch, "private"), join(cwd, "input"));
    const res = await get(image, alice);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "original");
    assert.equal((await get(image, alice)).status, 404);
    return image;
  });
  assert.equal((await get(used, alice)).status, 404);
  const unused = await withWorkspaceImage("owned", cwd, "original", undefined, async image => image);
  assert.equal((await get(unused, alice)).status, 404, "an abandoned browser request leaves no readable ticket");
});

test("a forged acknowledgement cannot replace the requested digest; a lost browser cannot answer on its replacement's behalf", async () => {
  const bridge = new DeviceBridge();
  const image = { token: randomUUID(), name: "recovery.img", size: 4, sha256: digest("good") };
  const file = { id: randomUUID(), name: image.name, sha256: digest("evil"), size: 4, kind: "input", source: "server-file", createdAt: 1 };
  bridge.attach(frame => bridge.settle({ type: "result", id: frame.id, status: "ok", value: [file] }));
  await assert.rejects(bridge.requestArtifactImport(image), /did not confirm/);
  let abandoned;
  const detach = bridge.attach(frame => { abandoned = frame; });
  const pending = bridge.requestArtifactImport(image);
  detach();
  await assert.rejects(pending, /disconnected/);
  bridge.settle({ type: "result", id: abandoned.id, status: "ok", value: [{ ...file, sha256: image.sha256 }] });
  bridge.attach(frame => {
    assert.equal(frame.type, "artifacts.list", "never replay an abandoned import");
    bridge.settle({ type: "result", id: frame.id, status: "ok", value: { total: 0, artifacts: [] } });
  });
  assert.deepEqual(await bridge.requestArtifactList(0), { artifacts: [], total: 0 });
});
