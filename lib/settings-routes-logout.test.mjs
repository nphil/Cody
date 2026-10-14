import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ompTestPackageBin } from "./omp/omp-test-package.mjs";
import { apiKeyCredential, findBun, oauthCredential, packageRootOf, REFRESH_FAILED, seedOmpStore, storedRows } from "./omp/omp-test-store.mjs";

/**
 * `POST /api/auth/logout/<provider>` against a REAL omp credential store — the
 * route, omp's adapter, the Bun helper and omp's own AuthStorage, with only
 * fake credentials in a throwaway agent dir. The store mirrors the owner's:
 * an OpenRouter key he deleted weeks ago (omp keeps it as a "deleted by user"
 * tombstone), a Claude account omp disabled, a live Claude account, and a
 * Codex account that must survive everything.
 *
 * What the owner saw: Remove on OpenRouter answered "Cody found no
 * "openrouter" account matching that id", every time, while OpenRouter kept
 * drawing a row in Usage. The route's contract now: the account is really
 * gone (from agent.db, not just hidden), the answer says what happened, and
 * everything Cody remembered about it is forgotten with it.
 */
const ompBin = ompTestPackageBin(); // before the environment below points at the throwaway dir
const packageRoot = ompBin ? packageRootOf(ompBin) : null;
const bun = findBun();
const skip = (!packageRoot && "no omp package available") || (!bun && "bun is not installed");

const seeded = skip
  ? null
  : await seedOmpStore({
      bun,
      packageRoot,
      steps: [
        { op: "upsert", provider: "openai-codex", as: "codex", credential: oauthCredential("codex@example.test") },
        { op: "upsert", provider: "anthropic", as: "expired", credential: oauthCredential("expired@example.test") },
        { op: "disable", ref: "expired", cause: REFRESH_FAILED },
        { op: "upsert", provider: "anthropic", as: "live", credential: oauthCredential("live@example.test") },
        { op: "upsert", provider: "openrouter", as: "orKey", credential: apiKeyCredential("sk-or-v1-FAKEFAKEFAKE") },
        { op: "removeById", provider: "openrouter", ref: "orKey" },
      ],
    });
const agentDir = seeded?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cody-logout-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cody-logout-accounts-"));
if (ompBin) process.env.CODY_OMP_BIN = ompBin;
// The bridge spawns `<package dir>/bin/cody-omp-credentials.mjs`: under a deployed Cody that
// variable names the INSTALLED copy, which is not the code under test.
process.env.CODY_PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
delete process.env.OPENROUTER_API_KEY;
fs.writeFileSync(path.join(agentDir, "cody-engine.json"), JSON.stringify({ version: 1, activeEngine: "omp", onboarded: true, updatedAt: new Date().toISOString() }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/auth/logout/[provider]/route.ts");
const { createUser } = await jiti.import("./auth/users.ts");
const { hashPassword } = await jiti.import("./auth/password.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./auth/session.ts");
const { getUsageSnapshot } = await jiti.import("./usage/cache.ts");
const { readRouteMemory, recordBlackouts } = await jiti.import("./routing/route-memory.ts");

const admin = createUser({ username: "logoutadmin", fullName: "Logout Admin", passwordHash: await hashPassword("logout-password-1"), role: "admin" });
const member = createUser({ username: "logoutmember", fullName: "Logout Member", passwordHash: await hashPassword("logout-password-2"), role: "member" });
const ADMIN = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(admin)}` };
const MEMBER = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(member)}` };

test.after(() => {
  if (seeded) fs.rmSync(seeded.dir, { recursive: true, force: true });
});

const logout = async (provider, body, headers = ADMIN) => {
  const response = await route.POST(
    new Request(`http://cody.test/api/auth/logout/${provider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ provider }) },
  );
  return { status: response.status, body: await response.json() };
};
const rowIds = () => storedRows(agentDir).map((row) => row.id);

test("removing the OpenRouter key omp only soft-deleted succeeds, and everything remembered about it goes", { skip }, async (t) => {
  const { ids } = seeded;
  recordBlackouts([{ provider: "openrouter", accountId: null, kind: "credits", since: "2026-09-14T06:39:58.150Z", until: null, reason: "out of credits ($0.00 left)" }]);
  let usageLoads = 0;
  const loadUsage = async () => { usageLoads += 1; return { available: true, accounts: [], fetchedAt: new Date().toISOString(), stale: false }; };
  await getUsageSnapshot({ load: loadUsage });
  globalThis.__codyProviderLoginsCache = new Map([["omp", { providers: [{ id: "openrouter", name: "OpenRouter", authenticated: true, kind: "oauth", canLogout: true }] }]]);
  // Two live engine children: one idle, one mid-reply. A live child read its credentials (and the
  // key's environment variable) at spawn, so the idle one must restart; the running one is never
  // cut off mid-reply.
  const destroyed = [];
  const fake = (name, running) => ({ isRunning: () => running, destroyAndWait: async () => { destroyed.push(name); }, destroy() {} });
  globalThis.__ompSessions = new Map([["idle", fake("idle", false)], ["busy", fake("busy", true)]]);
  t.after(() => { delete globalThis.__ompSessions; });
  assert.ok(rowIds().includes(ids.orKey), "precondition: the removed key is still in agent.db");

  const { status, body } = await logout("openrouter", { accountId: String(ids.orKey) });

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, "this used to be 404 'Cody found no \"openrouter\" account matching that id'");
  assert.equal(body.providerRemoved, true);
  assert.deepEqual([body.restarted, body.active], [1, 1], "the caller is told: one idle chat restarted, one mid-reply left alone");
  assert.deepEqual(destroyed, ["idle"], "the next turn of an idle chat cannot use the removed account; a running reply is not cut off");
  assert.equal(rowIds().includes(ids.orKey), false, "gone from the store itself, key and all");
  assert.deepEqual(readRouteMemory().blackouts, [], "the remembered 'out of credits' no longer keeps OpenRouter in Usage");
  assert.equal(globalThis.__codyProviderLoginsCache.has("omp"), false, "the sign-in roster is re-read, not served from the 15 s peek cache");
  await getUsageSnapshot({ load: loadUsage });
  assert.equal(usageLoads, 2, "the usage snapshot is read again, not served stale");
});

test("an account omp disabled is removable, and removing it leaves the live sibling and every other provider alone", { skip }, async () => {
  const { ids } = seeded;
  const { status, body } = await logout("anthropic", { accountId: String(ids.expired) });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.providerRemoved, false, "the live Claude account is still signed in");
  assert.deepEqual(rowIds(), [ids.codex, ids.live]);
});

test("a second click on a removed account is an honest 'already gone', not a scary failure", { skip }, async () => {
  const { ids } = seeded;
  const { status, body } = await logout("anthropic", { accountId: String(ids.expired) });
  assert.equal(status, 404);
  assert.equal(body.code, "not_found");
  assert.match(body.error, /already gone/i);
  assert.deepEqual(rowIds(), [ids.codex, ids.live], "nothing else moved");
});

test("a malformed account id is refused in plain words", { skip }, async () => {
  const { status, body } = await logout("anthropic", { accountId: "not-a-number" });
  assert.equal(status, 400);
  assert.equal(body.code, "logout_failed");
  assert.match(body.error, /not a valid account id/);
});

test("signing out of a provider removes its accounts for good, says how many, and a repeat says there was nothing", { skip }, async () => {
  const { ids } = seeded;
  const first = await logout("anthropic");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.removed, true);
  assert.equal(first.body.count, 1);
  assert.deepEqual(rowIds(), [ids.codex], "only the bystander is left");

  const again = await logout("anthropic");
  assert.equal(again.status, 200);
  assert.equal(again.body.removed, false, "never a silent no-op: the caller can tell nothing was stored");
});

test("only an administrator can remove a credential", { skip }, async () => {
  const { status, body } = await logout("openai-codex", undefined, MEMBER);
  assert.equal(status, 403);
  assert.equal(body.code, "admin_required");
  assert.ok(rowIds().includes(seeded.ids.codex));
});
