#!/usr/bin/env bun
/** Isolated Bun bridge to OMP's installed AuthStorage credential API. Listing
 * and block clearing use AuthStorage; individual permanent removal is a
 * guarded local-SQLite operation because OMP's public remove API is a
 * soft-delete that creates the disabled tombstone Cody is trying to avoid. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
console.log = (...args) => console.error(...args);
console.info = console.log;
console.debug = console.log;
function emit(value) { process.stdout.write(JSON.stringify(value)); }
function fail(type, code, message) { emit({ type, ok: false, code, message }); process.exitCode = 1; }
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function safeString(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
async function activeCredentialsOf(storage, provider) {
  if (typeof storage.credentials?.list === "function") return storage.credentials.list(provider);
  if (typeof storage.listStoredCredentials === "function") return storage.listStoredCredentials(provider);
  throw new Error("Installed OMP does not expose credential listing support.");
}
async function disabledCredentialsOf(storage) {
  if (typeof storage.credentials?.listDisabled === "function") return storage.credentials.listDisabled();
  if (typeof storage.listDisabledCredentials === "function") return storage.listDisabledCredentials();
  return [];
}
async function credentialBlocksOf(storage, credentialIds) {
  if (typeof storage.blocks?.list === "function") return storage.blocks.list(credentialIds);
  if (typeof storage.listCredentialBlocks === "function") return storage.listCredentialBlocks(credentialIds);
  return [];
}
async function clearCredentialBlocks(storage, credentialId, blocks) {
  if (typeof storage.blocks?.deleteAll === "function") return storage.blocks.deleteAll(credentialId);
  if (typeof storage.blocks?.delete === "function") {
    for (const block of blocks) await storage.blocks.delete(credentialId, block.providerKey, block.blockScope ?? "");
    return;
  }
  if (typeof storage.deleteCredentialBlocks === "function") return storage.deleteCredentialBlocks(credentialId);
  if (typeof storage.deleteCredentialBlock === "function") {
    for (const block of blocks) await storage.deleteCredentialBlock(credentialId, block.providerKey, block.blockScope ?? "");
    return;
  }
  throw new Error("Installed OMP does not expose credential block removal.");
}
async function reloadCredentialsOf(storage) {
  if (typeof storage.credentials?.reload === "function") return storage.credentials.reload();
  if (typeof storage.reload === "function") return storage.reload();
  throw new Error("Installed OMP does not expose credential reload support.");
}
async function removeProviderCredentials(storage, provider) {
  if (typeof storage.credentials?.remove === "function") return storage.credentials.remove(provider);
  if (typeof storage.remove === "function") return storage.remove(provider);
  throw new Error("Installed OMP does not expose provider credential removal.");
}
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
  const storage = await ai.AuthStorage.create(dbPath); await reloadCredentialsOf(storage); return { storage, dbPath };
}

/** Open only an existing local SQLite file. A missing/non-absolute path is the
 * broker-backed/unknown-store case and must fail closed rather than falling
 * back to AuthStorage.removeCredential(), which is not permanent. */
async function openLocalDatabase(dbPath) {
  if (typeof dbPath !== "string" || !isAbsolute(dbPath) || !existsSync(dbPath)) {
    throw new Error("OMP's local credential database is unavailable; permanent removal is unsupported for broker-backed stores.");
  }
  try {
    const sqlite = await import("bun:sqlite");
    return new sqlite.Database(dbPath);
  } catch {
    // The Node test harness has no Bun runtime. Keeping this fallback here
    // also makes the guard independently testable without touching OMP's
    // credential implementation.
    try {
      const sqlite = await import("node:sqlite");
      return new sqlite.DatabaseSync(dbPath);
    } catch {
      throw new Error("The installed runtime cannot open OMP's local SQLite credential database.");
    }
  }
}

function closeStatement(statement) { statement?.finalize?.(); }
function allRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try { return statement.all(...params); } finally { closeStatement(statement); }
}
function oneRow(db, sql, params = []) {
  const statement = db.prepare(sql);
  try { return statement.get(...params); } finally { closeStatement(statement); }
}
function runStatement(db, sql, params = []) {
  const statement = db.prepare(sql);
  try { return statement.run(...params); } finally { closeStatement(statement); }
}
function execSql(db, sql) { db.exec(sql); }

function tableExists(db, tableName) {
  return Boolean(oneRow(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]));
}

function assertCredentialSchema(db) {
  const columns = new Set(allRows(db, "PRAGMA table_info(auth_credentials)").map((row) => row?.name));
  const required = ["id", "provider", "credential_type", "data", "disabled_cause"];
  if (!required.every((column) => columns.has(column))) {
    throw new Error("OMP's auth_credentials schema is not recognized; permanent removal was not attempted.");
  }
  for (const table of ["auth_credential_blocks", "auth_credential_refresh_leases"]) {
    if (!tableExists(db, table)) continue;
    const dependentColumns = new Set(allRows(db, `PRAGMA table_info(${table})`).map((row) => row?.name));
    if (!dependentColumns.has("credential_id")) {
      throw new Error(`OMP's ${table} schema is not recognized; permanent removal was not attempted.`);
    }
  }
}

function deleteDependentRows(db, credentialId) {
  for (const table of ["auth_credential_blocks", "auth_credential_refresh_leases"]) {
    if (tableExists(db, table)) runStatement(db, `DELETE FROM ${table} WHERE credential_id = ?`, [credentialId]);
  }
}

async function reloadStorage(storage) {
  try { await reloadCredentialsOf(storage); } catch {
    // The committed SQLite deletion is authoritative. A later Cody request
    // creates a fresh AuthStorage; a stale in-memory view must not turn a
    // successful deletion into an error after the transaction committed.
  }
}

async function permanentlyRemoveCredential(storage, dbPath, provider, credentialId) {
  const db = await openLocalDatabase(dbPath);
  try {
    assertCredentialSchema(db);
    const row = oneRow(db, "SELECT identity_key FROM auth_credentials WHERE id = ? AND provider = ?", [credentialId, provider]);
    if (!row) return { removed: false, providerRemoved: false };
    const identity = safeString(row.identity_key);
    execSql(db, "BEGIN IMMEDIATE");
    try {
      deleteDependentRows(db, credentialId);
      // SQLite triggers (including OMP's auth-change revision trigger) can
      // make Bun report more than one changed row for one credential delete.
      // Verify the row identity returned by the DELETE instead of treating
      // trigger side effects as a concurrent credential change.
      const deleted = oneRow(db, "DELETE FROM auth_credentials WHERE id = ? AND provider = ? RETURNING id", [credentialId, provider]);
      if (Number(deleted?.id) !== credentialId) throw new Error("The credential changed before it could be permanently removed.");
      execSql(db, "COMMIT");
    } catch (error) {
      try { execSql(db, "ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
    await reloadStorage(storage);
    const remaining = oneRow(db, "SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ?", [provider]);
    return {
      removed: true,
      providerRemoved: Number(remaining?.count ?? 0) === 0,
      ...(identity ? { identity } : {}),
    };
  } finally {
    try { db.close?.(); } catch { /* the transaction already decided the result */ }
  }
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

/** Every stored credential row, active and disabled, allow-listing exactly
 * the fields Cody's UI needs — never the credential object itself, so a
 * token/refresh/api key can never leak through a spread. */
async function listCredentials(storage, hasher) {
  const active = await activeCredentialsOf(storage);
  const disabled = await disabledCredentialsOf(storage);
  const blocks = await credentialBlocksOf(storage, [...active.map((row) => row.id), ...disabled.map((row) => row.id)]);
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
    disabledCause: safeString(row.cause) ?? "disabled",
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
async function unblockCredential(storage, credentialId) {
  const blocks = await credentialBlocksOf(storage, [credentialId]);
  const active = blocks.filter((block) => typeof block.blockedUntilMs === "number" && block.blockedUntilMs > Date.now());
  await clearCredentialBlocks(storage, credentialId, blocks);
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
  const { storage, dbPath } = loaded;
  try {
    if (request.operation === "list") {
      let credentials; try { credentials = await listCredentials(storage, await loadPinHasher(request.packageRoot)); } catch (error) { return fail("list", "credential_list_failed", error instanceof Error ? error.message : String(error)); }
      return emit({ type: "list", ok: true, credentials });
    }
    if (request.operation === "unblock") {
      let cleared; try { cleared = await unblockCredential(storage, request.credentialId); } catch (error) { return fail("unblock", "credential_unblock_failed", error instanceof Error ? error.message : String(error)); }
      return emit({ type: "unblock", ok: true, cleared });
    }
    if (request.operation === "remove") {
      let outcome; try { outcome = await permanentlyRemoveCredential(storage, dbPath, request.provider, request.credentialId); } catch (error) { return fail("remove", "credential_permanent_remove_failed", error instanceof Error ? error.message : String(error)); }
      return emit({ type: "remove", ok: true, ...outcome });
    }
    // remove_provider: OMP's provider removal API returns void, so "removed"
    // is answered from a before-check against the same active-row read
    // `remove`'s providerRemoved uses.
    let removed;
    try {
      removed = (await activeCredentialsOf(storage, request.provider)).length > 0;
      await removeProviderCredentials(storage, request.provider);
    } catch (error) { return fail("remove_provider", "credential_remove_failed", error instanceof Error ? error.message : String(error)); }
    return emit({ type: "remove_provider", ok: true, removed });
  } finally { await storage.close?.(); }
}
main().catch((error) => fail("error", "unsupported", error instanceof Error ? error.message : String(error)));
