#!/usr/bin/env bun
/**
 * Isolated Bun bridge that lifts omp's rate-limit block rows for ONE
 * credential, through the installed omp's own AuthStorage.
 *
 * It never loads a credential. `AuthStorage.create` opens the store without
 * reading any credential row (only `reload()` does, and it is never called
 * here); the block API is keyed by the numeric credential id alone. So no
 * token, refresh token or API key ever enters this process, and nothing but
 * block scopes and deadlines can leave it.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { authApi } from "./cody-omp-auth-api.mjs";
console.log = (...args) => console.error(...args);
console.info = console.log;
console.debug = console.log;
function emit(value) { process.stdout.write(JSON.stringify(value)); }
function fail(code, message) { emit({ type: "unblock", ok: false, outcome: "error", code, message }); process.exitCode = 1; }
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function iso(ms) { return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null; }

async function openStorage(packageRoot, agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const require = createRequire(join(packageRoot, "package.json"));
  let aiPath; let utilsPath;
  try { aiPath = require.resolve("@oh-my-pi/pi-ai/auth-storage.js"); utilsPath = require.resolve("@oh-my-pi/pi-utils/dirs.js"); } catch { throw new Error("OMP's installed credential modules are unavailable."); }
  const ai = await import(pathToFileURL(aiPath).href); const utils = await import(pathToFileURL(utilsPath).href);
  if (typeof ai.AuthStorage?.create !== "function" || typeof utils.getAgentDbPath !== "function") throw new Error("Installed OMP does not expose AuthStorage.");
  // Deliberately no reload(): that is the call that reads credential rows.
  return authApi(await ai.AuthStorage.create(utils.getAgentDbPath()));
}

function activeBlocks(api, credentialId) {
  return api.listBlocks([credentialId])
    .filter((block) => block?.credentialId === credentialId && typeof block.blockedUntilMs === "number" && block.blockedUntilMs > Date.now());
}

async function main() {
  let request; try { request = asRecord(JSON.parse(process.argv[2] ?? "")); } catch { return fail("invalid_request", "Malformed unblock request."); }
  if (!request || request.operation !== "unblock" || typeof request.packageRoot !== "string" || typeof request.agentDir !== "string"
    || !(typeof request.credentialId === "number" && Number.isSafeInteger(request.credentialId))) return fail("invalid_request", "Malformed unblock request.");
  let storage;
  try { storage = await openStorage(request.packageRoot, request.agentDir); } catch (error) { return fail("unsupported", error instanceof Error ? error.message : String(error)); }
  try {
    const blocks = activeBlocks(storage, request.credentialId);
    if (blocks.length === 0) return emit({ type: "unblock", ok: true, outcome: "not_blocked", cleared: [] });
    storage.deleteBlocks(request.credentialId, blocks);
    if (activeBlocks(storage, request.credentialId).length > 0) return fail("unblock_failed", "The block is still recorded after removal.");
    return emit({ type: "unblock", ok: true, outcome: "lifted", cleared: blocks.map((block) => ({ scope: block.blockScope || null, until: iso(block.blockedUntilMs) })) });
  } catch (error) {
    return fail("unblock_failed", error instanceof Error ? error.message : String(error));
  } finally { await storage.close?.(); }
}
main().catch((error) => fail("unsupported", error instanceof Error ? error.message : String(error)));
