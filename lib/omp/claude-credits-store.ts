import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { claudeCreditsSlot } from "../claude-credits";
import { isRecord } from "../type-guards";
import { getAgentDir } from "./paths";

/**
 * Which Claude plan account each saved API key belongs to.
 *
 * omp's credential store holds the keys themselves (under `anthropic-api`) but
 * a stored API key carries no label, so "this key is Nitin's second account's"
 * is Cody's own record. It holds NO secret — a row id, the account's identity
 * text and a date — so a leak of this file leaks nothing spendable. The pairing
 * is for people (whose credits are these?); omp's routing never reads it.
 *
 * Bounded by construction: at most one entry per saved key, and an entry whose
 * key omp no longer holds is dropped on the next read of the status.
 */

export interface StoredClaudeKey {
  /** omp's credential row id for the API key. */
  keyId: number;
  /** The credits provider the key lives under (`anthropic-api`, `anthropic-api-2`, …). Routing reads it
   * here, without starting omp, to know which providers to put in the fallback chains. */
  provider: string;
  /** The plan account's identity (email, else organisation) when it was saved. */
  account: string;
  addedAt: string;
}

const FILE_NAME = "cody-claude-credits.json";

export function getClaudeCreditsStorePath(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

export function readClaudeCreditsStore(): StoredClaudeKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getClaudeCreditsStorePath(), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) return [];
  const seen = new Set<number>();
  const keys: StoredClaudeKey[] = [];
  for (const entry of parsed.keys) {
    if (!isRecord(entry)) continue;
    const { keyId, provider, account, addedAt } = entry;
    if (typeof keyId !== "number" || !Number.isSafeInteger(keyId) || seen.has(keyId)) continue;
    if (typeof provider !== "string" || claudeCreditsSlot(provider) === null) continue;
    if (typeof account !== "string" || !account || typeof addedAt !== "string") continue;
    seen.add(keyId);
    keys.push({ keyId, provider, account, addedAt });
  }
  return keys;
}

/** Atomic replace, 0600: a crash mid-write can never truncate the file. */
export function writeClaudeCreditsStore(keys: readonly StoredClaudeKey[]): void {
  const target = getClaudeCreditsStorePath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}
