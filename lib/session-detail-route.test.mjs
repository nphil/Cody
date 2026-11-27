import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-detail-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = path.join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("../app/api/sessions/[id]/detail/route.ts");
const { buildSessionContext, getSessionEntries } = await jiti.import("@/lib/session-reader");
const { LAZY_BLOCK_MIN_CHARS, LAZY_PAGE_CHARS } = await jiti.import("@/lib/lazy-blocks");
const users = await jiti.import("@/lib/auth/users");
const owners = await jiti.import("@/lib/auth/session-owners");
const tokens = await jiti.import("@/lib/auth/tokens");
const password = await jiti.import("@/lib/auth/password");

// Position-dependent text: a wrong or duplicated page is visible. The emoji sprinkled in
// make page cuts land between the halves of a surrogate pair.
const makeText = (length, tag) => {
  let text = "";
  for (let i = 0; text.length < length; i += 1) text += `${tag}${String(i).padStart(5, "0")}${i % 7 === 0 ? "😀" : "_"}`;
  // Never end on half an emoji: a stored string is well formed text.
  return /[\ud800-\udbff]$/.test(text.slice(0, length)) ? text.slice(0, length - 1) : text.slice(0, length);
};
const THINKING = makeText(LAZY_PAGE_CHARS * 2 + 501, "T");
// More than the old 1 MiB view cap: every one of its pages must stay reachable.
const RESULT = makeText(1_048_576 + 70_000, "R");
const CONTENT = makeText(LAZY_BLOCK_MIN_CHARS + 100, "C");
const TOOL_COMMAND = `open_url -j '${JSON.stringify({ url: makeText(LAZY_BLOCK_MIN_CHARS + 10, "U") })}'`;
const TOOL_OUTPUT = makeText(LAZY_BLOCK_MIN_CHARS + 10, "O");
const ORPHAN = makeText(LAZY_BLOCK_MIN_CHARS + 10, "P");
const SECRET = "details-secret-do-not-serve";
const SIGNATURE = "thinking-signature-do-not-serve";

const sessionsDir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "--proj--");
fs.mkdirSync(sessionsDir, { recursive: true });
const sessionFile = path.join(sessionsDir, "2026-08-01T00-00-00-000Z_detailsess.jsonl");
const entry = (id, parentId, message) => JSON.stringify({ type: "message", id, parentId, timestamp: "2026-08-01T00:00:01.000Z", message });
fs.writeFileSync(sessionFile, [
  JSON.stringify({ type: "session", version: 3, id: "detailsess", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp/proj" }),
  entry("u1", null, { role: "user", content: "go", timestamp: 1 }),
  entry("a1", "u1", {
    role: "assistant", provider: "p", model: "m", timestamp: 2,
    content: [
      { type: "thinking", thinking: THINKING, thinkingSignature: SIGNATURE },
      { type: "text", text: "writing" },
      { type: "toolCall", id: "call1", name: "write", arguments: { path: "/f", content: CONTENT } },
    ],
  }),
  entry("r1", "a1", {
    role: "toolResult", toolCallId: "call1", toolName: "write", timestamp: 3,
    content: [{ type: "text", text: RESULT }], details: { internal: SECRET },
  }),
  entry("a2", "r1", {
    role: "assistant", provider: "p", model: "m", timestamp: 4,
    content: [{ type: "toolCall", id: "call2", name: "bash", arguments: { command: TOOL_COMMAND } }],
  }),
  entry("r2", "a2", {
    role: "toolResult", toolCallId: "call2", toolName: "bash", timestamp: 5,
    content: [{ type: "text", text: TOOL_OUTPUT }], details: { toolCommands: [{ tool: "open_url", mode: "json", exitCode: 0 }] },
  }),
  entry("r3", "r2", { role: "toolResult", toolCallId: "nobody", toolName: "read", timestamp: 6, content: [{ type: "text", text: ORPHAN }] }),
  // omp's retry saga: the failed attempt is not part of the transcript, so none of it is readable.
  entry("a3", "r3", {
    role: "assistant", provider: "p", model: "m", timestamp: 7, retryRecovery: { attempt: 1 },
    content: [{ type: "thinking", thinking: makeText(LAZY_BLOCK_MIN_CHARS + 10, "H") }],
  }),
].join("\n") + "\n");

const call = (entryId, query, headers = {}, id = "detailsess") =>
  GET(new Request(`http://localhost/api/sessions/${id}/detail?${new URLSearchParams({ entryId, ...query })}`, { headers }), {
    params: Promise.resolve({ id }),
  });

async function readPage(entryId, query, page) {
  const res = await call(entryId, { ...query, page: String(page) });
  assert.equal(res.status, 200, `${entryId} page ${page}`);
  return res.json();
}

/** First to last page, every response checked, joined. */
async function readAll(entryId, query) {
  const first = await readPage(entryId, query, 0);
  let text = first.text;
  for (let page = 1; page < first.pages; page += 1) {
    const next = await readPage(entryId, query, page);
    assert.equal(next.pages, first.pages);
    assert.equal(next.total, first.total);
    assert.ok(next.text.length <= LAZY_PAGE_CHARS + 1);
    text += next.text;
  }
  return { text, total: first.total, pages: first.pages };
}

test("thinking, result and argument text read back whole, page by page", async () => {
  assert.deepEqual(await readAll("a1", { kind: "thinking", blockIndex: "0" }), { text: THINKING, total: THINKING.length, pages: 3 });
  const content = await readAll("a1", { kind: "arg", blockIndex: "2", pointer: "/content" });
  assert.deepEqual(content, { text: CONTENT, total: CONTENT.length, pages: 1 });
});

test("a result longer than 1 MiB is fully reachable: first, last, and back from the last", async () => {
  const query = { kind: "result", blockIndex: "0" };
  const all = await readAll("r1", query);
  assert.equal(all.total, RESULT.length);
  assert.equal(all.pages, Math.ceil(RESULT.length / LAZY_PAGE_CHARS));
  assert.ok(all.pages > 16, "past the old 16-page / 1 MiB view");
  assert.equal(all.text, RESULT, "every character of every page, in order");

  const last = await readPage("r1", query, all.pages - 1);
  assert.ok(RESULT.endsWith(last.text));
  assert.equal(last.page, all.pages - 1);
  const back = await readPage("r1", query, all.pages - 2);
  assert.ok(RESULT.slice(0, RESULT.length - last.text.length).endsWith(back.text));
  assert.ok(RESULT.startsWith((await readPage("r1", query, 0)).text));
});

test("a smaller limit changes the page size, and cuts never fall inside an emoji", async () => {
  const query = { kind: "result", blockIndex: "0", limit: "1001" };
  const first = await (await call("r1", { ...query, page: "0" })).json();
  assert.equal(first.pages, Math.ceil(RESULT.length / 1001));
  let rebuilt = "";
  for (let page = 0; page < 40; page += 1) {
    const slice = await (await call("r1", { ...query, page: String(page) })).json();
    assert.doesNotMatch(slice.text, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
    rebuilt += slice.text;
  }
  assert.equal(rebuilt, RESULT.slice(0, rebuilt.length));
});

test("responses are never cached and carry the text window only, never details or other fields", async () => {
  for (const [entryId, query] of [["r1", { kind: "result", blockIndex: "0" }], ["a1", { kind: "thinking", blockIndex: "0" }]]) {
    const res = await call(entryId, query);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const text = await res.text();
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["page", "pages", "text", "total"]);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(SIGNATURE), false);
  }
});

test("malformed requests are 400", async () => {
  for (const query of [
    {}, { kind: "thinking" }, { kind: "thinking", blockIndex: "-1" }, { kind: "thinking", blockIndex: "x" },
    { kind: "nope", blockIndex: "0" }, { kind: "thinking", blockIndex: "0", page: "-1" }, { kind: "thinking", blockIndex: "0", page: "1.5" },
    { kind: "thinking", blockIndex: "0", limit: "0" }, { kind: "thinking", blockIndex: "0", limit: "1.5" },
    { kind: "arg", blockIndex: "2" }, { kind: "thinking", blockIndex: "0", pointer: "/x" },
  ]) {
    assert.equal((await call("a1", query)).status, 400, JSON.stringify(query));
  }
  for (const entryId of ["", "a/b", "x".repeat(65)]) {
    assert.equal((await call(entryId, { kind: "thinking", blockIndex: "0" })).status, 400, `entryId ${JSON.stringify(entryId)}`);
  }
});

test("a block that is not a displayed field, or a page that does not exist, is 404", async () => {
  for (const [entryId, query] of [
    ["a1", { kind: "thinking", blockIndex: "1" }],
    ["a1", { kind: "result", blockIndex: "0" }],
    ["a1", { kind: "arg", blockIndex: "2", pointer: "/path/x" }],
    ["a1", { kind: "arg", blockIndex: "2", pointer: "/__proto__" }],
    ["a1", { kind: "arg", blockIndex: "2", pointer: "" }],
    ["r1", { kind: "thinking", blockIndex: "0" }],
    ["r1", { kind: "result", blockIndex: "5" }],
    ["u1", { kind: "result", blockIndex: "0" }],
    ["nope", { kind: "thinking", blockIndex: "0" }],
    ["a3", { kind: "thinking", blockIndex: "0" }],
    ["a1", { kind: "thinking", blockIndex: "0", page: "3" }],
  ]) {
    assert.equal((await call(entryId, query)).status, 404, `${entryId} ${JSON.stringify(query)}`);
  }
});

test("an unknown session is 404", async () => {
  assert.equal((await call("a1", { kind: "thinking", blockIndex: "0" }, {}, "nosuchsession")).status, 404);
});

test("another account's session answers 404, the owner's own token reads the text", async () => {
  const hash = await password.hashPassword("long enough");
  const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: hash, role: "member" });
  const bob = users.createUser({ username: "bob", fullName: "Bob", passwordHash: hash, role: "member" });
  owners.setSessionOwner("detailsess", alice.id);
  try {
    const query = { kind: "thinking", blockIndex: "0" };
    const bobRes = await call("a1", query, { authorization: `Bearer ${tokens.issueAccessToken(bob, "t").secret}` });
    assert.equal(bobRes.status, 404);
    assert.equal((await bobRes.text()).includes(THINKING.slice(0, 40)), false);
    const aliceRes = await call("a1", query, { authorization: `Bearer ${tokens.issueAccessToken(alice, "t").secret}` });
    assert.equal(aliceRes.status, 200);
  } finally {
    owners.forgetSession("detailsess");
  }
});

test("the history payload keeps previews for what a card can expand and every other output whole", async () => {
  const entries = getSessionEntries(sessionFile);
  const context = buildSessionContext(entries, "r3", { deferOversizedBlocks: true });
  const serialized = JSON.stringify(context);
  assert.ok(serialized.length < 120_000, `payload is ${serialized.length} bytes`);
  assert.equal(serialized.includes(SECRET), false);

  // Stubbed: thinking, the argument of a generic call and the result paired with it.
  const [first, second] = context.messages.filter((m) => m.role === "assistant");
  assert.deepEqual(first.content[0], { type: "thinking", thinking: "", deferred: true, lazyChars: THINKING.length, lazyEntry: "a1" });
  const write = first.content[2];
  assert.deepEqual(write.lazyInput, { "/content": CONTENT.length });
  const [resultOne, resultTwo, orphan] = context.messages.filter((m) => m.role === "toolResult");
  assert.equal(resultOne.content[0].lazyChars, RESULT.length);
  assert.ok(resultOne.content[0].text.length < 2000);

  // Whole: a tool command's call and its result, and a result whose call is not on the branch.
  assert.equal(second.content[0].input.command, TOOL_COMMAND);
  assert.equal(second.content[0].lazyInput, undefined);
  assert.equal(resultTwo.content[0].text, TOOL_OUTPUT);
  assert.equal(resultTwo.content[0].lazyChars, undefined);
  assert.equal(orphan.content[0].text, ORPHAN);
  assert.equal(orphan.content[0].lazyChars, undefined);

  // Every stub resolves, at the block index it sits at, to the text it replaced.
  assert.equal((await readAll(first.content[0].lazyEntry, { kind: "thinking", blockIndex: "0" })).text, THINKING);
  assert.equal((await readAll(write.lazyEntry, { kind: "arg", blockIndex: "2", pointer: Object.keys(write.lazyInput)[0] })).text, CONTENT);
  assert.equal((await readAll(resultOne.content[0].lazyEntry, { kind: "result", blockIndex: "0" })).text, RESULT);

  // Without the option the full text rides along, exactly as before.
  assert.ok(JSON.stringify(buildSessionContext(entries, "r3", {})).includes(RESULT.slice(0, 5000)));
});
