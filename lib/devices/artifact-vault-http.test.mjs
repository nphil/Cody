import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * "Save to server" as the page sees it: the routes, their auth and their owner checks. The vault's own behaviour has
 * its own file; this one is about who may do what and what a bad request gets back.
 */
const scratch = mkdtempSync(join(tmpdir(), "cody-vault-http-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.CODY_ACCOUNTS_DIR = join(scratch, "accounts");
process.env.CODY_DEVICE_ARTIFACTS_DIR = join(scratch, "vault");
process.env.CODY_INTERNAL_DISPLAY_SECRET = Buffer.from("vault-http-test-secret").toString("base64url");
delete process.env.CODY_PASSWORD;
delete process.env.CODY_REQUIRE_ACCOUNTS;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const http = await jiti.import("./artifact-vault-http.ts");
const { DEFAULT_VAULT_LIMITS } = await jiti.import("./artifact-vault.ts");
const collection = await jiti.import("../../app/api/devices/artifacts/saves/route.ts");
const single = await jiti.import("../../app/api/devices/artifacts/saves/[saveId]/route.ts");
const users = await jiti.import("../auth/users.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");
const { setSessionOwner } = await jiti.import("../auth/session-owners.ts");

const config = { root: join(scratch, "vault"), limits: { ...DEFAULT_VAULT_LIMITS, maxChunkBytes: 4096, minFreeBytes: 0 } };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const as = (user) => (user ? { Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` } : {});
const answer = async (response) => ({ status: response.status, response, body: await response.clone().json() });

const url = (path = "", query = "") => `http://cody.test/api/devices/artifacts/saves${path}${query}`;
const begin = async (body, user) => answer(await http.handleBegin(new Request(url(), { method: "POST", headers: { "Content-Type": "application/json", ...as(user) }, body: JSON.stringify(body) }), config));
const slice = async (saveId, file, offset, bytes, user, headers = {}) =>
  answer(await http.handleSlice(new Request(url(`/${saveId}`, `?file=${file}&offset=${offset}`), { method: "PUT", headers: { "Content-Length": String(bytes.length), ...as(user), ...headers }, body: bytes }), saveId, config));
const act = async (saveId, body, user) => answer(await http.handleAction(new Request(url(`/${saveId}`), { method: "POST", headers: { "Content-Type": "application/json", ...as(user) }, body: JSON.stringify(body) }), saveId, config));
const status = async (saveId, user) => answer(await http.handleStatus(new Request(url(`/${saveId}`), { headers: as(user) }), saveId, config));
const list = async (query, user) => answer(await http.handleList(new Request(url("", query), { headers: as(user) }), config));
const remove = async (saveId, user) => answer(await http.handleDelete(new Request(url(`/${saveId}`), { method: "DELETE", headers: as(user) }), saveId, config));

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

test("on an open instance a save goes through begin, slices, verify and complete, uncached", async () => {
  const { bytes, body } = payload();
  const begun = await begin(body);
  assert.equal(begun.status, 200);
  assert.equal(begun.response.headers.get("cache-control"), "no-store");
  assert.equal(begun.body.state, "uploading");
  assert.equal(begun.body.owner, null);
  const { saveId } = begun.body;

  const first = await slice(saveId, 0, 0, bytes.subarray(0, 4096));
  assert.deepEqual(first.body, { received: 4096 });
  assert.equal((await status(saveId)).body.files[0].received, 4096);
  assert.equal((await slice(saveId, 0, 4096, bytes.subarray(4096))).body.received, 6000);
  assert.deepEqual((await act(saveId, { action: "verify", file: 0 })).body, { ok: true, sha256: sha256(bytes) });
  const done = await act(saveId, { action: "complete" });
  assert.equal(done.body.state, "complete");
  assert.equal(done.body.verified, true);
  assert.equal(sha256(readFileSync(join(done.body.folder, "part.bin"))), sha256(bytes));
  assert.ok(done.body.folder.startsWith(config.root));
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

test("the list shows a finished save with every file's name, size and SHA-256, for one chat or all", async () => {
  const one = await saveAll("chat-list-1");
  await saveAll("chat-list-2");
  const mine = await list("?sessionId=chat-list-1");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.saves.length, 1);
  assert.equal(mine.body.saves[0].saveId, one.saveId);
  assert.deepEqual(mine.body.saves[0].files.map((file) => [file.name, file.size, file.sha256]), [["part.bin", 6000, sha256(one.bytes)]]);
  assert.ok((await list("")).body.saves.length >= 2);
  assert.equal(mine.body.saves.every((save) => save.state === "complete"), true, "unfinished saves are only listed when asked for");
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

test("a save is for a chat the account can open, and another account can neither see it, add to it, finish it nor delete it", async () => {
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

  for (const attempt of [
    () => status(saveId, bob),
    () => slice(saveId, 0, 0, bytes.subarray(0, 100), bob),
    () => act(saveId, { action: "verify", file: 0 }, bob),
    () => act(saveId, { action: "complete" }, bob),
    () => remove(saveId, bob),
  ]) {
    const result = await attempt();
    assert.equal(result.status, 404, "another account's save is reported as missing, not as forbidden");
    assert.equal(result.body.code, "unknown_save");
  }
  assert.equal((await slice(saveId, 0, 0, bytes.subarray(0, 4096), alice)).status, 200);
  assert.equal((await slice(saveId, 0, 4096, bytes.subarray(4096), alice)).status, 200);
  assert.equal((await act(saveId, { action: "verify", file: 0 }, alice)).status, 200);
  const done = await act(saveId, { action: "complete" }, alice);
  assert.equal(done.status, 200);
  assert.equal(JSON.parse(readFileSync(join(done.body.folder, "manifest.json"), "utf8")).owner.name, "alice");

  assert.deepEqual((await list("", bob)).body.saves.filter((save) => save.owner === alice.id), [], "the list never shows another account's saves");
  assert.ok((await list("", alice)).body.saves.some((save) => save.saveId === saveId));
  assert.equal((await status(saveId, alice)).status, 200);
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
