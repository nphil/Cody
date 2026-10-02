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
  const api = authApi(await ai.AuthStorage.create(utils.getAgentDbPath())); await api.reload(); return api;
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
async function listCredentials(api, hasher) {
  const active = api.list();
  const disabled = await api.listDisabled();
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
  let storage;
  try { storage = await loadStorage(request.packageRoot, request.agentDir); } catch (error) { return fail(request.operation, "unsupported", error instanceof Error ? error.message : String(error)); }
  try {
    if (request.operation === "list") {
      let credentials; try { credentials = await listCredentials(storage, await loadPinHasher(request.packageRoot)); } catch (error) { return fail("list", "credential_list_failed", error instanceof Error ? error.message : String(error)); }
      return emit({ type: "list", ok: true, credentials });
    }
    if (request.operation === "unblock") {
      let cleared; try { cleared = unblockCredential(storage, request.credentialId); } catch (error) { return fail("unblock", "credential_unblock_failed", error instanceof Error ? error.message : String(error)); }
      return emit({ type: "unblock", ok: true, cleared });
    }
    if (request.operation === "remove") {
      let removed; try { removed = await storage.removeById(request.provider, request.credentialId); } catch (error) { return fail("remove", "credential_remove_failed", error instanceof Error ? error.message : String(error)); }
      // Recount rather than trust an in-memory tally: the authoritative
      // "anything left" answer is another read of the same store the removal
      // just went through.
      const providerRemoved = removed ? storage.list(request.provider).length === 0 : false;
      return emit({ type: "remove", ok: true, removed, providerRemoved });
    }
    // remove_provider: storage.remove() itself returns void, so "removed"
    // is answered from a before-check against the same active-row read
    // `remove`'s providerRemoved uses.
    let removed;
    try {
      removed = storage.list(request.provider).length > 0;
      await storage.removeProvider(request.provider);
    } catch (error) { return fail("remove_provider", "credential_remove_failed", error instanceof Error ? error.message : String(error)); }
    return emit({ type: "remove_provider", ok: true, removed });
  } finally { await storage.close(); }
}
main().catch((error) => fail("error", "unsupported", error instanceof Error ? error.message : String(error)));
