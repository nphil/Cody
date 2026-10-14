#!/usr/bin/env bun
/**
 * Isolated Bun bridge: Claude API keys under omp's `anthropic-api` providers,
 * written and listed through omp's OWN installed AuthStorage.
 *
 * Why separate provider ids at all (lib/claude-credits.ts has the whole story):
 * an API key stored under `anthropic` is never reached while a plan account
 * exists, so the keys live beside the plans — one provider per key
 * (`anthropic-api`, `anthropic-api-2`, …), so omp's fallback chain can walk
 * past a key whose prepaid balance is empty.
 *
 * The request arrives on STDIN, not argv: an API key in an argument list is
 * readable by every process on the machine. Nothing printed here ever contains
 * a key — only row ids, providers and the last four characters, which is all
 * the UI shows. Removal is NOT here: it goes through bin/cody-omp-credentials.mjs
 * `remove`, which also purges the soft-deleted row that would otherwise keep the key.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { authApi } from "./cody-omp-auth-api.mjs";
console.log = (...args) => console.error(...args);
console.info = console.log;
console.debug = console.log;

// The credits providers and nothing else — never `anthropic`, the plans' own pool, where an API key
// would be dead weight. The same family as claudeCreditsSlot() in lib/claude-credits.ts.
const CREDITS_PROVIDER = /^anthropic-api(?:-[2-8])?$/;

function emit(value) { process.stdout.write(JSON.stringify(value)); }
function fail(type, code, message) { emit({ type, ok: false, code, message }); process.exitCode = 1; }
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function messageOf(error) { return error instanceof Error ? error.message : String(error); }

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadStorage(packageRoot, agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const require = createRequire(join(packageRoot, "package.json"));
  let aiPath; let utilsPath;
  try { aiPath = require.resolve("@oh-my-pi/pi-ai/auth-storage.js"); utilsPath = require.resolve("@oh-my-pi/pi-utils/dirs.js"); } catch { throw new Error("OMP's installed credential modules are unavailable."); }
  const ai = await import(pathToFileURL(aiPath).href);
  const utils = await import(pathToFileURL(utilsPath).href);
  if (typeof ai.AuthStorage?.create !== "function" || typeof utils.getAgentDbPath !== "function") throw new Error("Installed OMP does not expose AuthStorage credential support.");
  const api = authApi(await ai.AuthStorage.create(utils.getAgentDbPath()));
  await api.reload();
  return api;
}

/** What the UI may know about the stored keys: each row id, provider and last four characters. */
function describeKeys(api, providers) {
  return providers.flatMap((provider) => api.list(provider)
    .filter((row) => row.credential?.type === "api_key" && typeof row.credential.key === "string")
    .map((row) => ({ id: row.id, last4: row.credential.key.slice(-4), provider })));
}

async function main() {
  let request;
  try { request = asRecord(JSON.parse(await readStdin())); } catch { return fail("error", "invalid_request", "Malformed request."); }
  const operation = request?.operation;
  const providers = Array.isArray(request?.providers) ? [...new Set(request.providers)] : [];
  if ((operation !== "list" && operation !== "add") || typeof request.packageRoot !== "string" || typeof request.agentDir !== "string" || providers.length === 0 || !providers.every((provider) => typeof provider === "string" && CREDITS_PROVIDER.test(provider))) return fail("error", "invalid_request", "Malformed request.");
  if (operation === "add" && (typeof request.key !== "string" || request.key.length === 0)) return fail("add", "invalid_request", "A key is required.");
  if (operation === "add" && !providers.includes(request.provider)) return fail("add", "invalid_request", "A credits provider is required.");

  let api;
  try { api = await loadStorage(request.packageRoot, request.agentDir); } catch (error) { return fail(operation, "unsupported", messageOf(error)); }
  try {
    if (operation === "list") return emit({ type: "list", ok: true, keys: describeKeys(api, providers) });

    const { key, provider } = request;
    // omp stores identical keys once PER PROVIDER, so the same key saved for a second account would
    // quietly become a second credential. Look in every credits provider first and answer with the row
    // that already holds it; the caller decides whether that is a duplicate. The value is compared in
    // this process and never printed.
    const holds = (row) => row.credential?.type === "api_key" && row.credential.key === key;
    for (const existing of providers) {
      const row = api.list(existing).find(holds);
      if (row) return emit({ type: "add", ok: true, id: row.id, last4: key.slice(-4), provider: existing });
    }
    // `source: "login"` is what omp's own API-key login stores; it makes the key
    // part of the provider's login pool rather than an env-style leftover.
    try { await api.addCredential(provider, { type: "api_key", key, source: "login" }); } catch (error) { return fail("add", "credential_add_failed", messageOf(error).split(key).join("[key]")); }
    const stored = api.list(provider).find(holds);
    if (!stored) return fail("add", "credential_add_failed", "omp did not keep the key.");
    return emit({ type: "add", ok: true, id: stored.id, last4: key.slice(-4), provider });
  } finally {
    await api.close();
  }
}
main().catch((error) => fail("error", "unsupported", messageOf(error)));
