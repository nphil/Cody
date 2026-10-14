import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listOmpCredentials, removeOmpCredential, removeOmpProvider } = await jiti.import("./omp-credentials.ts");
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "cody-omp-credentials-"));
const packageRoot = path.join(fixtureDir, "omp");
const modules = path.join(packageRoot, "node_modules", "@oh-my-pi");
const agentDir = path.join(fixtureDir, "agent");
const nativeLog = path.join(fixtureDir, "native.jsonl");
await mkdir(modules, { recursive: true }); await mkdir(agentDir, { recursive: true });
await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", type: "module" }));
await mkdir(path.join(modules, "pi-ai")); await mkdir(path.join(modules, "pi-utils"));
await writeFile(path.join(modules, "pi-ai", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-ai", type: "module", exports: { "./auth-storage.js": "./auth-storage.js" } }));
await writeFile(path.join(modules, "pi-utils", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-utils", type: "module", exports: { "./dirs.js": "./dirs.js" } }));
await writeFile(path.join(modules, "pi-utils", "dirs.js"), "export function getAgentDbPath() { return process.env.PI_CODING_AGENT_DIR + \"/agent.db\"; }");
// Fixture models three credentials for "anthropic" (ids 2 blocked, 5 healthy)
// plus one disabled "openai-codex" row (id 1) and one live "openai-codex"
// row (id 7) — enough to exercise the merge, sort, and secret-allowlist.
await writeFile(path.join(modules, "pi-ai", "auth-storage.js"), [
  "import { appendFileSync } from \"node:fs\";",
  "export class AuthStorage {",
  "  static async create(dbPath) { globalThis.dbPath = dbPath; return new AuthStorage(); }",
  "  async reload() {}",
  "  listStoredCredentials(provider) {",
  "    const rows = [",
  "      { id: 2, provider: \"anthropic\", credential: { type: \"oauth\", email: \"nitinphilip@gmail.com\", accessToken: \"secret-access\", refreshToken: \"secret-refresh\" } },",
  "      { id: 5, provider: \"anthropic\", credential: { type: \"oauth\", email: \"nathanrkx@gmail.com\", accessToken: \"secret-access-2\" } },",
  "      { id: 7, provider: \"openai-codex\", credential: { type: \"api_key\", apiKey: \"secret-key\" } },",
  "    ];",
  "    return provider ? rows.filter((row) => row.provider === provider) : rows;",
  "  }",
  "  async listDisabledCredentials() { return [{ id: 1, provider: \"openai-codex\", type: \"oauth\", accountId: \"acct-1\", cause: \"revoked\" }]; }",
  "  listCredentialBlocks(ids) { return ids.includes(2) ? [{ credentialId: 2, providerKey: \"anthropic\", blockScope: \"account\", blockedUntilMs: Date.now() + 3600_000 }, { credentialId: 2, providerKey: \"anthropic\", blockScope: \"stale\", blockedUntilMs: Date.now() - 3600_000 }] : []; }",
  "  async removeCredential(provider, id) {",
  "    appendFileSync(process.env.CODY_CREDENTIALS_FIXTURE_LOG, JSON.stringify({ op: \"remove\", provider, id }) + \"\\n\");",
  "    return provider === \"anthropic\" && id === 5;",
  "  }",
  "  async remove(provider) {",
  "    appendFileSync(process.env.CODY_CREDENTIALS_FIXTURE_LOG, JSON.stringify({ op: \"remove_provider\", provider }) + \"\\n\");",
  "  }",
  "  async close() {}",
  "}",
].join("\n"));
const previousLog = process.env.CODY_CREDENTIALS_FIXTURE_LOG; process.env.CODY_CREDENTIALS_FIXTURE_LOG = nativeLog;
const deps = { helperPath: path.resolve(process.cwd(), "bin/cody-omp-credentials.mjs"), bunBin: process.execPath, packageRoot: () => packageRoot, agentDir: () => agentDir };
test.after(async () => { if (previousLog === undefined) delete process.env.CODY_CREDENTIALS_FIXTURE_LOG; else process.env.CODY_CREDENTIALS_FIXTURE_LOG = previousLog; await rm(fixtureDir, { recursive: true, force: true }); });

test("real child helper merges active and disabled rows, sorted by id, with no secret fields", async () => {
  const snapshot = await listOmpCredentials(deps);
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.credentials.map((row) => row.id), [1, 2, 5, 7]);
  for (const row of snapshot.credentials) {
    assert.deepEqual(Object.keys(row).sort(), ["blockedUntil", "disabledCause", "id", "identity", "pinHash", "planType", "provider", "type"]);
  }
});
test("OAuth rows carry omp's credential-pin digest, the value session files record", async () => {
  const snapshot = await listOmpCredentials(deps);
  const byId = new Map(snapshot.credentials.map((row) => [row.id, row]));
  // src/session/credential-pin.ts: sha256(provider, accountId, email, orgId,
  // projectId joined by NUL) — the persisted contract a session's pin names.
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256").update(["anthropic", "", "nathanrkx@gmail.com", "", ""].join("\0")).digest("hex");
  assert.equal(byId.get(5)?.pinHash, expected);
  assert.equal(byId.get(7)?.pinHash, null, "an API key has no account to pin");
  assert.equal(byId.get(1)?.pinHash, null, "a disabled row serves nothing");
});
test("identity resolves email for oauth rows and null for api_key rows", async () => {
  const snapshot = await listOmpCredentials(deps);
  const byId = new Map(snapshot.credentials.map((row) => [row.id, row]));
  assert.equal(byId.get(2)?.identity, "nitinphilip@gmail.com");
  assert.equal(byId.get(5)?.identity, "nathanrkx@gmail.com");
  assert.equal(byId.get(7)?.identity, null);
  assert.equal(byId.get(1)?.identity, "acct-1");
});
test("disabled rows carry their cause; active rows do not", async () => {
  const snapshot = await listOmpCredentials(deps);
  const byId = new Map(snapshot.credentials.map((row) => [row.id, row]));
  assert.equal(byId.get(1)?.disabledCause, "revoked");
  assert.equal(byId.get(2)?.disabledCause, null);
});
test("blockedUntil reports only the latest UNEXPIRED block, ignoring stale ones", async () => {
  const snapshot = await listOmpCredentials(deps);
  const blocked = snapshot.credentials.find((row) => row.id === 2);
  assert.ok(blocked?.blockedUntil);
  assert.ok(new Date(blocked.blockedUntil).getTime() > Date.now());
  const unblocked = snapshot.credentials.find((row) => row.id === 5);
  assert.equal(unblocked?.blockedUntil, null);
});
test("removeOmpCredential reports providerRemoved once every sibling credential is gone", async () => {
  const outcome = await removeOmpCredential("anthropic", 5, deps);
  assert.equal(outcome.removed, true);
  assert.equal(outcome.providerRemoved, false);
  const nativeRequest = JSON.parse((await readFile(nativeLog, "utf8")).trim().split("\n").at(-1));
  assert.deepEqual(nativeRequest, { op: "remove", provider: "anthropic", id: 5 });
});
test("removeOmpCredential surfaces a false outcome without throwing", async () => {
  const outcome = await removeOmpCredential("anthropic", 999, deps);
  assert.equal(outcome.removed, false);
  assert.equal(outcome.providerRemoved, false);
});
test("removeOmpProvider always reports providerRemoved true, and how many stored accounts it signed out", async () => {
  const outcome = await removeOmpProvider("openai-codex", deps);
  assert.equal(outcome.removed, true);
  assert.equal(outcome.providerRemoved, true);
  assert.equal(outcome.count, 1, "one live openai-codex credential (the disabled row is not an account that signed out)");
  const nativeRequest = JSON.parse((await readFile(nativeLog, "utf8")).trim().split("\n").at(-1));
  assert.deepEqual(nativeRequest, { op: "remove_provider", provider: "openai-codex" });
});
test("a missing helper script degrades to unsupported instead of throwing", async () => {
  const brokenDeps = { ...deps, helperPath: path.join(fixtureDir, "missing-helper.mjs") };
  const snapshot = await listOmpCredentials(brokenDeps);
  assert.equal(snapshot.available, false);
  const removal = await removeOmpCredential("anthropic", 5, brokenDeps);
  assert.equal(removal.removed, false);
});
