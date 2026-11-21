import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-sub-media-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("../app/api/sessions/[id]/subagents/[subagentId]/media/route.ts");
const { GET: GET_PAGE } = await jiti.import("../app/api/sessions/[id]/subagents/[subagentId]/route.ts");
const { siblingDirForSession } = await jiti.import("@/lib/subagent-history");
const users = await jiti.import("@/lib/auth/users");
const owners = await jiti.import("@/lib/auth/session-owners");
const tokens = await jiti.import("@/lib/auth/tokens");
const password = await jiti.import("@/lib/auth/password");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const HASH = "12".repeat(32);

const sessionsDir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "--proj--");
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "blobs"), { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "blobs", HASH), PNG);
const sessionFile = path.join(sessionsDir, "2026-08-01T00-00-00-000Z_mediasess.jsonl");
fs.writeFileSync(sessionFile, [
  JSON.stringify({ type: "session", version: 3, id: "mediasess", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp/proj" }),
  JSON.stringify({ type: "message", id: "p1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } }),
].join("\n") + "\n");
const artifacts = siblingDirForSession(sessionFile);
fs.mkdirSync(artifacts, { recursive: true });
const first = JSON.stringify({ type: "message", id: "e1", message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "Read" }, { type: "image", data: `blob:sha256:${HASH}`, mimeType: "image/webp" }] } }) + "\n";
const second = JSON.stringify({ type: "message", id: "e2", message: { role: "toolResult", toolCallId: "u", toolName: "read", content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] } }) + "\n";
fs.writeFileSync(path.join(artifacts, "Theme Helper.jsonl"), first + second);
// A file outside the artifacts dir that a symlinked "helper" would point at.
fs.writeFileSync(path.join(root, "outside.jsonl"), second);
fs.symlinkSync(path.join(root, "outside.jsonl"), path.join(artifacts, "Escape.jsonl"));

const call = (sub, query, headers = {}, id = "mediasess") =>
  GET(new Request(`http://localhost/api/sessions/${id}/subagents/${encodeURIComponent(sub)}/media?${new URLSearchParams(query)}`, { headers }), {
    params: Promise.resolve({ id, subagentId: sub }),
  });

test("serves the blob-backed and inline images a transcript page deferred", async () => {
  let res = await call("Theme Helper", { offset: "0", entryId: "e1", index: "0" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
  assert.equal(res.headers.get("cache-control"), "private, max-age=86400");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  res = await call("Theme Helper", { offset: String(Buffer.byteLength(first)), entryId: "e2", index: "0" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test("page urls from the reader are served by this route (index and offset stay aligned)", async () => {
  const { readSubagentTranscriptPage } = await jiti.import("@/lib/subagent-history");
  const page = readSubagentTranscriptPage(path.join(artifacts, "Theme Helper.jsonl"), 0, {
    imageUrl: (offset, entryId, index) => `/x?${new URLSearchParams({ offset: String(offset), entryId, index: String(index) })}`,
  });
  for (const message of page.messages) {
    const block = message.content.find((b) => b.type === "image");
    const q = Object.fromEntries(new URL(block.source.url, "http://x").searchParams);
    const res = await call("Theme Helper", q);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  }
});

test("bad references are 400, unknown images 404", async () => {
  for (const query of [
    {}, { offset: "0", entryId: "e1" }, { offset: "-1", entryId: "e1", index: "0" }, { offset: "1.5", entryId: "e1", index: "0" },
    { offset: "0", entryId: "../e1", index: "0" }, { offset: "0", entryId: "e1", index: "256" }, { offset: "0", entryId: "e1", index: "x" },
    { offset: "99999999999999999999", entryId: "e1", index: "0" },
  ]) {
    assert.equal((await call("Theme Helper", query)).status, 400, JSON.stringify(query));
  }
  assert.equal((await call("Theme Helper", { offset: "0", entryId: "e1", index: "1" })).status, 404);
  assert.equal((await call("Theme Helper", { offset: "3", entryId: "e1", index: "0" })).status, 404);
  assert.equal((await call("Theme Helper", { offset: "0", entryId: "e2", index: "0" })).status, 404);
  assert.equal((await call("Nobody", { offset: "0", entryId: "e1", index: "0" })).status, 404);
});

test("unsafe helper ids and symlinks out of the artifacts dir are refused", async () => {
  assert.equal((await call("../mediasess", { offset: "0", entryId: "e1", index: "0" })).status, 400);
  assert.equal((await call("a/b", { offset: "0", entryId: "e1", index: "0" })).status, 400);
  assert.equal((await call("Escape", { offset: "0", entryId: "e2", index: "0" })).status, 404);
});

test("an unknown session is 404", async () => {
  assert.equal((await call("Theme Helper", { offset: "0", entryId: "e1", index: "0" }, {}, "nosuchsession")).status, 404);
});

test("another account's session answers 404, the owner's own token sees the image", async () => {
  const hash = await password.hashPassword("long enough");
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: hash, role: "member" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: hash, role: "member" });
  owners.setSessionOwner("mediasess", alice.id);
  try {
    const query = { offset: "0", entryId: "e1", index: "0" };
    const bobRes = await call("Theme Helper", query, { authorization: `Bearer ${tokens.issueAccessToken(bob, "t").secret}` });
    assert.equal(bobRes.status, 404);
    const aliceRes = await call("Theme Helper", query, { authorization: `Bearer ${tokens.issueAccessToken(alice, "t").secret}` });
    assert.equal(aliceRes.status, 200);
  } finally {
    owners.forgetSession("mediasess");
  }
});

test("the transcript route ships the deferred url, never the blob ref or base64", async () => {
  const res = await GET_PAGE(new Request("http://localhost/api/sessions/mediasess/subagents/Theme%20Helper?tail=1"), {
    params: Promise.resolve({ id: "mediasess", subagentId: "Theme Helper" }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(HASH), false);
  assert.equal(text.includes(PNG.toString("base64")), false);
  const page = JSON.parse(text);
  const urls = page.messages.flatMap((m) => m.content.filter((b) => b.type === "image").map((b) => b.source.url));
  assert.deepEqual(urls, [
    "/api/sessions/mediasess/subagents/Theme%20Helper/media?offset=0&entryId=e1&index=0",
    `/api/sessions/mediasess/subagents/Theme%20Helper/media?offset=${page.offsets[1]}&entryId=e2&index=0`,
  ]);
  const served = await GET(new Request(`http://localhost${urls[1]}`), { params: Promise.resolve({ id: "mediasess", subagentId: "Theme Helper" }) });
  assert.equal(served.status, 200);
});
