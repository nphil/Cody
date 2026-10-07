import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { assertArchiveOpens, installFlakyDisk, readArchive } from "./artifact-vault.test-helper.mjs";

/**
 * "Save to server" as the page sees it: the routes, their auth and their owner checks, and what each answer looks like
 * while the archive is being built. The vault's own behaviour has its own file; this one is about who may do what and what
 * a request gets back.
 */
const scratch = mkdtempSync(join(tmpdir(), "cody-vault-http-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.CODY_ACCOUNTS_DIR = join(scratch, "accounts");
process.env.CODY_DEVICE_ARTIFACTS_DIR = join(scratch, "vault");
process.env.CODY_INTERNAL_DISPLAY_SECRET = Buffer.from("vault-http-test-secret").toString("base64url");
delete process.env.CODY_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.OMP_WEB_PASSWORD;

const disk = installFlakyDisk();
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const http = await jiti.import("./artifact-vault-http.ts");
const { DEFAULT_VAULT_LIMITS } = await jiti.import("./artifact-vault.ts");
const collection = await jiti.import("../../app/api/devices/artifacts/saves/route.ts");
const single = await jiti.import("../../app/api/devices/artifacts/saves/[saveId]/route.ts");
const users = await jiti.import("../auth/users.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");
const { setSessionOwner } = await jiti.import("../auth/session-owners.ts");

const MiB = 1024 * 1024;
const config = { root: join(scratch, "vault"), limits: { ...DEFAULT_VAULT_LIMITS, maxChunkBytes: 4096, minFreeBytes: 0 } };
/** The same vault, with larger slices and a `complete` that answers `building` after a few milliseconds. */
const quickConfig = { root: config.root, limits: { ...config.limits, maxChunkBytes: 1 * MiB, completeWaitMs: 20 } };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const as = (user) => (user ? { Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` } : {});
const answer = async (response) => ({ status: response.status, response, body: await response.clone().json() });

const url = (path = "", query = "") => `http://cody.test/api/devices/artifacts/saves${path}${query}`;

/** The routes' handlers, bound to one vault configuration. */
function api(vault) {
  return {
    begin: async (body, user) => answer(await http.handleBegin(new Request(url(), { method: "POST", headers: { "Content-Type": "application/json", ...as(user) }, body: JSON.stringify(body) }), vault)),
    slice: async (saveId, file, offset, bytes, user, headers = {}) =>
      answer(await http.handleSlice(new Request(url(`/${saveId}`, `?file=${file}&offset=${offset}`), { method: "PUT", headers: { "Content-Length": String(bytes.length), ...as(user), ...headers }, body: bytes }), saveId, vault)),
    act: async (saveId, body, user) => answer(await http.handleAction(new Request(url(`/${saveId}`), { method: "POST", headers: { "Content-Type": "application/json", ...as(user) }, body: JSON.stringify(body) }), saveId, vault)),
    status: async (saveId, user) => answer(await http.handleStatus(new Request(url(`/${saveId}`), { headers: as(user) }), saveId, vault)),
    list: async (query, user) => answer(await http.handleList(new Request(url("", query), { headers: as(user) }), vault)),
    remove: async (saveId, user) => answer(await http.handleDelete(new Request(url(`/${saveId}`), { method: "DELETE", headers: as(user) }), saveId, vault)),
  };
}
const { begin, slice, act, status, list, remove } = api(config);
const quick = api(quickConfig);

const describe = (name, bytes) => ({ name, size: bytes.length, sha256: sha256(bytes), kind: "output", source: "device", createdAt: Date.now() });
const payload = (sessionId = "chat-a", extra = {}) => {
  const bytes = randomBytes(6000);
  return { bytes, body: { sessionId, label: "Backup", timeZone: "UTC", files: [describe("part.bin", bytes)], ...extra } };
};

async function saveAll(sessionId, user, extra) {
  const { bytes, body } = payload(sessionId, extra);
  const begun = await begin(body, user);
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const { saveId } = begun.body;
  assert.equal((await slice(saveId, 0, 0, bytes.subarray(0, 4096), user)).status, 200);
  assert.equal((await slice(saveId, 0, 4096, bytes.subarray(4096), user)).status, 200);
  assert.equal((await act(saveId, { action: "verify", file: 0 }, user)).status, 200);
  const done = await act(saveId, { action: "complete" }, user);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { saveId, done: done.body, bytes };
}

/** A save of several megabytes, uploaded and verified, whose `complete` has not been asked for yet. */
async function uploaded(sessionId, user) {
  const system = randomBytes(3 * MiB);
  const vendor = randomBytes(1 * MiB);
  const begun = await quick.begin({ sessionId, label: "Big backup", timeZone: "UTC", files: [describe("system.bin", system), describe("vendor.bin", vendor)] }, user);
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const { saveId } = begun.body;
  for (const [index, bytes] of [system, vendor].entries()) {
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024) assert.equal((await quick.slice(saveId, index, offset, bytes.subarray(offset, offset + 512 * 1024), user)).status, 200);
    assert.equal((await quick.act(saveId, { action: "verify", file: index }, user)).status, 200);
  }
  return { saveId, files: [system, vendor] };
}

test("on an open instance a save goes through begin, slices, verify and complete, uncached, and becomes one archive", async () => {
  const { bytes, body } = payload();
  const begun = await begin(body);
  assert.equal(begun.status, 200);
  assert.equal(begun.response.headers.get("cache-control"), "no-store");
  assert.equal(begun.body.state, "uploading");
  assert.equal(begun.body.owner, null);
  assert.match(begun.body.archive, /Backup-\d{4}-\d{2}-\d{2}\.zip$/);
  const { saveId } = begun.body;

  const first = await slice(saveId, 0, 0, bytes.subarray(0, 4096));
  assert.deepEqual(first.body, { received: 4096 });
  assert.equal((await status(saveId)).body.files[0].received, 4096);
  assert.equal((await slice(saveId, 0, 4096, bytes.subarray(4096))).body.received, 6000);
  assert.deepEqual((await act(saveId, { action: "verify", file: 0 })).body, { ok: true, sha256: sha256(bytes) });
  const done = await act(saveId, { action: "complete" });
  assert.equal(done.response.headers.get("cache-control"), "no-store");
  assert.equal(done.body.state, "complete");
  assert.equal(done.body.verified, true);
  assert.equal(done.body.archive, begun.body.archive);
  assert.ok(done.body.archive.startsWith(config.root));
  assert.ok(done.body.archiveBytes > 0);
  assert.equal(done.body.folder, undefined, "a save is one archive, not a folder");
  const inside = await readArchive(done.body.archive);
  assert.ok(inside.get(done.body.files[0].entry).bytes.equals(bytes));
  assertArchiveOpens(assert, done.body.archive);
  assert.deepEqual((await status(saveId)).body, done.body, "the status afterwards is the same description");
});

test("a slice with no length, one that is too large, one cut short and one at the wrong place are each refused, and nothing is stored", async () => {
  const { bytes, body } = payload();
  const { saveId } = (await begin(body)).body;

  const noLength = await http.handleSlice(new Request(url(`/${saveId}`, "?file=0&offset=0"), { method: "PUT", body: bytes.subarray(0, 100) }), saveId, config);
  assert.equal(noLength.status, 411);
  const tooLarge = await slice(saveId, 0, 0, randomBytes(5000));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, "chunk_too_large");
  const cut = await slice(saveId, 0, 0, bytes.subarray(0, 50), undefined, { "Content-Length": "100" });
  assert.equal(cut.status, 400);
  assert.equal(cut.body.code, "truncated");
  assert.match(cut.body.error, /declared 100 bytes but 50 arrived, so nothing was stored/);
  assert.equal((await slice(saveId, 0, 0, bytes.subarray(0, 0))).body.code, "empty_chunk");
  const misplaced = await slice(saveId, 0, 10, bytes.subarray(0, 100));
  assert.equal(misplaced.status, 409);
  assert.equal(misplaced.body.received, 0);
  assert.equal((await slice(saveId, 0, "x", bytes.subarray(0, 100))).body.code, "invalid_request");
  assert.equal((await status(saveId)).body.files[0].received, 0, "none of the refused slices wrote a byte");
});

test("a request that is not valid says so in plain words, with a code, and a missing or unknown save is a 404", async () => {
  const notJson = await answer(await http.handleBegin(new Request(url(), { method: "POST", body: "{nope" }), config));
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.code, "invalid_request");
  const empty = await begin({ sessionId: "chat-a", files: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /no files/);
  assert.equal((await status("0".repeat(32))).status, 404);
  assert.equal((await status("../../etc")).status, 404);
  assert.equal((await act("0".repeat(32), { action: "complete" })).status, 404);
  const { saveId } = (await begin(payload().body)).body;
  assert.equal((await act(saveId, { action: "explode" })).status, 400);
  assert.equal((await act(saveId, { action: "verify" })).status, 400);
  assert.equal((await act(saveId, { action: "verify", file: 7 })).status, 404);
  const early = await act(saveId, { action: "complete" });
  assert.equal(early.status, 409, "files that are not all stored and verified cannot be packed");
  assert.equal(early.body.code, "incomplete");
});

test("a damaged file is reported as 422 hash_mismatch with the file named", async () => {
  const bytes = randomBytes(3000);
  const { saveId } = (await begin({ sessionId: "chat-a", label: "Damaged", files: [describe("a.bin", bytes)] })).body;
  await slice(saveId, 0, 0, randomBytes(3000));
  const verified = await act(saveId, { action: "verify", file: 0 });
  assert.equal(verified.status, 422);
  assert.equal(verified.body.code, "hash_mismatch");
  assert.match(verified.body.error, /a\.bin.*damaged/);
});

test("the route files answer the same way, with the id taken from the path", async () => {
  const { bytes, body } = payload("chat-route");
  const begun = await answer(await collection.POST(new Request(url(), { method: "POST", body: JSON.stringify(body) })));
  assert.equal(begun.status, 200);
  const params = Promise.resolve({ saveId: begun.body.saveId });
  const put = await single.PUT(new Request(url(`/${begun.body.saveId}`, "?file=0&offset=0"), { method: "PUT", headers: { "Content-Length": String(4096) }, body: bytes.subarray(0, 4096) }), { params });
  assert.equal((await put.json()).received, 4096);
  assert.equal((await answer(await single.GET(new Request(url(`/${begun.body.saveId}`)), { params }))).body.state, "uploading");
  const listed = await answer(await collection.GET(new Request(url("", "?sessionId=chat-route&unfinished=1"))));
  assert.equal(listed.body.root, config.root);
  assert.ok(listed.body.saves.some((save) => save.saveId === begun.body.saveId));
  const gone = await answer(await single.DELETE(new Request(url(`/${begun.body.saveId}`), { method: "DELETE" }), { params }));
  assert.deepEqual(gone.body, { removed: true });
});

test("the list shows a finished save with its archive and every file's name, size and SHA-256, for one chat or all", async () => {
  const one = await saveAll("chat-list-1");
  await saveAll("chat-list-2");
  const mine = await list("?sessionId=chat-list-1");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.saves.length, 1);
  assert.equal(mine.body.saves[0].saveId, one.saveId);
  assert.equal(mine.body.saves[0].archive, one.done.archive);
  assert.deepEqual(mine.body.saves[0].files.map((file) => [file.name, file.size, file.sha256]), [["part.bin", 6000, sha256(one.bytes)]]);
  assert.ok((await list("")).body.saves.length >= 2);
  assert.equal(mine.body.saves.every((save) => save.state === "complete"), true, "unfinished saves are only listed when asked for");
});

// ---------------------------------------------------------------------------
// While the archive is built
// ---------------------------------------------------------------------------

test("a complete that takes longer than a request should wait answers 200 building with how much is packed, and asking again, or completing again, joins it", async () => {
  disk.reset();
  const { saveId } = await uploaded("chat-building");
  const hold = disk.holdArchive(1_600_000);
  const first = await quick.act(saveId, { action: "complete" });
  assert.equal(first.status, 200);
  assert.equal(first.body.state, "building");
  await hold.reached;
  const asked = await quick.status(saveId);
  assert.equal(asked.body.state, "building");
  assert.ok(asked.body.packedBytes > 0 && asked.body.packedBytes < asked.body.totalBytes);
  assert.equal(asked.body.archiveBytes, undefined);
  assert.equal(asked.response.headers.get("cache-control"), "no-store");
  const again = await quick.act(saveId, { action: "complete" });
  assert.equal(again.body.state, "building", "a second complete joins the build and gets the same answer");
  assert.equal(disk.archive.opened, 1);

  hold.release();
  let finished;
  for (let attempt = 0; attempt < 200 && finished?.body.state !== "complete"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    finished = await quick.status(saveId);
  }
  assert.equal(finished.body.state, "complete");
  assert.equal(finished.body.verified, true);
  assert.equal(disk.archive.opened, 1);
  assertArchiveOpens(assert, finished.body.archive);
});

test("a build that ends the complete call because the disk is full is a 507 disk_full in plain words, and the files are still there to try again", async () => {
  disk.reset();
  const { saveId, files } = await uploaded("chat-full");
  const patient = api({ root: config.root, limits: { ...config.limits, maxChunkBytes: 1 * MiB } });
  disk.archive.fullAfter = 300_000;
  const refused = await patient.act(saveId, { action: "complete" });
  assert.equal(refused.status, 507);
  assert.equal(refused.body.code, "disk_full");
  assert.match(refused.body.error, /disk is full/);
  assert.match(refused.body.error, /still on the server/);
  const after = await patient.status(saveId);
  assert.equal(after.body.state, "uploading");
  assert.equal(after.body.buildError.code, "disk_full");
  assert.equal(after.body.buildError.message, refused.body.error);
  assert.ok(after.body.files.every((file) => file.verified));

  disk.reset();
  const retried = await patient.act(saveId, { action: "complete" });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.state, "complete");
  const inside = await readArchive(retried.body.archive);
  assert.ok(inside.get(retried.body.files[0].entry).bytes.equals(files[0]));
});

test("an archive that fails its own re-read ends the complete call with a 422 that names the file", async () => {
  disk.reset();
  const { saveId } = await uploaded("chat-damaged");
  const patient = api({ root: config.root, limits: { ...config.limits, maxChunkBytes: 1 * MiB } });
  disk.archive.corruptAt = 500_000;
  const refused = await patient.act(saveId, { action: "complete" });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "archive_check_failed");
  assert.match(refused.body.error, /system\.bin/);
  disk.reset();
  assert.equal((await patient.act(saveId, { action: "complete" })).body.state, "complete");
});

test("deleting a save stops its build: the delete answers removed, whoever was waiting on the build is told, and nothing is left", async () => {
  disk.reset();
  const { saveId } = await uploaded("chat-stop");
  const patient = api({ root: config.root, limits: { ...config.limits, maxChunkBytes: 1 * MiB } });
  const hold = disk.holdArchive(1_000_000);
  assert.equal((await quick.act(saveId, { action: "complete" })).body.state, "building");
  await hold.reached;
  const waiting = patient.act(saveId, { action: "complete" });
  const removing = remove(saveId);
  for (let attempt = 0; attempt < 200 && globalThis.__codyVaultBuilds.get(saveId)?.controller.signal.aborted !== true; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(globalThis.__codyVaultBuilds.get(saveId)?.controller.signal.aborted, true, "the build was told to stop before it was let go");
  hold.release();
  const [told, removed] = await Promise.all([waiting, removing]);
  assert.deepEqual(removed.body, { removed: true });
  assert.equal(told.status, 409);
  assert.equal(told.body.code, "aborted");
  assert.equal((await status(saveId)).status, 404);
  assert.deepEqual(readdirSync(join(config.root, ".incoming")).filter((name) => name === saveId), []);
});

// ---------------------------------------------------------------------------
// With accounts
// ---------------------------------------------------------------------------

test("with accounts, nothing works without a credential, and the answer is the same 401 every route gives", async () => {
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "admin" });
  users.createUser({ username: "bob", fullName: "Bob", passwordHash: "x", role: "member" });
  setSessionOwner("chat-alice", alice.id);
  const { body } = payload("chat-alice");
  const refused = await begin(body);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.code, "auth_required");
  assert.equal((await list("")).status, 401);
  assert.equal((await status("0".repeat(32))).status, 401);
  assert.equal((await remove("0".repeat(32))).status, 401);
});

test("a save is for a chat the account can open, and another account can neither see it, add to it, finish it nor delete it, whether its archive is being built or done", async () => {
  const alice = users.findUserByUsername("alice");
  const bob = users.findUserByUsername("bob");

  const intruder = await begin(payload("chat-alice").body, bob);
  assert.equal(intruder.status, 403);
  assert.equal(intruder.body.code, "access_denied");
  assert.equal((await list("?sessionId=chat-alice", bob)).status, 403);

  const { bytes, body } = payload("chat-alice");
  const begun = await begin(body, alice);
  assert.equal(begun.status, 200);
  assert.equal(begun.body.owner, alice.id);
  const { saveId } = begun.body;

  const strangerTries = [
    () => status(saveId, bob),
    () => slice(saveId, 0, 0, bytes.subarray(0, 100), bob),
    () => act(saveId, { action: "verify", file: 0 }, bob),
    () => act(saveId, { action: "complete" }, bob),
    () => remove(saveId, bob),
  ];
  for (const attempt of strangerTries) {
    const result = await attempt();
    assert.equal(result.status, 404, "another account's save is reported as missing, not as forbidden");
    assert.equal(result.body.code, "unknown_save");
  }
  assert.equal((await slice(saveId, 0, 0, bytes.subarray(0, 4096), alice)).status, 200);
  assert.equal((await slice(saveId, 0, 4096, bytes.subarray(4096), alice)).status, 200);
  assert.equal((await act(saveId, { action: "verify", file: 0 }, alice)).status, 200);
  const done = await act(saveId, { action: "complete" }, alice);
  assert.equal(done.status, 200);
  const inside = await readArchive(done.body.archive);
  assert.equal(JSON.parse(inside.get(done.body.files[0].entry.replace(/\/[^/]+$/, "/manifest.json")).bytes.toString("utf8")).owner.name, "alice");

  assert.deepEqual((await list("", bob)).body.saves.filter((save) => save.owner === alice.id), [], "the list never shows another account's saves");
  assert.ok((await list("", alice)).body.saves.some((save) => save.saveId === saveId));
  assert.equal((await status(saveId, alice)).status, 200);
  for (const attempt of strangerTries) assert.equal((await attempt()).status, 404, "nor can they once the save is an archive");
  assert.equal((await status(saveId, alice)).body.state, "complete", "and none of that touched it");
});

test("a build in progress belongs to the account that made the save: another account cannot read it, finish it again or stop it", async () => {
  disk.reset();
  const alice = users.findUserByUsername("alice");
  const bob = users.findUserByUsername("bob");
  const { saveId } = await uploaded("chat-alice", alice);
  const hold = disk.holdArchive(1_000_000);
  assert.equal((await quick.act(saveId, { action: "complete" }, alice)).body.state, "building");
  await hold.reached;
  for (const attempt of [() => quick.status(saveId, bob), () => quick.act(saveId, { action: "complete" }, bob), () => quick.remove(saveId, bob)]) {
    const result = await attempt();
    assert.equal(result.status, 404);
    assert.equal(result.body.code, "unknown_save");
  }
  assert.equal((await quick.status(saveId, alice)).body.state, "building", "the build was not stopped");
  hold.release();
  let finished;
  for (let attempt = 0; attempt < 200 && finished?.body.state !== "complete"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    finished = await quick.status(saveId, alice);
  }
  assert.equal(finished.body.state, "complete");
});

test("a chat nobody owns is open to every account, as everywhere else, but the save made there belongs to whoever made it", async () => {
  const alice = users.findUserByUsername("alice");
  const bob = users.findUserByUsername("bob");
  const { body } = payload("chat-nobody");
  const aliceSave = await begin(body, alice);
  assert.equal(aliceSave.status, 200);
  assert.equal((await status(aliceSave.body.saveId, bob)).status, 404);
  const bobSave = await begin(payload("chat-nobody").body, bob);
  assert.equal(bobSave.status, 200);
  assert.notEqual(bobSave.body.saveId, aliceSave.body.saveId);
});
