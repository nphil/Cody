import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { INCONCLUSIVE_MESSAGE, parseUsageResetResult, runUsageReset, usageResetArgs } from "../../bin/cody-omp-reset-cli.mjs";
import { ompTestPackageBin } from "../omp/omp-test-package.mjs";
import { findBun, packageRootOf } from "../omp/omp-test-store.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listResetCredits, probeUsageResetSupport, redeemResetCredit, usageHelpListsReset } = await jiti.import("./reset-credits.ts");
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
  "  async reload() {}",
  "  async listResetCredits(options) {",
  "    if (process.env.CODY_RESET_FIXTURE_FAIL && process.env.CODY_RESET_FIXTURE_FAIL === options?.provider) throw new Error(\"provider unreachable\");",
  "    if (options?.provider === \"anthropic\") return [",
  "      { provider: \"anthropic\", credentialId: 7, orgName: \"Acme\", availableCount: 2, redeemableCount: 1, eligible: true, nextCreditId: \"grant-b\", active: true, credits: [{ id: \"grant-a\", status: \"available\", usable: false, expiresAt: \"2027-01-01T00:00:00.000Z\" }, { id: \"grant-b\", title: \"Saved reset\", status: \"available\", usable: true, clears: [\"anthropic:5h\", \"anthropic:7d:fable\"], expiresAt: \"2027-03-01T00:00:00.000Z\" }] },",
  "      { provider: \"anthropic\", credentialId: 8, availableCount: 1, redeemableCount: 0, eligible: true, active: false, credits: [{ id: \"grant-c\", status: \"unavailable\", usable: false }] },",
  "    ];",
  "    return [{ credentialId: 41, availableCount: 1, active: false, credits: [{ id: \"later\", status: \"available\", expiresAt: \"2027-02-01T00:00:00.000Z\" }, { id: \"earlier\", status: \"available\", expiresAt: \"2027-01-01T00:00:00.000Z\" }, { id: \"spent\", status: \"redeemed\" }] }];",
  "  }",
  "  async redeemResetCredit(options) {",
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

// ── Saved-reset listing: clears and partial failures ───────────────────────
test("a Claude reset lists the limits it clears, so a Fable launch reset is recognisable", async () => {
  const claude = (await listResetCredits(deps)).accounts.find((account) => account.provider === "anthropic" && account.canRedeem);
  assert.deepEqual(claude.credits[0].clears, ["anthropic:5h", "anthropic:7d:fable"]);
  assert.equal(claude.credits[1].clears, undefined);
});
test("a provider that did not answer is named while the other provider's accounts stay", async () => {
  process.env.CODY_RESET_FIXTURE_FAIL = "anthropic";
  try {
    const snapshot = await listResetCredits(deps);
    assert.equal(snapshot.available, true);
    assert.deepEqual(snapshot.failedProviders, ["anthropic"]);
    assert.deepEqual([...new Set(snapshot.accounts.map((account) => account.provider))], ["openai-codex"]);
  } finally { delete process.env.CODY_RESET_FIXTURE_FAIL; }
  assert.equal((await listResetCredits(deps)).failedProviders, undefined);
});

// ── Spending through `omp usage reset` ─────────────────────────────────────
const OLD_HELP = "USAGE\n  $ omp usage [ACTION] [FLAGS]\n\nARGUMENTS\n  ACTION   Optional subcommand to execute (invalidate|clients|accounts)\n\nFLAGS\n  -j, --json  Output usage reports as JSON\n";
const NEW_HELP = "USAGE\n  $ omp usage [ACTION] [TARGET] [FLAGS]\n\nARGUMENTS\n  ACTION   Optional subcommand to execute (invalidate|clients|accounts|reset)\n  TARGET   Saved reset to spend with `reset`: <provider>/<credential id> as `omp usage reset` lists it\n\nEXAMPLES\n  # Spend one saved reset on a listed account\n    omp usage reset codex/3\n";
const fakeOmp = path.join(fixtureDir, "fake-omp");
const fakeLog = path.join(fixtureDir, "fake-omp.jsonl");
await writeFile(fakeOmp, [
  "#!/usr/bin/env node",
  "const { appendFileSync } = require(\"node:fs\");",
  "const args = process.argv.slice(2);",
  "appendFileSync(process.env.CODY_FAKE_OMP_LOG, JSON.stringify({ args, agentDir: process.env.PI_CODING_AGENT_DIR, noColor: process.env.NO_COLOR }) + \"\\n\");",
  "const run = JSON.parse(process.env.CODY_FAKE_OMP_RUN || \"{}\");",
  "if (run.hang) setTimeout(() => {}, 60000);",
  "else { process.stdout.write(run.stdout || \"\"); process.stderr.write(run.stderr || \"\"); process.exitCode = run.code ?? 0; }",
].join("\n"));
await chmod(fakeOmp, 0o755);
process.env.CODY_FAKE_OMP_LOG = fakeLog;
const cliDeps = { ...deps, ompBin: fakeOmp, supportsUsageReset: async () => true };
const KEY = "123e4567-e89b-42d3-a456-4266141740";
let keyCounter = 10;
const nextKey = () => KEY + String(keyCounter++);
async function lines(file) { try { return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }
async function accountFor(provider) { return (await listResetCredits(deps)).accounts.find((account) => account.provider === provider && account.canRedeem); }
async function spendViaCli(provider, creditId, run) {
  const account = await accountFor(provider);
  process.env.CODY_FAKE_OMP_RUN = JSON.stringify(run);
  const nativeBefore = (await lines(nativeLog)).length; const fakeBefore = (await lines(fakeLog)).length;
  try {
    const outcome = await redeemResetCredit({ accountId: account.id, creditId, idempotencyKey: nextKey() }, cliDeps);
    return { outcome, nativeCalls: (await lines(nativeLog)).length - nativeBefore, fakeCalls: (await lines(fakeLog)).slice(fakeBefore) };
  } finally { delete process.env.CODY_FAKE_OMP_RUN; }
}
test("the usage help of each omp generation says whether `usage reset` exists", () => {
  assert.equal(usageHelpListsReset(OLD_HELP), false);
  assert.equal(usageHelpListsReset(NEW_HELP), true);
  // The example text alone is not the action list.
  assert.equal(usageHelpListsReset(OLD_HELP + "  # omp usage reset codex/3\n"), false);
});
test("support is read from the engine's own help, cached per binary, and a failed probe is not cached", async () => {
  const oldBin = path.join(fixtureDir, "help-old"); const newBin = path.join(fixtureDir, "help-new"); const lateBin = path.join(fixtureDir, "help-late");
  await writeFile(oldBin, "#!/bin/sh\ncat <<'EOF'\n" + OLD_HELP + "EOF\n"); await chmod(oldBin, 0o755);
  await writeFile(newBin, "#!/bin/sh\ncat <<'EOF'\n" + NEW_HELP + "EOF\n"); await chmod(newBin, 0o755);
  assert.equal(await probeUsageResetSupport(oldBin, packageRoot), false);
  assert.equal(await probeUsageResetSupport(newBin, packageRoot), true);
  assert.equal(await probeUsageResetSupport(lateBin, packageRoot), false);
  await writeFile(lateBin, "#!/bin/sh\ncat <<'EOF'\n" + NEW_HELP + "EOF\n"); await chmod(lateBin, 0o755);
  assert.equal(await probeUsageResetSupport(lateBin, packageRoot), true);
});
test("the command is invoked with fixed argv naming the account only by credential id", async () => {
  assert.deepEqual(usageResetArgs("openai-codex", 41), ["usage", "reset", "openai-codex/41"]);
  const { outcome, nativeCalls, fakeCalls } = await spendViaCli("openai-codex", "earlier", { code: 0, stdout: "Reset applied for me@example.com (Codex) — your rate-limit window has been refreshed.\n" });
  assert.equal(outcome.outcome, "reset"); assert.equal(outcome.code, "reset");
  // Spent through omp's locked command; the unlocked direct call never ran.
  assert.equal(nativeCalls, 0);
  assert.deepEqual(fakeCalls.map((call) => call.args), [["usage", "reset", "openai-codex/41"]]);
  assert.equal(fakeCalls[0].agentDir, agentDir); assert.equal(fakeCalls[0].noColor, "1");
});
test("a Claude reset is spent through the command on its credential id", async () => {
  const { outcome, nativeCalls, fakeCalls } = await spendViaCli("anthropic", "grant-b", { code: 0, stdout: "Reset applied for Acme (Claude) — Claude's 5h session limit has been refreshed; weekly limits are unchanged.\n" });
  assert.equal(outcome.outcome, "reset"); assert.equal(nativeCalls, 0);
  assert.deepEqual(fakeCalls.map((call) => call.args), [["usage", "reset", "anthropic/7"]]);
});
test("lock contention maps to in-progress or already-redeemed, never to a spend", async () => {
  const started = (await spendViaCli("openai-codex", "earlier", { code: 1, stderr: "me@example.com (Codex): another omp process started spending a saved reset on this account 4s ago, so nothing was spent. Try again in a minute.\n" })).outcome;
  assert.equal(started.outcome, "error"); assert.equal(started.code, "reset_in_progress"); assert.equal(started.message, "Another reset for this account is still being applied.");
  const spent = (await spendViaCli("openai-codex", "earlier", { code: 1, stderr: "me@example.com (Codex): another omp process spent a saved reset on this account 12s ago, so this one was not spent. Check `omp usage` before spending another.\n" })).outcome;
  assert.equal(spent.outcome, "already_redeemed"); assert.equal(spent.code, "already_redeemed");
  const waited = (await spendViaCli("openai-codex", "earlier", { code: 1, stderr: "error: Failed to acquire lock for /x/agent.db.reset-ab12 after 300 attempts\n    at acquireFileLock\n" })).outcome;
  assert.equal(waited.outcome, "error"); assert.equal(waited.code, "reset_in_progress");
});
test("the command's refusals and failures keep Cody's outcome shapes", async () => {
  const cases = [
    [{ code: 1, stderr: "me@example.com (Codex): nothing to reset right now — your covered limits aren't constrained, so no credit was spent.\n" }, "nothing_to_reset", "nothing_to_reset"],
    [{ code: 1, stderr: "me@example.com (Codex): that reset was already redeemed.\n" }, "already_redeemed", "already_redeemed"],
    [{ code: 1, stderr: "me@example.com (Codex): no saved resets available to spend — Credit expired.\n" }, "no_credit", "no_credit", "Credit expired"],
    [{ code: 1, stderr: "me@example.com [Codex · openai-codex/41]: no saved resets usable right now (cooling down).\n" }, "no_credit", "ineligible", "cooling down"],
    [{ code: 1, stderr: "me@example.com (Codex): reset was not confirmed (ineligible) — Not eligible.\n" }, "no_credit", "ineligible", "Not eligible"],
    [{ code: 1, stderr: "me@example.com (Codex): couldn't confirm whether the reset applied — check /usage before trying again — HTTP 502.\n" }, "error", "reset_unconfirmed", "HTTP 502"],
    [{ code: 1, stderr: "me@example.com (Codex): the reset offer changed — nothing was spent; reopen /usage reset.\n" }, "error", "offer_changed"],
    [{ code: 1, stderr: "me@example.com (Codex): could not authenticate this account — try /login.\n" }, "error", "account_unavailable"],
    [{ code: 1, stderr: "me@example.com (Codex): couldn't load this account's saved resets (network/auth) — nothing was spent, try again.\n" }, "error", "credit_list_failed"],
    [{ code: 1, stderr: "me@example.com (Codex): reset was not confirmed (cooldown).\n" }, "error", "cooldown", "Saved resets for this account are cooling down."],
    [{ code: 1, stderr: "me@example.com (Codex): this login stores no account id or email to fence the spend against other omp processes, so nothing was spent. Run `omp` and use /login to sign in to it again.\n" }, "error", "account_unavailable"],
    [{ code: 1, stderr: "No stored account matches \"openai-codex/41\". List choices with `omp usage reset`.\n" }, "error", "no_account"],
  ];
  for (const [run, outcome, code, message] of cases) {
    const result = parseUsageResetResult({ exitCode: run.code, stderr: run.stderr });
    assert.equal(result.type, "redeem"); assert.equal(result.outcome, outcome, run.stderr); assert.equal(result.code, code, run.stderr);
    if (message) assert.match(result.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // No identity from the sentence leaks into the message Cody shows.
    assert.doesNotMatch(result.message ?? "", /example\.com/);
  }
});
test("an unrecognised failure, an exit 0 without a spend sentence, and a timeout are inconclusive, never a spend", async () => {
  const crash = (await spendViaCli("openai-codex", "earlier", { code: 1, stderr: "Error: auth broker request failed: boom\n" })).outcome;
  assert.equal(crash.outcome, "error"); assert.equal(crash.code, "inconclusive"); assert.equal(crash.message, INCONCLUSIVE_MESSAGE);
  const listing = parseUsageResetResult({ exitCode: 0, stdout: "Saved rate-limit resets:\n- me (Codex)\n" });
  assert.equal(listing.outcome, "error"); assert.equal(listing.code, "inconclusive");
  assert.equal(parseUsageResetResult({ exitCode: null, timedOut: true }).code, "inconclusive");
  assert.equal(parseUsageResetResult({ exitCode: 0, stdout: "Reset applied for me (Codex) — your rate-limit window has been refreshed.\n" }).outcome, "reset");
});
test("a hung command is killed and reported inconclusive", async () => {
  process.env.CODY_FAKE_OMP_RUN = JSON.stringify({ hang: true });
  try {
    const run = await runUsageReset({ ompBin: fakeOmp, provider: "openai-codex", credentialId: 41, agentDir, timeoutMs: 400 });
    assert.equal(run.started, true); assert.equal(run.frame.outcome, "error"); assert.equal(run.frame.code, "inconclusive");
  } finally { delete process.env.CODY_FAKE_OMP_RUN; }
});
test("only the grant the listing leads with can be spent through the command", async () => {
  const { outcome, nativeCalls, fakeCalls } = await spendViaCli("openai-codex", "later", { code: 0, stdout: "Reset applied for x (Codex) — ok.\n" });
  assert.equal(outcome.outcome, "error"); assert.equal(outcome.code, "offer_changed");
  assert.equal(nativeCalls, 0); assert.equal(fakeCalls.length, 0);
});
test("an engine without the command, or a binary that cannot launch, keeps the direct call", async () => {
  const account = await accountFor("openai-codex");
  const before = (await lines(nativeLog)).length; const fakeBefore = (await lines(fakeLog)).length;
  const withoutCommand = await redeemResetCredit({ accountId: account.id, creditId: "earlier", idempotencyKey: nextKey() }, { ...deps, ompBin: fakeOmp, supportsUsageReset: async () => false });
  assert.equal(withoutCommand.outcome, "reset");
  assert.equal((await lines(nativeLog)).length, before + 1); assert.equal((await lines(fakeLog)).length, fakeBefore);
  const unlaunchable = await redeemResetCredit({ accountId: account.id, creditId: "earlier", idempotencyKey: nextKey() }, { ...deps, ompBin: path.join(fixtureDir, "no-such-omp"), supportsUsageReset: async () => true });
  assert.equal(unlaunchable.outcome, "reset");
  assert.equal((await lines(nativeLog)).length, before + 2);
});

// ── The REAL engine, on an empty store (never spends anything) ─────────────
const realBin = ompTestPackageBin(); const realRoot = realBin ? packageRootOf(realBin) : null; const bun = findBun();
const realSkip = (!realRoot && "no omp package available") || (!bun && "bun is not installed");
const realVersion = realRoot ? String(JSON.parse(await readFile(path.join(realRoot, "package.json"), "utf8")).version) : "";
const [major = 0, minor = 0] = realVersion.split(".").map((part) => Number.parseInt(part, 10));
const realHasCommand = major > 18 || (major === 18 && minor >= 9); // omp 18.9.0 added `omp usage reset`.
let realAgentDir;
test.before(async () => { if (!realSkip) realAgentDir = await mkdtemp(path.join(os.tmpdir(), "cody-reset-real-")); });
test.after(async () => { if (realAgentDir) await rm(realAgentDir, { recursive: true, force: true }); });
const realDeps = () => ({ bunBin: bun, packageRoot: () => realRoot, agentDir: () => realAgentDir, ompBin: realBin });
test("the installed omp's help tells Cody whether to spend through the command", { skip: realSkip }, async () => {
  assert.equal(await probeUsageResetSupport(realBin, realRoot), realHasCommand, "omp " + realVersion);
});
test("on the installed omp an empty store lists nothing and a spend names no account", { skip: realSkip }, async () => {
  const snapshot = await listResetCredits(realDeps());
  assert.equal(snapshot.available, true, snapshot.reason); assert.deepEqual(snapshot.accounts, []);
  const outcome = await redeemResetCredit({ accountId: "missing", creditId: "none", idempotencyKey: nextKey() }, realDeps());
  assert.equal(outcome.outcome, "error"); assert.equal(outcome.code, "no_account");
});
test("the installed omp's own command answers an unknown account with Cody's no-account outcome", { skip: realSkip || (!realHasCommand && "this omp has no `usage reset`") }, async () => {
  for (const provider of ["openai-codex", "anthropic"]) {
    const run = await runUsageReset({ ompBin: realBin, provider, credentialId: 3, agentDir: realAgentDir });
    assert.equal(run.started, true);
    assert.equal(run.frame.outcome, "error"); assert.equal(run.frame.code, "no_account"); assert.equal(run.frame.message, "The selected reset-credit account no longer exists.");
  }
});
