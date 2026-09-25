#!/usr/bin/env bun
/** Isolated Bun bridge to OMP's installed AuthStorage reset-credit API. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
console.log = (...args) => console.error(...args);
console.info = console.log;
console.debug = console.log;
function emit(value) { process.stdout.write(JSON.stringify(value)); }
function fail(type, code, message) { emit({ type, ok: false, code, message }); process.exitCode = 1; }
function opaqueId(value) { return createHash("sha256").update(value).digest("base64url"); }
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function date(value) { const time = typeof value === "string" || typeof value === "number" ? Date.parse(String(value)) : NaN; return Number.isFinite(time) ? new Date(time).toISOString() : null; }
// OMP 18.3 moved AuthStorage operations under namespaces. Prefer the public
// namespaced methods when available, while keeping compatibility with older
// builds that exposed the same methods directly on AuthStorage.
function storageMethod(storage, namespaceName, methodName, legacyName) {
  const namespace = asRecord(storage?.[namespaceName]);
  if (typeof namespace?.[methodName] === "function") return namespace[methodName].bind(namespace);
  if (typeof storage?.[legacyName] === "function") return storage[legacyName].bind(storage);
  return null;
}
async function callStorageMethod(storage, namespaceName, methodName, legacyName, options) {
  const method = storageMethod(storage, namespaceName, methodName, legacyName);
  if (!method) throw new Error("Installed OMP does not expose reset-credit storage support.");
  return method(options);
}
// OMP lists saved resets per provider: Codex since 17.x, Claude (Cedar and
// Juniper grants) since 18.2.9. An older OMP answers [] for "anthropic".
const PROVIDERS = [
  { id: "openai-codex", name: "OpenAI Codex" },
  { id: "anthropic", name: "Claude" },
];
function targetFor(account) {
  if (typeof account.credentialId === "number" && Number.isSafeInteger(account.credentialId)) return { credentialId: account.credentialId };
  if (typeof account.accountId === "string" && account.accountId) return { accountId: account.accountId };
  if (typeof account.email === "string" && account.email) return { email: account.email };
  return null;
}
// The Codex prefix predates Claude support; keeping it keeps Codex ids stable.
function identityFor(provider, account) { const target = targetFor(account); return target ? opaqueId(provider + ":" + JSON.stringify(target)) : null; }
function labelFor(provider, account, index) {
  const detail = provider.id === "anthropic"
    ? (typeof account.orgName === "string" && account.orgName.trim() ? account.orgName.trim() : "")
    : (typeof account.planType === "string" && account.planType.trim() ? account.planType.trim() : "");
  return provider.name + (detail ? " (" + detail + ")" : "") + (index ? " " + (index + 1) : "");
}
function creditFor(provider, value) {
  const credit = asRecord(value); if (!credit || typeof credit.id !== "string" || !credit.id) return null;
  const status = typeof credit.status === "string" ? credit.status : "";
  // Codex lists spent credits too; Claude reports each grant's own state
  // ("available", "unavailable", "cooldown"…) and only spent or lapsed grants go.
  if (provider.id === "openai-codex" ? status && status !== "available" : status === "redeemed" || status === "expired") return null;
  const title = typeof credit.title === "string" && credit.title.trim() ? credit.title.trim() : null;
  return { id: credit.id, expiresAt: date(credit.expiresAt ?? credit.expires_at ?? credit.expiry), ...(title ? { title } : {}), ...(typeof credit.usable === "boolean" ? { usable: credit.usable } : {}) };
}
function normalizeAccounts(provider, raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    const account = asRecord(entry); const id = account && identityFor(provider.id, account); if (!account || !id) return [];
    let credits = Array.isArray(account.credits) ? account.credits.map((credit) => creditFor(provider, credit)).filter(Boolean) : [];
    credits.sort((left, right) => (left.expiresAt ? Date.parse(left.expiresAt) : Infinity) - (right.expiresAt ? Date.parse(right.expiresAt) : Infinity));
    const availableCount = typeof account.availableCount === "number" && Number.isFinite(account.availableCount) && account.availableCount >= 0 ? Math.floor(account.availableCount) : credits.length;
    const error = typeof account.error === "string" && account.error ? account.error : null;
    let canRedeem = !error && credits.length > 0;
    let reason = typeof account.reason === "string" && account.reason.trim() ? account.reason.trim() : null;
    if (provider.id === "anthropic") {
      // Claude's listing picks the ONE grant that may be spent next and the
      // consume call refuses any other, so that grant leads and is the only
      // one offered. No pin means nothing is safely spendable.
      const next = typeof account.nextCreditId === "string" ? account.nextCreditId : null;
      const selected = next ? credits.find((credit) => credit.id === next) : null;
      if (selected) credits = [selected, ...credits.filter((credit) => credit !== selected)];
      const redeemable = typeof account.redeemableCount === "number" ? account.redeemableCount : availableCount;
      canRedeem = !error && Boolean(selected) && account.eligible !== false && selected.usable !== false && redeemable >= 1;
      if (!canRedeem && !error && !reason && availableCount > 0) reason = next ? "Not usable right now." : "Claude did not name a reset that can be spent safely.";
    } else if (credits.some((credit) => credit.usable === false) && !credits.some((credit) => credit.usable !== false)) {
      canRedeem = false;
    }
    // `position` is omp's storage order among this provider's OAuth accounts —
    // the order Cody names "Primary"/"Secondary" everywhere else.
    const position = typeof account.position === "number" && Number.isSafeInteger(account.position) && account.position >= 0 ? account.position : index;
    return [{ id, provider: provider.id, position, label: labelFor(provider, account, index), availableCount, canRedeem, credits, ...(error ? { error } : {}), ...(reason && !canRedeem ? { reason } : {}), _target: targetFor(account) }];
  });
}
async function loadStorage(packageRoot, agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const require = createRequire(join(packageRoot, "package.json"));
  let aiPath; let utilsPath;
  try { aiPath = require.resolve("@oh-my-pi/pi-ai/auth-storage.js"); utilsPath = require.resolve("@oh-my-pi/pi-utils/dirs.js"); } catch { throw new Error("OMP's installed reset-credit modules are unavailable."); }
  const ai = await import(pathToFileURL(aiPath).href); const utils = await import(pathToFileURL(utilsPath).href);
  if (typeof ai.AuthStorage?.create !== "function" || typeof utils.getAgentDbPath !== "function") throw new Error("Installed OMP does not expose AuthStorage reset-credit support.");
  const storage = await ai.AuthStorage.create(utils.getAgentDbPath());
  await callStorageMethod(storage, "credentials", "reload", "reload");
  return storage;
}
async function list(storage) {
  const lists = await Promise.all(PROVIDERS.map(async (provider) => {
    try { return normalizeAccounts(provider, await callStorageMethod(storage, "resets", "list", "listResetCredits", { provider: provider.id })); }
    catch (error) { return { failed: error instanceof Error ? error.message : String(error), provider }; }
  }));
  // One provider failing must not hide the other's balance; only a total
  // failure is a failed listing.
  const failures = lists.filter((entry) => !Array.isArray(entry));
  if (failures.length === lists.length) throw new Error(failures[0].failed);
  return lists.filter(Array.isArray).flat();
}
// The provider target never leaves the helper; accounts are named by opaque id.
function publicAccount(account) { const copy = { ...account }; delete copy._target; return copy; }
const OUTCOME_MESSAGES = {
  ineligible: "This account cannot spend a saved reset right now.",
  offer_changed: "The saved reset on offer changed. Refresh and confirm again.",
  reset_in_progress: "Another reset for this account is still being applied.",
  reset_unconfirmed: "The last reset for this account is still unconfirmed. Refresh before trying again.",
  cooldown: "Saved resets for this account are cooling down.",
  unsupported_provider: "This OMP build cannot redeem resets for that provider.",
};
function outcomeFor(code, ok) {
  if (code === "already_redeemed") return "already_redeemed";
  if (code === "no_credit" || code === "ineligible") return "no_credit";
  if (code === "nothing_to_reset") return "nothing_to_reset";
  return ok ? "reset" : "error";
}
async function main() {
  let request; try { request = asRecord(JSON.parse(process.argv[2] ?? "")); } catch { return fail("error", "invalid_request", "Malformed reset-credit request."); }
  if (!request || (request.operation !== "list" && request.operation !== "redeem") || typeof request.packageRoot !== "string" || typeof request.agentDir !== "string") return fail("error", "invalid_request", "Malformed reset-credit request.");
  let storage;
  try { storage = await loadStorage(request.packageRoot, request.agentDir); } catch (error) { return fail(request.operation, "unsupported", error instanceof Error ? error.message : String(error)); }
  try {
    let accounts; try { accounts = await list(storage); } catch (error) { return fail(request.operation, "credit_list_failed", error instanceof Error ? error.message : String(error)); }
    if (request.operation === "list") return emit({ type: "list", ok: true, accounts: accounts.map(publicAccount) });
    if (typeof request.accountId !== "string" || typeof request.creditId !== "string" || typeof request.idempotencyKey !== "string") return fail("redeem", "invalid_request", "Malformed redemption request.");
    const chosen = accounts.find((account) => account.id === request.accountId);
    if (!chosen) return emit({ type: "redeem", outcome: "error", code: "no_account", message: "The selected reset-credit account no longer exists." });
    if (chosen.error || !chosen._target) return emit({ type: "redeem", outcome: "error", code: "account_unavailable", message: chosen.error ?? "The selected account cannot redeem reset credits." });
    if (!chosen.credits.some((credit) => credit.id === request.creditId)) return emit({ type: "redeem", outcome: "no_credit", code: "no_credit" });
    if (!chosen.canRedeem) return emit({ type: "redeem", outcome: "no_credit", code: "ineligible", message: chosen.reason ?? OUTCOME_MESSAGES.ineligible });
    try {
      // AuthStorage owns native request UUID generation and all provider cache/block cleanup.
      // 18.2.9 reads provider and grant from `target`; older builds read them
      // beside it, so both spellings are sent.
      const result = await callStorageMethod(storage, "resets", "redeem", "redeemResetCredit", {
        target: { ...chosen._target, provider: chosen.provider, creditId: request.creditId },
        provider: chosen.provider,
        creditId: request.creditId,
      });
      const code = typeof result?.code === "string" ? result.code : "";
      const outcome = outcomeFor(code, result?.ok === true);
      const reason = typeof result?.reason === "string" && result.reason.trim() ? result.reason.trim() : null;
      const message = reason ?? (outcome === "error" || code === "ineligible" ? OUTCOME_MESSAGES[code] : null);
      return emit({ type: "redeem", outcome, ...(code ? { code } : {}), ...(message ? { message } : {}) });
    } catch (error) { return emit({ type: "redeem", outcome: "error", code: "unsupported", message: error instanceof Error ? error.message : String(error) }); }
  } finally { await storage.close?.(); }
}
main().catch((error) => fail("error", "unsupported", error instanceof Error ? error.message : String(error)));
