import { spawn } from "child_process";
import { existsSync } from "fs";
import { StringDecoder } from "string_decoder";
import path from "path";
import { readEnv } from "../env";
import { getAgentDir } from "../omp/paths";
import { findOmpPackageRoot } from "../omp/package-source";
import { resolveOmpBin } from "../omp/omp-cli";

/** One unexpired rate-limit block on a credential. `scope` is omp's
 *  `blockScope` ('' = the whole account; omp 18.19+ also scopes a block to a
 *  Claude tier, a Codex lane, a Cursor pool, …; an OMP without the concept
 *  always reports ''). `until` is epoch milliseconds. */
export interface OmpCredentialBlock { scope: string; until: number | null }
/** One stored OMP credential row, active or disabled — never the credential
 * object itself, so a token/refresh/api key can never reach this process. */
export interface OmpCredentialRow {
  id: number;
  provider: string;
  type: "oauth" | "api_key";
  identity: string | null;
  planType: string | null;
  disabledCause: string | null;
  /** ISO timestamp of the latest UNEXPIRED rate-limit block, or null. */
  blockedUntil: string | null;
  /** Every unexpired block, one per scope. Absent on a row from a source that
   *  predates scopes: read it as one '' block ending at `blockedUntil`. */
  blocks?: OmpCredentialBlock[];
  /** omp's `credential_pin` digest for this OAuth account (sha256 hex), the
   *  value a session file records for the account that served it; null for
   *  API keys, disabled rows, or an OMP build that cannot compute it. */
  pinHash: string | null;
}
/** `stale`: the rows are the last successful read, returned because the latest one failed (`reason` says why). */
export interface OmpCredentialsSnapshot { available: boolean; credentials: OmpCredentialRow[]; reason?: string; stale?: boolean; }
/** `count` (provider-wide removal only): how many stored accounts that signed out. */
export interface OmpCredentialRemoval { removed: boolean; providerRemoved: boolean; count?: number; code?: string; message?: string; }

interface ListRequest { operation: "list"; packageRoot: string; agentDir: string }
interface RemoveRequest { operation: "remove"; packageRoot: string; agentDir: string; provider: string; credentialId: number }
interface RemoveProviderRequest { operation: "remove_provider"; packageRoot: string; agentDir: string; provider: string }
interface UnblockRequest { operation: "unblock"; packageRoot: string; agentDir: string; credentialId: number }
type HelperRequest = ListRequest | RemoveRequest | RemoveProviderRequest | UnblockRequest;
const HELPER_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export function unavailableOmpCredentials(reason: string): OmpCredentialsSnapshot { return { available: false, credentials: [], reason }; }

export interface OmpCredentialBridgeDeps { helperPath?: string; bunBin?: string; packageRoot?: () => string | null; agentDir?: () => string; }
function helperPath(): string {
  const packageDir = readEnv("PACKAGE_DIR") ?? path.resolve(import.meta.dirname, "../..");
  return path.join(packageDir, "bin", "cody-omp-credentials.mjs");
}
function bridgeUnavailable(): string | null {
  if (!resolveOmpBin()) return "OMP runtime is not installed.";
  if (!findOmpPackageRoot()) return "OMP's installed package source is unavailable; account management is unsupported by this installation.";
  return null;
}
function parseJson(stdout: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(stdout); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
function invoke(request: HelperRequest, deps: OmpCredentialBridgeDeps = {}): Promise<Record<string, unknown> | null> {
  const executable = deps.bunBin ?? readEnv("BUN_BIN") ?? "bun";
  const script = deps.helperPath ?? helperPath();
  if (!existsSync(script)) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown> | null>();
  const decoder = new StringDecoder("utf8");
  let stdout = "";
  let stderrBytes = 0;
  let child;
  try {
    child = spawn(executable, [script, JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    resolve(null);
    return promise;
  }
  let settled = false;
  const finish = (value: Record<string, unknown> | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, HELPER_TIMEOUT_MS);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += decoder.write(chunk);
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
  });
  // Drain diagnostics so a failing Bun helper cannot block on a full pipe. They may contain provider detail, so never return them.
  child.stderr?.on("data", (chunk: Buffer) => { if (stderrBytes < MAX_OUTPUT_BYTES) stderrBytes += chunk.length; });
  child.once("error", () => finish(null));
  child.once("close", () => finish(parseJson(stdout + decoder.end())));
  return promise;
}
function safeString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
/** The helper's `blocks` array, kept to well-formed `{scope, until}` entries. A
 *  row without the array (a helper that predates scopes) falls back to one
 *  account-wide '' block ending at `blockedUntil`, so every row carries them. */
function safeBlocks(raw: Record<string, unknown>, blockedUntil: string | null): OmpCredentialBlock[] {
  if (!Array.isArray(raw.blocks)) {
    const ms = blockedUntil ? Date.parse(blockedUntil) : Number.NaN;
    return Number.isFinite(ms) ? [{ scope: "", until: ms }] : [];
  }
  const byScope = new Map<string, number | null>();
  for (const entry of raw.blocks) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const block = entry as Record<string, unknown>;
    const scope = typeof block.scope === "string" ? block.scope : "";
    const until = typeof block.until === "number" && Number.isFinite(block.until) ? block.until : null;
    const known = byScope.get(scope);
    if (known === undefined || (until ?? 0) > (known ?? 0)) byScope.set(scope, until);
  }
  return [...byScope].map(([scope, until]) => ({ scope, until }));
}
function safeCredentialRow(value: unknown): OmpCredentialRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "number" && Number.isSafeInteger(raw.id) ? raw.id : null;
  const provider = safeString(raw.provider);
  const type = raw.type === "oauth" || raw.type === "api_key" ? raw.type : null;
  if (id === null || !provider || !type) return null;
  const blockedUntil = safeString(raw.blockedUntil);
  return {
    id,
    provider,
    type,
    identity: safeString(raw.identity),
    planType: safeString(raw.planType),
    disabledCause: safeString(raw.disabledCause),
    blockedUntil,
    blocks: safeBlocks(raw, blockedUntil),
    pinHash: typeof raw.pinHash === "string" && /^[0-9a-f]{64}$/.test(raw.pinHash) ? raw.pinHash : null,
  };
}
function normalizeList(frame: Record<string, unknown> | null): OmpCredentialsSnapshot {
  if (!frame || frame.type !== "list") return unavailableOmpCredentials("Credential helper did not return a valid response.");
  if (frame.ok !== true) return unavailableOmpCredentials(safeString(frame.message) ?? "Account list is unavailable.");
  const credentials = Array.isArray(frame.credentials) ? frame.credentials.flatMap((row): OmpCredentialRow[] => { const normalized = safeCredentialRow(row); return normalized ? [normalized] : []; }) : [];
  return { available: true, credentials };
}
function normalizeRemoval(frame: Record<string, unknown> | null, expectedType: "remove" | "remove_provider"): OmpCredentialRemoval {
  if (!frame || frame.type !== expectedType) return { removed: false, providerRemoved: false, code: "inconclusive", message: "The removal result is inconclusive; refresh before trying again." };
  if (frame.ok !== true) return { removed: false, providerRemoved: false, code: safeString(frame.code) ?? "unsupported", message: safeString(frame.message) ?? "Account removal is unavailable." };
  const removed = frame.removed === true;
  const providerRemoved = expectedType === "remove_provider" ? removed : frame.providerRemoved === true;
  const count = expectedType === "remove_provider" && typeof frame.count === "number" && Number.isSafeInteger(frame.count) && frame.count >= 0 ? frame.count : undefined;
  return { removed, providerRemoved, ...(count !== undefined ? { count } : {}) };
}

export async function listOmpCredentials(deps: OmpCredentialBridgeDeps = {}): Promise<OmpCredentialsSnapshot> {
  const unavailable = deps.packageRoot ? null : bridgeUnavailable();
  const packageRoot = deps.packageRoot?.() ?? findOmpPackageRoot();
  if (unavailable || !packageRoot) return unavailableOmpCredentials(unavailable ?? "OMP's installed package source is unavailable; account management is unsupported by this installation.");
  const agentDir = deps.agentDir?.() ?? getAgentDir();
  const frame = await invoke({ operation: "list", packageRoot, agentDir }, deps);
  return normalizeList(frame);
}

/** A transient helper failure must not drop block information for long: past
 *  this age a remembered list is no longer the best available fact. */
const KEPT_CREDENTIALS_MAX_AGE_MS = 15 * 60_000;
declare global {
  var __codyLastCredentialRows: { at: number; credentials: OmpCredentialRow[] } | undefined;
}

/**
 * `listOmpCredentials`, remembering the last SUCCESSFUL list. When a later call
 * fails (the helper timed out, the store was locked for a moment) the remembered
 * rows come back marked `stale`, so a rate-limit block already seen keeps
 * routing around its account instead of vanishing for one read. A failure with
 * nothing remembered, or older than 15 minutes, is reported as it is. Blocks
 * carry their own deadline, so a remembered one still expires on time.
 */
export async function listOmpCredentialsKeepingLast(deps: OmpCredentialBridgeDeps = {}): Promise<OmpCredentialsSnapshot> {
  const fresh = await listOmpCredentials(deps);
  if (fresh.available) {
    globalThis.__codyLastCredentialRows = { at: Date.now(), credentials: fresh.credentials };
    return fresh;
  }
  const last = globalThis.__codyLastCredentialRows;
  if (!last || Date.now() - last.at > KEPT_CREDENTIALS_MAX_AGE_MS) return fresh;
  return { available: true, credentials: last.credentials, stale: true, reason: fresh.reason };
}
export async function removeOmpCredential(provider: string, credentialId: number, deps: OmpCredentialBridgeDeps = {}): Promise<OmpCredentialRemoval> {
  const unavailable = deps.packageRoot ? null : bridgeUnavailable();
  const packageRoot = deps.packageRoot?.() ?? findOmpPackageRoot();
  if (unavailable || !packageRoot) return { removed: false, providerRemoved: false, code: "unsupported", message: unavailable ?? "OMP's installed package source is unavailable; account management is unsupported by this installation." };
  const agentDir = deps.agentDir?.() ?? getAgentDir();
  const frame = await invoke({ operation: "remove", packageRoot, agentDir, provider, credentialId }, deps);
  return normalizeRemoval(frame, "remove");
}
export async function removeOmpProvider(provider: string, deps: OmpCredentialBridgeDeps = {}): Promise<OmpCredentialRemoval> {
  const unavailable = deps.packageRoot ? null : bridgeUnavailable();
  const packageRoot = deps.packageRoot?.() ?? findOmpPackageRoot();
  if (unavailable || !packageRoot) return { removed: false, providerRemoved: false, code: "unsupported", message: unavailable ?? "OMP's installed package source is unavailable; account management is unsupported by this installation." };
  const agentDir = deps.agentDir?.() ?? getAgentDir();
  const frame = await invoke({ operation: "remove_provider", packageRoot, agentDir, provider }, deps);
  return normalizeRemoval(frame, "remove_provider");
}

export interface OmpCredentialUnblock {
  cleared: { scope: string | null; until: string | null }[];
  code?: string;
  message?: string;
}

/**
 * Clear omp's rate-limit blocks for one credential.
 *
 * A block lives in omp's own store, separate from the usage API, and can
 * outlast the condition that wrote it — an account reporting 4% used can be
 * blocked for five hours after a single 429, during which every turn falls
 * back to another provider. Clearing it costs nothing if the provider is
 * genuinely limiting: the next request writes the block straight back.
 */
export async function unblockOmpCredential(credentialId: number, deps: OmpCredentialBridgeDeps = {}): Promise<OmpCredentialUnblock> {
  const unavailable = deps.packageRoot ? null : bridgeUnavailable();
  const packageRoot = deps.packageRoot?.() ?? findOmpPackageRoot();
  if (unavailable || !packageRoot) return { cleared: [], code: "unsupported", message: unavailable ?? "OMP's installed package source is unavailable; credential blocks cannot be cleared by this installation." };
  const agentDir = deps.agentDir?.() ?? getAgentDir();
  const frame = await invoke({ operation: "unblock", packageRoot, agentDir, credentialId }, deps);
  if (!frame || frame.type !== "unblock" || frame.ok !== true) {
    return { cleared: [], code: safeString(frame?.code) ?? "unsupported", message: safeString(frame?.message) ?? "Clearing the rate-limit block failed." };
  }
  const cleared = Array.isArray(frame.cleared)
    ? frame.cleared.flatMap((entry): { scope: string | null; until: string | null }[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const row = entry as Record<string, unknown>;
        return [{ scope: safeString(row.scope), until: safeString(row.until) }];
      })
    : [];
  return { cleared };
}
