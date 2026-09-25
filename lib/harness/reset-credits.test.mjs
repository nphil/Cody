import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listResetCredits, redeemResetCredit } = await jiti.import("./reset-credits.ts");
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "cody-reset-credit-"));
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
await writeFile(path.join(modules, "pi-ai", "auth-storage.js"), [
  "import { appendFileSync } from \"node:fs\";",
  "export class AuthStorage {",
  "  static async create(dbPath) { globalThis.dbPath = dbPath; return new AuthStorage(); }",
  "  async reload() { if (process.env.CODY_RESET_STORAGE_API === \"namespaced\") throw new Error(\"legacy reload invoked\"); }",
  "  get credentials() {",
  "    if (process.env.CODY_RESET_STORAGE_API !== \"namespaced\") return undefined;",
  "    return { owner: this, async reload() { if (!this.owner) throw new Error(\"unbound credentials reload\"); } };",
  "  }",
  "  get resets() {",
  "    if (process.env.CODY_RESET_STORAGE_API !== \"namespaced\") return undefined;",
  "    const owner = this;",
  "    return {",
  "      owner,",
  "      async list(options) { if (!this.owner) throw new Error(\"unbound reset list\"); return owner.readResetCredits(options); },",
  "      async redeem(options) { if (!this.owner) throw new Error(\"unbound reset redeem\"); return owner.performResetRedemption(options); },",
  "    };",
  "  }",
  "  async listResetCredits(options) {",
  "    if (process.env.CODY_RESET_STORAGE_API === \"namespaced\") throw new Error(\"legacy list invoked\");",
  "    return this.readResetCredits(options);",
  "  }",
  "  async readResetCredits(options) {",
  "    if (options?.provider === \"anthropic\") return [",
  "      { provider: \"anthropic\", credentialId: 7, orgName: \"Acme\", availableCount: 2, redeemableCount: 1, eligible: true, nextCreditId: \"grant-b\", active: true, credits: [{ id: \"grant-a\", status: \"available\", usable: false, expiresAt: \"2027-01-01T00:00:00.000Z\" }, { id: \"grant-b\", title: \"Saved reset\", status: \"available\", usable: true, expiresAt: \"2027-03-01T00:00:00.000Z\" }] },",
  "      { provider: \"anthropic\", credentialId: 8, availableCount: 1, redeemableCount: 0, eligible: true, active: false, credits: [{ id: \"grant-c\", status: \"unavailable\", usable: false }] },",
  "    ];",
  "    return [{ credentialId: 41, availableCount: 1, active: false, credits: [{ id: \"later\", status: \"available\", expiresAt: \"2027-02-01T00:00:00.000Z\" }, { id: \"earlier\", status: \"available\", expiresAt: \"2027-01-01T00:00:00.000Z\" }, { id: \"spent\", status: \"redeemed\" }] }];",
  "  }",
  "  async redeemResetCredit(options) {",
  "    if (process.env.CODY_RESET_STORAGE_API === \"namespaced\") throw new Error(\"legacy redeem invoked\");",
  "    return this.performResetRedemption(options);",
  "  }",
  "  async performResetRedemption(options) {",
  "    appendFileSync(process.env.CODY_RESET_FIXTURE_LOG, JSON.stringify(options) + \"\\n\");",
  "    const { provider, credentialId, creditId } = options.target;",
  "    if (provider === \"anthropic\") return credentialId === 7 && creditId === \"grant-b\" ? { ok: true, code: \"reset\", cleared: [\"anthropic:5h\"] } : { ok: false, code: \"offer_changed\" };",
  "    return provider === \"openai-codex\" && credentialId === 41 && creditId === \"earlier\" ? { ok: true, code: \"reset\" } : { ok: false, code: \"no_credit\" };",
  "  }",
  "  async close() {}",
  "}",
].join("\n"));
const previousLog = process.env.CODY_RESET_FIXTURE_LOG; process.env.CODY_RESET_FIXTURE_LOG = nativeLog;
const deps = { helperPath: path.resolve(process.cwd(), "bin/cody-omp-reset-credits.mjs"), bunBin: process.execPath, packageRoot: () => packageRoot, agentDir: () => agentDir };
test.after(async () => { if (previousLog === undefined) delete process.env.CODY_RESET_FIXTURE_LOG; else process.env.CODY_RESET_FIXTURE_LOG = previousLog; await rm(fixtureDir, { recursive: true, force: true }); });
test("real child helper reads only available credits, ordered by native expiry", async () => {
  const snapshot = await listResetCredits(deps);
  assert.equal(snapshot.available, true); assert.equal(snapshot.accounts[0]?.canRedeem, true);
  assert.deepEqual(snapshot.accounts[0]?.credits.map((credit) => credit.id), ["earlier", "later"]);
  assert.notEqual(snapshot.accounts[0]?.id, "41");
});
test("real child helper redeems the exact opaque account and selected credit", async () => {
  const snapshot = await listResetCredits(deps); const accountId = snapshot.accounts[0]?.id; assert.ok(accountId);
  const outcome = await redeemResetCredit({ accountId, creditId: "earlier", idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" }, deps);
  assert.equal(outcome.outcome, "reset");
  const nativeRequest = JSON.parse((await readFile(nativeLog, "utf8")).trim());
  // 18.2.9 reads provider and grant from the target; older builds from beside it.
  assert.deepEqual(nativeRequest.target, { credentialId: 41, provider: "openai-codex", creditId: "earlier" });
  assert.equal(nativeRequest.provider, "openai-codex"); assert.equal(nativeRequest.creditId, "earlier");
});
test("exact-credit redemption never substitutes a different available credit", async () => {
  const snapshot = await listResetCredits(deps);
  const accountId = snapshot.accounts[0]?.id;
  assert.ok(accountId);
  const outcome = await redeemResetCredit({ accountId, creditId: "later", idempotencyKey: "123e4567-e89b-42d3-a456-426614174001" }, deps);
  assert.equal(outcome.outcome, "no_credit");
  const nativeRequests = (await readFile(nativeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(nativeRequests.at(-1).creditId, "later");
});

test("Claude accounts list beside Codex, leading with the grant Claude pinned", async () => {
  const snapshot = await listResetCredits(deps);
  const claude = snapshot.accounts.filter((account) => account.provider === "anthropic");
  assert.equal(claude.length, 2);
  assert.equal(claude[0].label, "Claude (Acme)");
  assert.equal(claude[0].canRedeem, true);
  assert.deepEqual(claude[0].credits.map((credit) => credit.id), ["grant-b", "grant-a"]);
  assert.equal(claude[0].credits[0].title, "Saved reset");
  // A balance with no redeemable pin is shown, never offered, and says why.
  assert.equal(claude[1].canRedeem, false);
  assert.ok(claude[1].reason);
  assert.equal(snapshot.accounts.find((account) => account.provider === "openai-codex")?.label, "OpenAI Codex");
});
test("Claude redemption sends the pinned grant inside the target", async () => {
  const snapshot = await listResetCredits(deps);
  const claude = snapshot.accounts.find((account) => account.provider === "anthropic" && account.canRedeem);
  assert.ok(claude);
  const outcome = await redeemResetCredit({ accountId: claude.id, creditId: "grant-b", idempotencyKey: "123e4567-e89b-42d3-a456-426614174002" }, deps);
  assert.equal(outcome.outcome, "reset");
  const nativeRequests = (await readFile(nativeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(nativeRequests.at(-1).target, { credentialId: 7, provider: "anthropic", creditId: "grant-b" });
});
test("a Claude account with nothing spendable is refused before reaching the provider", async () => {
  const snapshot = await listResetCredits(deps);
  const blocked = snapshot.accounts.find((account) => account.provider === "anthropic" && !account.canRedeem);
  assert.ok(blocked);
  const before = (await readFile(nativeLog, "utf8")).trim().split("\n").length;
  const outcome = await redeemResetCredit({ accountId: blocked.id, creditId: "grant-c", idempotencyKey: "123e4567-e89b-42d3-a456-426614174003" }, deps);
  assert.equal(outcome.outcome, "no_credit"); assert.equal(outcome.code, "ineligible");
  assert.equal((await readFile(nativeLog, "utf8")).trim().split("\n").length, before);
});
test("OMP 18.3 namespaced AuthStorage API lists and redeems without exposing credential ids", async () => {
  const previousApi = process.env.CODY_RESET_STORAGE_API;
  process.env.CODY_RESET_STORAGE_API = "namespaced";
  try {
    const snapshot = await listResetCredits(deps);
    assert.equal(snapshot.available, true);
    assert.doesNotMatch(JSON.stringify(snapshot), /credentialId/);
    const account = snapshot.accounts.find((entry) => entry.provider === "openai-codex");
    assert.ok(account);
    const result = await redeemResetCredit({ accountId: account.id, creditId: "earlier", idempotencyKey: "123e4567-e89b-42d3-a456-426614174004" }, deps);
    assert.equal(result.outcome, "reset");
    const nativeRequests = (await readFile(nativeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(nativeRequests.at(-1).target, { credentialId: 41, provider: "openai-codex", creditId: "earlier" });
  } finally {
    if (previousApi === undefined) delete process.env.CODY_RESET_STORAGE_API;
    else process.env.CODY_RESET_STORAGE_API = previousApi;
  }
});
