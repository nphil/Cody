import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { StringDecoder } from "string_decoder";
import path from "path";
import { readEnv } from "../env";
import { getAgentDir } from "../omp/paths";
import { findOmpPackageRoot, ompPackageVersion } from "../omp/package-source";
import { resolveOmpBin } from "../omp/omp-cli";

export interface ResetCredit { id: string; expiresAt: string | null; title?: string; /** Limit ids this reset clears (omp's `clears`), e.g. `anthropic:5h`, `anthropic:7d`, `anthropic:7d:fable`. Absent when the engine does not say. */ clears?: string[]; }
/** `provider` is the engine's id ("openai-codex", "anthropic"); `position` is
 * omp's storage order among that provider's accounts (0 = Primary); `reason`
 * says why a positive balance cannot be spent right now.
 *
 * `checkedAt` is when the provider last ANSWERED for this account. `stale`
 * marks an answer carried over because the latest check failed — the count is
 * the last one the provider confirmed, not a fresh reading. `retrying` means
 * the check failed and no earlier answer exists; Cody backs off and retries. */
export interface ResetCreditAccount { id: string; label: string; provider?: string; position?: number; availableCount: number; canRedeem: boolean; credits: ResetCredit[]; error?: string; reason?: string; checkedAt?: string; stale?: boolean; retrying?: boolean; }
/** `failedProviders` lists the engine's provider ids (`openai-codex`, `anthropic`) whose listing failed while another's answered, so absent accounts are "unknown", not "none". */
export interface ResetCreditsSnapshot { available: boolean; accounts: ResetCreditAccount[]; fetchedAt: string; reason?: string; observerId?: string; failedProviders?: string[]; }
export type ResetCreditOutcomeKind = "reset" | "already_redeemed" | "no_credit" | "nothing_to_reset" | "error";
export type ResetCreditErrorCode = "credit_list_failed" | "no_account" | "account_unavailable" | "unsupported" | "invalid_request" | "in_flight" | "no_credit" | string;
export interface ResetCreditOutcome { outcome: ResetCreditOutcomeKind; accountId: string; creditId?: string; code?: ResetCreditErrorCode; message?: string; }
interface ListRequest { operation: "list"; packageRoot: string; agentDir: string }
interface RedeemRequest { operation: "redeem"; packageRoot: string; agentDir: string; accountId: string; creditId: string; idempotencyKey: string; /** Set only when this engine's `omp usage reset` is the spender; absent means the direct AuthStorage call. */ ompBin?: string }
type HelperRequest = ListRequest | RedeemRequest;
const HELPER_TIMEOUT_MS = 15_000;
// `omp usage reset` may wait 30 s for omp's reset lock, then list and redeem
// (10 s + 15 s); the helper's own limit (80 s) fires before this one.
const CLI_REDEEM_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function unavailableResetCredits(reason: string): ResetCreditsSnapshot { return { available: false, accounts: [], fetchedAt: new Date().toISOString(), reason }; }
export function isResetCreditIdempotencyKey(value: unknown): value is string { return typeof value === "string" && UUID_RE.test(value); }
export interface ResetCreditBridgeDeps {
  helperPath?: string; bunBin?: string; packageRoot?: () => string | null; agentDir?: () => string;
  /** The omp binary to spend through; defaults to the resolved one. When a test injects `packageRoot` it is NOT resolved, so a fixture never reaches a real engine. */
  ompBin?: string;
  /** Whether `bin` has `omp usage reset`; defaults to a cached probe of its help text. */
  supportsUsageReset?: (bin: string, packageRoot: string) => Promise<boolean>;
}
/**
 * Whether an omp help text lists `reset` among `omp usage`'s actions. The
 * ACTION line reads `(invalidate|clients|accounts)` before 18.9.0 and
 * `(invalidate|clients|accounts|reset)` after; reading the engine's own help
 * beats comparing version numbers, which rot as releases are renamed.
 */
export function usageHelpListsReset(help: string): boolean { return /^\s*ACTION\b[^\n]*\([^)\n]*\breset\b[^)\n]*\)/m.test(help); }
const usageResetSupport = new Map<string, boolean>();
/** Probe `omp usage reset --help` once per binary + package version. A probe that cannot run is not cached and counts as unsupported (the direct call stays in use). */
export async function probeUsageResetSupport(bin: string, packageRoot: string): Promise<boolean> {
  const key = bin + "\0" + (ompPackageVersion(packageRoot) ?? "");
  const known = usageResetSupport.get(key);
  if (known !== undefined) return known;
  const help = await new Promise<string | null>((resolve) => {
    execFile(bin, ["usage", "reset", "--help"], { timeout: 20_000, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }, (error, stdout) => resolve(error ? null : stdout));
  });
  if (help === null) return false;
  const supported = usageHelpListsReset(help);
  usageResetSupport.set(key, supported);
  return supported;
}
function helperPath(): string {
  const packageDir = readEnv("PACKAGE_DIR") ?? path.resolve(import.meta.dirname, "../..");
  return path.join(packageDir, "bin", "cody-omp-reset-credits.mjs");
}
function bridgeUnavailable(): string | null {
  if (!resolveOmpBin()) return "OMP runtime is not installed.";
  if (!findOmpPackageRoot()) return "OMP's installed package source is unavailable; reset credits are unsupported by this installation.";
  return null;
}
function parseJson(stdout: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(stdout); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
function invoke(request: HelperRequest, deps: ResetCreditBridgeDeps = {}, timeoutMs = HELPER_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
  const executable = deps.bunBin ?? readEnv("BUN_BIN") ?? "bun";
  const script = deps.helperPath ?? helperPath();
  if (!existsSync(script)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let stderrBytes = 0;
    let child;
    try {
      child = spawn(executable, [script, JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += decoder.write(chunk);
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    // Drain diagnostics so a failing Bun helper cannot block on a full pipe. They may contain provider detail, so never return them.
    child.stderr?.on("data", (chunk: Buffer) => { if (stderrBytes < MAX_OUTPUT_BYTES) stderrBytes += chunk.length; });
    child.once("error", () => finish(null));
    child.once("close", () => finish(parseJson(stdout + decoder.end())));
  });
}
function safeString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function safeAccount(value: unknown): ResetCreditAccount | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>; const id = safeString(raw.id); const label = safeString(raw.label);
  const availableCount = typeof raw.availableCount === "number" && Number.isSafeInteger(raw.availableCount) && raw.availableCount >= 0 ? raw.availableCount : null;
  if (!id || !label || availableCount === null || typeof raw.canRedeem !== "boolean") return null;
  const credits = Array.isArray(raw.credits) ? raw.credits.flatMap((credit): ResetCredit[] => { if (!credit || typeof credit !== "object" || Array.isArray(credit)) return []; const c = credit as Record<string, unknown>; const creditId = safeString(c.id); const title = safeString(c.title); const clears = Array.isArray(c.clears) ? c.clears.flatMap((limit) => safeString(limit) ?? []) : []; return creditId ? [{ id: creditId, expiresAt: typeof c.expiresAt === "string" ? c.expiresAt : null, ...(title ? { title } : {}), ...(clears.length > 0 ? { clears } : {}) }] : []; }) : [];
  const error = safeString(raw.error); const reason = safeString(raw.reason); const provider = safeString(raw.provider);
  const position = typeof raw.position === "number" && Number.isSafeInteger(raw.position) && raw.position >= 0 ? raw.position : null;
  return { id, label, ...(provider ? { provider } : {}), ...(position !== null ? { position } : {}), availableCount, canRedeem: raw.canRedeem, credits, ...(error ? { error } : {}), ...(reason ? { reason } : {}) };
}
function normalizeList(frame: Record<string, unknown> | null): ResetCreditsSnapshot {
  if (!frame || frame.type !== "list") return unavailableResetCredits("Reset-credit helper did not return a valid response.");
  if (frame.ok !== true) return unavailableResetCredits(safeString(frame.message) ?? "Reset credits are unavailable.");
  const accounts = Array.isArray(frame.accounts) ? frame.accounts.flatMap((account): ResetCreditAccount[] => { const normalized = safeAccount(account); return normalized ? [normalized] : []; }) : [];
  const failedProviders = Array.isArray(frame.failedProviders) ? frame.failedProviders.flatMap((provider) => safeString(provider) ?? []) : [];
  return { available: true, accounts, fetchedAt: new Date().toISOString(), ...(failedProviders.length > 0 ? { failedProviders } : {}) };
}
function normalizeOutcome(frame: Record<string, unknown> | null, request: RedeemRequest): ResetCreditOutcome {
  if (!frame || frame.type !== "redeem") return { outcome: "error", accountId: request.accountId, creditId: request.creditId, code: "inconclusive", message: "The redemption result is inconclusive; refresh before trying again." };
  const outcome = frame.outcome;
  if (outcome !== "reset" && outcome !== "already_redeemed" && outcome !== "no_credit" && outcome !== "nothing_to_reset" && outcome !== "error") return { outcome: "error", accountId: request.accountId, creditId: request.creditId, code: "unsupported", message: "Reset-credit helper returned an unknown outcome." };
  const code = safeString(frame.code); const message = safeString(frame.message);
  return { outcome, accountId: request.accountId, creditId: request.creditId, ...(code ? { code } : {}), ...(message ? { message } : {}) };
}
export async function listResetCredits(deps: ResetCreditBridgeDeps = {}): Promise<ResetCreditsSnapshot> {
  const unavailable = deps.packageRoot ? null : bridgeUnavailable(); const packageRoot = deps.packageRoot?.() ?? findOmpPackageRoot();
  if (unavailable || !packageRoot) return unavailableResetCredits(unavailable ?? "OMP's installed package source is unavailable; reset credits are unsupported by this installation.");
  return normalizeList(await invoke({ operation: "list", packageRoot, agentDir: deps.agentDir?.() ?? getAgentDir() }, deps));
}
export async function redeemResetCredit(input: { accountId: string; creditId: string; idempotencyKey: string }, deps: ResetCreditBridgeDeps = {}): Promise<ResetCreditOutcome> {
  if (!isResetCreditIdempotencyKey(input.idempotencyKey)) return { outcome: "error", accountId: input.accountId, creditId: input.creditId, code: "invalid_request", message: "A valid idempotency key is required." };
  const unavailable = deps.packageRoot ? null : bridgeUnavailable(); const packageRoot = deps.packageRoot?.() ?? findOmpPackageRoot();
  if (unavailable || !packageRoot) return { outcome: "error", accountId: input.accountId, creditId: input.creditId, code: "unsupported", message: unavailable ?? "OMP's installed package source is unavailable; reset credits are unsupported by this installation." };
  const request: RedeemRequest = { operation: "redeem", packageRoot, agentDir: deps.agentDir?.() ?? getAgentDir(), ...input };
  // Spend through `omp usage reset` where the engine has it: it takes omp's
  // cross-process reset lock, so a click here cannot double-spend with a
  // running session. A test that injects `packageRoot` never resolves a real
  // binary. Engines without the command keep the helper's direct call.
  const bin = deps.ompBin ?? (deps.packageRoot ? null : resolveOmpBin());
  const viaCli = bin !== null && await (deps.supportsUsageReset ?? probeUsageResetSupport)(bin, packageRoot);
  if (viaCli) request.ompBin = bin;
  return normalizeOutcome(await invoke(request, deps, viaCli ? CLI_REDEEM_TIMEOUT_MS : HELPER_TIMEOUT_MS), request);
}
export function createResetCreditIdempotencyKey(): string { return randomUUID(); }
