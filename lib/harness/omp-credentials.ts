import { spawn } from "child_process";
import { existsSync } from "fs";
import { StringDecoder } from "string_decoder";
import path from "path";
import { readEnv } from "../env";
import { getAgentDir } from "../omp/paths";
import { findOmpPackageRoot } from "../omp/package-source";
import { resolveOmpBin } from "../omp/omp-cli";

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
  /** omp's session `credential_pin` digest (sha256 hex); null for API keys,
   * disabled rows, or OAuth credentials without the required identity. */
  pinHash: string | null;
}
export interface OmpCredentialsSnapshot { available: boolean; credentials: OmpCredentialRow[]; reason?: string; }
export interface OmpCredentialRemoval {
  removed: boolean;
  providerRemoved: boolean;
  /** Redacted identity returned only to Cody so its local label can be
   * removed even when the account list has gone stale. Never credential data. */
  identity?: string;
  code?: string;
  message?: string;
}

interface ListRequest { operation: "list"; packageRoot: string; agentDir: string }
/** `remove` is the explicit per-account permanent path. It is intentionally
 * separate from OMP's provider-wide soft logout exposed by `remove_provider`. */
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
export function sanitizeOmpCredentialReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : safeString(value);
  if (!raw) return "Credential details are unavailable.";
  const sanitized = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:(?:access|refresh|id)[_-]?)?token\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "token=[redacted]")
    .replace(/\b(?:api[_ -]?key|password|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "credential=[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9._~-]{48,}\b/g, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account]")
    .replace(/\b[A-Za-z]:\\(?:[^\s"'<>|]+\\?)+/g, "[path]")
    .replace(/\/(?:home|data|opt|tmp|var|Users|mnt)\/(?:[^\s"'<>|,;)]*)/g, "[path]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized || "Credential details are unavailable.";
}
function safeCredentialRow(value: unknown): OmpCredentialRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "number" && Number.isSafeInteger(raw.id) ? raw.id : null;
  const provider = safeString(raw.provider);
  const type = raw.type === "oauth" || raw.type === "api_key" ? raw.type : null;
  if (id === null || !provider || !type) return null;
  return {
    id,
    provider,
    type,
    identity: safeString(raw.identity),
    planType: safeString(raw.planType),
    disabledCause: safeString(raw.disabledCause),
    blockedUntil: safeString(raw.blockedUntil),
    pinHash: typeof raw.pinHash === "string" && /^[0-9a-f]{64}$/.test(raw.pinHash) ? raw.pinHash : null,
  };
}
function normalizeList(frame: Record<string, unknown> | null): OmpCredentialsSnapshot {
  if (!frame || frame.type !== "list") return unavailableOmpCredentials("Credential helper did not return a valid response.");
  if (frame.ok !== true) {
    const code = safeString(frame.code);
    const message = safeString(frame.message) ?? "Account list is unavailable.";
    return unavailableOmpCredentials(sanitizeOmpCredentialReason(code ? `${code}: ${message}` : message));
  }
  const credentials = Array.isArray(frame.credentials) ? frame.credentials.flatMap((row): OmpCredentialRow[] => { const normalized = safeCredentialRow(row); return normalized ? [normalized] : []; }) : [];
  return { available: true, credentials };
}
function normalizeRemoval(frame: Record<string, unknown> | null, expectedType: "remove" | "remove_provider"): OmpCredentialRemoval {
  if (!frame || frame.type !== expectedType) return { removed: false, providerRemoved: false, code: "inconclusive", message: "The removal result is inconclusive; refresh before trying again." };
  if (frame.ok !== true) return { removed: false, providerRemoved: false, code: safeString(frame.code) ?? "unsupported", message: safeString(frame.message) ?? "Account removal is unavailable." };
  const removed = frame.removed === true;
  const providerRemoved = expectedType === "remove_provider" ? removed : frame.providerRemoved === true;
  const identity = safeString(frame.identity);
  return { removed, providerRemoved, ...(identity ? { identity } : {}) };
}

export async function listOmpCredentials(deps: OmpCredentialBridgeDeps = {}): Promise<OmpCredentialsSnapshot> {
  const unavailable = deps.packageRoot ? null : bridgeUnavailable();
  const packageRoot = deps.packageRoot?.() ?? findOmpPackageRoot();
  if (unavailable || !packageRoot) return unavailableOmpCredentials(unavailable ?? "OMP's installed package source is unavailable; account management is unsupported by this installation.");
  const agentDir = deps.agentDir?.() ?? getAgentDir();
  const frame = await invoke({ operation: "list", packageRoot, agentDir }, deps);
  return normalizeList(frame);
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
