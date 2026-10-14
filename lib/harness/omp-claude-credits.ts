import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { StringDecoder } from "string_decoder";
import { CLAUDE_CREDITS_PROVIDERS, claudeCreditsSlot } from "../claude-credits";
import { readEnv } from "../env";
import { findOmpPackageRoot } from "../omp/package-source";
import { resolveOmpBin } from "../omp/omp-cli";
import { getAgentDir } from "../omp/paths";

/**
 * The Node side of `bin/cody-omp-claude-credits.mjs`: Claude API keys under
 * omp's `anthropic-api` providers (one per key: `anthropic-api`,
 * `anthropic-api-2`, …), stored and listed through omp's own AuthStorage in a
 * Bun child (omp's packages are Bun-only).
 *
 * The key travels to the child on STDIN — never argv, where every process on
 * the machine could read it — and nothing that comes back carries one: the
 * child answers with row ids, providers and the last four characters only.
 * Removal is `removeOmpCredential(provider, id)` (lib/harness/omp-credentials.ts),
 * which also purges the soft-deleted row that would otherwise keep the key.
 */

export interface ClaudeKeyRow {
  /** omp's credential row id. */
  id: number;
  last4: string;
  /** The credits provider the key lives under (`anthropic-api`, `anthropic-api-2`, …). */
  provider: string;
}
export interface ClaudeKeysSnapshot {
  available: boolean;
  keys: ClaudeKeyRow[];
  reason?: string;
}
export type ClaudeKeyAddResult =
  | { ok: true; id: number; last4: string; provider: string }
  | { ok: false; code: string; message: string };

export interface ClaudeCreditsBridgeDeps {
  helperPath?: string;
  bunBin?: string;
  packageRoot?: () => string | null;
  agentDir?: () => string;
}

const HELPER_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

function helperPath(): string {
  const packageDir = readEnv("PACKAGE_DIR") ?? path.resolve(import.meta.dirname, "../..");
  return path.join(packageDir, "bin", "cody-omp-claude-credits.mjs");
}

/** Why the bridge cannot run here, or null. */
function unavailableReason(deps: ClaudeCreditsBridgeDeps): string | null {
  if (deps.packageRoot) return null;
  if (!resolveOmpBin()) return "OMP runtime is not installed.";
  if (!findOmpPackageRoot()) return "OMP's installed package source is unavailable, so API keys cannot be stored with this installation.";
  return null;
}

function parseJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Run the helper with `request` on stdin. Resolves null when it cannot run or answers nonsense. */
function invoke(request: Record<string, unknown>, deps: ClaudeCreditsBridgeDeps): Promise<Record<string, unknown> | null> {
  const executable = deps.bunBin ?? readEnv("BUN_BIN") ?? "bun";
  const script = deps.helperPath ?? helperPath();
  if (!existsSync(script)) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown> | null>();
  const decoder = new StringDecoder("utf8");
  let stdout = "";
  let child;
  try {
    child = spawn(executable, [script], { stdio: ["pipe", "pipe", "pipe"] });
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
  // Drain diagnostics so the helper can never block on a full pipe; they are never returned.
  child.stderr?.on("data", () => undefined);
  child.once("error", () => finish(null));
  child.once("close", () => finish(parseJson(stdout + decoder.end())));
  // A helper that exits before reading its stdin must not crash this process.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(JSON.stringify(request));
  return promise;
}

function baseRequest(operation: "list" | "add", deps: ClaudeCreditsBridgeDeps): Record<string, unknown> | null {
  const packageRoot = deps.packageRoot?.() ?? findOmpPackageRoot();
  if (!packageRoot) return null;
  return { operation, packageRoot, agentDir: deps.agentDir?.() ?? getAgentDir(), providers: CLAUDE_CREDITS_PROVIDERS };
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The API keys omp holds under the credits providers: ids, providers and last four characters. */
export async function listClaudeApiKeys(deps: ClaudeCreditsBridgeDeps = {}): Promise<ClaudeKeysSnapshot> {
  const reason = unavailableReason(deps);
  const request = reason ? null : baseRequest("list", deps);
  if (reason || !request) return { available: false, keys: [], reason: reason ?? "OMP's installed package source is unavailable." };
  const frame = await invoke(request, deps);
  if (!frame || frame.type !== "list") return { available: false, keys: [], reason: "The key helper did not answer." };
  if (frame.ok !== true) return { available: false, keys: [], reason: safeString(frame.message) ?? "The key list is unavailable." };
  const keys = Array.isArray(frame.keys)
    ? frame.keys.flatMap((row): ClaudeKeyRow[] => {
      const raw = row && typeof row === "object" ? row as Record<string, unknown> : null;
      const id = raw && typeof raw.id === "number" && Number.isSafeInteger(raw.id) ? raw.id : null;
      const last4 = raw ? safeString(raw.last4) : null;
      const provider = raw ? safeString(raw.provider) : null;
      return id !== null && last4 && provider && claudeCreditsSlot(provider) !== null ? [{ id, last4, provider }] : [];
    })
    : [];
  return { available: true, keys };
}

/**
 * Store one API key under `provider`, a credits provider. The caller has already vetted its shape.
 * A key omp already holds under ANY credits provider is not stored twice: the answer names the
 * provider that has it, which may differ from the one asked for.
 */
export async function addClaudeApiKey(key: string, provider: string, deps: ClaudeCreditsBridgeDeps = {}): Promise<ClaudeKeyAddResult> {
  const reason = unavailableReason(deps);
  const request = reason ? null : baseRequest("add", deps);
  if (reason || !request) return { ok: false, code: "unsupported", message: reason ?? "OMP's installed package source is unavailable." };
  const frame = await invoke({ ...request, key, provider }, deps);
  if (!frame || frame.type !== "add") return { ok: false, code: "inconclusive", message: "The key helper did not answer; check the list before trying again." };
  if (frame.ok !== true) return { ok: false, code: safeString(frame.code) ?? "credential_add_failed", message: safeString(frame.message) ?? "The key could not be stored." };
  const id = typeof frame.id === "number" && Number.isSafeInteger(frame.id) ? frame.id : null;
  const last4 = safeString(frame.last4);
  const holder = safeString(frame.provider);
  if (id === null || !last4 || !holder || claudeCreditsSlot(holder) === null) return { ok: false, code: "inconclusive", message: "The key helper answered without a row id." };
  return { ok: true, id, last4, provider: holder };
}
