#!/usr/bin/env bun
/** Isolated Bun bridge to OMP's installed AuthStorage credential list/removal API. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { authApi } from "./cody-omp-auth-api.mjs";
console.log = (...args) => console.error(...args);
console.info = console.log;
console.debug = console.log;
function emit(value) { process.stdout.write(JSON.stringify(value)); }
function fail(type, code, message) { emit({ type, ok: false, code, message }); process.exitCode = 1; }
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function safeString(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
/** Epoch-ms (native block timestamps) to ISO, or null. Distinct from the
 * ISO-string dates cody-omp-reset-credits.mjs normalizes: blocks are always
 * numeric epoch ms on the wire. */
function isoFromEpochMs(value) { return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null; }

async function loadStorage(packageRoot, agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const require = createRequire(join(packageRoot, "package.json"));
  let aiPath; let utilsPath;
  try { aiPath = require.resolve("@oh-my-pi/pi-ai/auth-storage.js"); utilsPath = require.resolve("@oh-my-pi/pi-utils/dirs.js"); } catch { throw new Error("OMP's installed credential modules are unavailable."); }
  const ai = await import(pathToFileURL(aiPath).href); const utils = await import(pathToFileURL(utilsPath).href);
  if (typeof ai.AuthStorage?.create !== "function" || typeof utils.getAgentDbPath !== "function") throw new Error("Installed OMP does not expose AuthStorage credential support.");
  const dbPath = utils.getAgentDbPath();
  const api = authApi(await ai.AuthStorage.create(dbPath)); await api.reload(); return { api, dbPath };
}

/**
 * omp's own remove calls (`removeById`, `remove`) only SOFT-delete: the row
 * stays in `auth_credentials` with `disabled_cause` set, still holding the API
 * key or refresh token, and they can only ever act on ACTIVE rows. Cody used
 * to list those tombstones as removable accounts, so "Remove" on one answered
 * "no account matching that id" forever (measured: an OpenRouter key deleted
 * weeks earlier, listed as a Disabled account that could not be removed).
 *
 * To Cody "remove" means gone. omp exposes no hard delete, so after the
 * soft delete this deletes the tombstone row itself — the ONE raw SQL write in
 * the Bun helpers, and it can only ever touch a row omp already disabled
 * (`disabled_cause IS NOT NULL`), never a credential that can still serve.
 */
const USER_REMOVED = /^deleted by user/i;
/** Tombstones that are lifecycle noise, not lost capacity: omp's own `omp usage`
 * hides the same two (src/cli/usage-cli.ts isActionableDisable). */
const LIFECYCLE_NOISE = /^(deleted by user|replaced by)/i;

async function openDatabase(file) {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(file);
    return { exec: (sql) => db.exec(sql), all: (sql, ...params) => db.query(sql).all(...params), run: (sql, ...params) => db.query(sql).run(...params), close: () => db.close() };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  return { exec: (sql) => db.exec(sql), all: (sql, ...params) => db.prepare(sql).all(...params), run: (sql, ...params) => db.prepare(sql).run(...params), close: () => db.close() };
}

/** Hard-delete the named tombstones (`[{provider, id}]`) and their block and
 * refresh-lease rows. Returns the ids actually deleted. A store with no SQLite
 * file behind it (a test double) has nothing to purge. */
async function purgeTombstones(api, dbPath, targets) {
  if (targets.length === 0 || !existsSync(dbPath)) return [];
  for (const { id } of targets) {
    // Through omp's own API (it also bumps its generation for snapshot waiters);
    // an orphaned block row is harmless, the credential row below is what matters.
    try { api.deleteBlocks(id, api.listBlocks([id])); } catch { /* best effort */ }
  }
  const db = await openDatabase(dbPath);
  const purged = [];
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const { provider, id } of targets) {
        if (db.all("SELECT id FROM auth_credentials WHERE id = ? AND provider = ? AND disabled_cause IS NOT NULL", id, provider).length === 0) continue;
        try { db.run("DELETE FROM auth_credential_refresh_leases WHERE credential_id = ?", id); } catch { /* older omp: no lease table */ }
        db.run("DELETE FROM auth_credentials WHERE id = ? AND disabled_cause IS NOT NULL", id);
        purged.push(id);
      }
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  } finally { db.close(); }
  return purged;
}

/**
 * omp records the account that served each session as a `credential_pin`
 * entry in the session file: a digest of the account's billing scope
 * (src/session/credential-pin.ts). Hashing each stored credential the same
 * way is what lets Cody name the account a conversation is ACTUALLY on,
 * instead of guessing from quota headroom. omp's own function is used when
 * the installed package ships it; the fallback is the same persisted formula
 * ("changing it orphans every recorded pin", so it is a stable contract).
 */
async function loadPinHasher(packageRoot) {
  const source = join(packageRoot, "src", "session", "credential-pin.ts");
  if (existsSync(source)) {
    try {
      const pinModule = await import(pathToFileURL(source).href);
      if (typeof pinModule.credentialPinHash === "function") return pinModule.credentialPinHash;
    } catch { /* fall through to the documented formula */ }
  }
  return (provider, identity) => {
    if (!identity.accountId && !identity.email) return undefined;
    return createHash("sha256").update([provider, identity.accountId ?? "", identity.email ?? "", identity.orgId ?? "", identity.projectId ?? ""].join("\0")).digest("hex");
  };
}
function pinHashOf(hasher, provider, credential) {
  if (!credential || credential.type !== "oauth") return null;
  const identity = {
    accountId: safeString(credential.accountId) ?? undefined,
    email: safeString(credential.email) ?? undefined,
    orgId: safeString(credential.orgId) ?? undefined,
    projectId: safeString(credential.projectId) ?? undefined,
  };
  try { const hash = hasher(provider, identity); return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : null; } catch { return null; }
}

/** email ?? orgName ?? accountId — the display identity for one credential.
 * NEVER reads token/refresh/key material; api_key credentials (no such
 * fields) always resolve to null here. */
function identityOfCredential(credential) {
  if (!credential || credential.type !== "oauth") return null;
  return safeString(credential.email) ?? safeString(credential.orgName) ?? safeString(credential.accountId) ?? null;
}
function identityOfDisabledSummary(row) {
  return safeString(row.email) ?? safeString(row.orgName) ?? safeString(row.accountId) ?? null;
}

/** Latest UNEXPIRED block across every scope for one credential id, or null. */
function blockedUntilFor(credentialId, blocks) {
  const now = Date.now();
  let latest = null;
  for (const block of blocks) {
    if (block.credentialId !== credentialId) continue;
    if (typeof block.blockedUntilMs !== "number" || block.blockedUntilMs <= now) continue;
    if (latest === null || block.blockedUntilMs > latest) latest = block.blockedUntilMs;
  }
  return isoFromEpochMs(latest);
}

/** Every stored credential row Cody should show: active and auto-disabled,
 * allow-listing exactly the fields Cody's UI needs — never the credential
 * object itself, so a token/refresh/api key can never leak through a spread.
 *
 * Tombstones the user (or a re-login) caused are NOT shown: a "deleted by user"
 * row is an account that is gone, and listing it as a removable "Disabled"
 * account is what made Remove answer "no account matching that id". The
 * "deleted by user" ones still hold the old key or refresh token, so they are
 * purged here too (best effort; a locked store leaves them for the next read). */
async function listCredentials(api, hasher, dbPath) {
  const active = api.list();
  const allDisabled = await api.listDisabled();
  const causeOf = (row) => safeString(row.cause) ?? "disabled";
  const disabled = allDisabled.filter((row) => !LIFECYCLE_NOISE.test(causeOf(row)));
  const deletedByUser = allDisabled.filter((row) => USER_REMOVED.test(causeOf(row)));
  if (deletedByUser.length > 0) {
    try { await purgeTombstones(api, dbPath, deletedByUser.map((row) => ({ provider: row.provider, id: row.id }))); } catch { /* the next read retries */ }
  }
  const blocks = api.listBlocks([...active.map((row) => row.id), ...disabled.map((row) => row.id)]);
  const activeRows = active.map((row) => ({
    id: row.id,
    provider: row.provider,
    type: row.credential.type,
    identity: identityOfCredential(row.credential),
    // AuthStorage's OAuth/api_key credential never carries a plan tier; the
    // caller (lib/omp/provider-login.ts) fills this from the usage snapshot.
    planType: null,
    disabledCause: null,
    blockedUntil: blockedUntilFor(row.id, blocks),
    pinHash: pinHashOf(hasher, row.provider, row.credential),
  }));
  const disabledRows = disabled.map((row) => ({
    id: row.id,
    provider: row.provider,
    type: row.type,
    identity: identityOfDisabledSummary(row),
    planType: null,
    disabledCause: causeOf(row),
    blockedUntil: blockedUntilFor(row.id, blocks),
    pinHash: null,
  }));
  return [...activeRows, ...disabledRows].sort((a, b) => a.id - b.id);
}

/** Drop every rate-limit block row for one credential.
 *
 * A block is omp's own record that a provider refused this credential until
 * a deadline; it is a SEPARATE store from the usage API and can outlive the
 * condition that caused it (measured: an Anthropic account reporting 4%
 * used, blocked for five hours after one 429 — every turn fell back to
 * another provider while that quota sat unused). Clearing it is safe: if
 * the provider really is still limiting, the next request writes it again.
 */
function unblockCredential(api, credentialId) {
  const blocks = api.listBlocks([credentialId]);
  const active = blocks.filter((block) => typeof block.blockedUntilMs === "number" && block.blockedUntilMs > Date.now());
  api.deleteBlocks(credentialId, blocks);
  return active.map((block) => ({ scope: block.blockScope || null, until: isoFromEpochMs(block.blockedUntilMs) }));
}

async function main() {
  let request; try { request = asRecord(JSON.parse(process.argv[2] ?? "")); } catch { return fail("error", "invalid_request", "Malformed credential request."); }
  const validOp = request && (request.operation === "list" || request.operation === "remove" || request.operation === "remove_provider" || request.operation === "unblock");
  if (!validOp || typeof request.packageRoot !== "string" || typeof request.agentDir !== "string") return fail("error", "invalid_request", "Malformed credential request.");
  if (request.operation !== "list" && request.operation !== "unblock" && typeof request.provider !== "string") return fail(request.operation, "invalid_request", "A provider id is required.");
  if ((request.operation === "remove" || request.operation === "unblock") && !(typeof request.credentialId === "number" && Number.isSafeInteger(request.credentialId))) return fail(request.operation, "invalid_request", "A credential id is required.");
  let loaded;
  try { loaded = await loadStorage(request.packageRoot, request.agentDir); } catch (error) { return fail(request.operation, "unsupported", error instanceof Error ? error.message : String(error)); }
  const { api: storage, dbPath } = loaded;
  const messageOf = (error) => error instanceof Error ? error.message : String(error);
  try {
    if (request.operation === "list") {
      let credentials; try { credentials = await listCredentials(storage, await loadPinHasher(request.packageRoot), dbPath); } catch (error) { return fail("list", "credential_list_failed", messageOf(error)); }
      return emit({ type: "list", ok: true, credentials });
    }
    if (request.operation === "unblock") {
      let cleared; try { cleared = unblockCredential(storage, request.credentialId); } catch (error) { return fail("unblock", "credential_unblock_failed", messageOf(error)); }
      return emit({ type: "unblock", ok: true, cleared });
    }
    if (request.operation === "remove") {
      const { provider, credentialId } = request;
      // omp's removeById only sees ACTIVE credentials; a tombstone (what the
      // list can still show: an auto-disabled account) answers false to it.
      const wasActive = storage.list(provider).some((row) => row.id === credentialId);
      let removed = false;
      if (wasActive) {
        try { removed = await storage.removeById(provider, credentialId); } catch (error) { return fail("remove", "credential_remove_failed", messageOf(error)); }
        if (!removed) return fail("remove", "credential_remove_failed", "omp would not remove that account. Refresh the list and try again.");
      }
      // Whether it was live a moment ago or a tombstone, it must not stay on
      // disk: the soft delete keeps the key or refresh token in the row.
      try {
        if ((await purgeTombstones(storage, dbPath, [{ provider, id: credentialId }])).length > 0) removed = true;
      } catch (error) {
        // A soft-deleted account can no longer serve, so that outcome stands;
        // only a tombstone-only removal has nothing else to show for itself.
        if (!wasActive) return fail("remove", "credential_remove_failed", `Cody could not delete the stored account (${messageOf(error)}). Try again in a moment.`);
      }
      // Recount rather than trust an in-memory tally: the authoritative
      // "anything left" answer is another read of the same store the removal
      // just went through.
      const providerRemoved = removed ? storage.list(provider).length === 0 : false;
      return emit({ type: "remove", ok: true, removed, providerRemoved });
    }
    // remove_provider: storage.remove() itself returns void, so "removed" is
    // answered from a before-check — the active rows plus the tombstones the
    // list would still show (an auto-disabled account is something to remove;
    // a "deleted by user" leftover is not, though it is purged all the same).
    const provider = request.provider;
    let activeBefore; let shownTombstonesBefore;
    try {
      activeBefore = storage.list(provider).length;
      shownTombstonesBefore = (await storage.listDisabled()).filter((row) => row.provider === provider && !LIFECYCLE_NOISE.test(safeString(row.cause) ?? "disabled")).length;
      await storage.removeProvider(provider);
    } catch (error) { return fail("remove_provider", "credential_remove_failed", messageOf(error)); }
    try {
      // The soft delete just tombstoned every active row too: purge them all.
      const rows = (await storage.listDisabled()).filter((row) => row.provider === provider);
      await purgeTombstones(storage, dbPath, rows.map((row) => ({ provider, id: row.id })));
    } catch (error) {
      if (activeBefore === 0) return fail("remove_provider", "credential_remove_failed", `Cody could not delete the stored credentials (${messageOf(error)}). Try again in a moment.`);
    }
    return emit({ type: "remove_provider", ok: true, removed: activeBefore + shownTombstonesBefore > 0, count: activeBefore });
  } finally { await storage.close(); }
}
main().catch((error) => fail("error", "unsupported", error instanceof Error ? error.message : String(error)));
