/**
 * Where Cody finds the OpenRouter key(s) to read the account with.
 *
 * Three stores hold one, and they are NOT interchangeable — the order below is
 * the order the engine itself resolves in, so what Cody reports is what the
 * running agent actually spends:
 *
 *   1. `OPENROUTER_API_KEY` saved in Cody (`cody-provider-keys.json`), which
 *      `engineChildEnv` injects into every engine child. A key typed into
 *      Settings wins, because it is the most recent deliberate choice.
 *   2. The same variable set on the container.
 *   3. omp's OWN credential store. This is the one that matters in practice:
 *      `omp /login openrouter` writes an `api_key` credential into
 *      `<agentDir>/agent.db`, and a user who signed in that way has NO
 *      environment variable anywhere. Reading only the environment would show
 *      "no key configured" to someone whose sessions are billing OpenRouter
 *      right now.
 *
 * The management key is separate and Cody-only (`OPENROUTER_MANAGEMENT_KEY`):
 * omp has no concept of it, it is never handed to an engine child, and it
 * exists purely so the activity and key-management reads can work. Keeping it
 * out of `engineChildEnv` is deliberate — a provisioning-scoped credential has
 * no business being in an agent's environment where its own shell tools could
 * read it.
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import { readProviderKeys } from "../harness/provider-keys";
import { isRecord, asString } from "../type-guards";

export const OPENROUTER_KEY_VARIABLE = "OPENROUTER_API_KEY";
export const OPENROUTER_MANAGEMENT_KEY_VARIABLE = "OPENROUTER_MANAGEMENT_KEY";

/** Which store answered, so the UI can say where the number came from. */
export type OpenRouterKeySource = "cody" | "environment" | "engine";

export interface ResolvedOpenRouterKey {
  key: string;
  source: OpenRouterKeySource;
}

/**
 * omp's credential store, read directly.
 *
 * omp exposes no command that prints a stored key (`get_login_providers`
 * reports only *whether* a provider is authenticated), and there is no reason
 * for one to exist — so a direct read of its SQLite file is the only way to
 * reach a key the user signed in with. Strictly read-only, and every failure
 * is swallowed: an absent file, a schema that moved, a WAL mid-write and a
 * build without `node:sqlite` must all degrade to "no engine key", never to a
 * broken usage meter.
 *
 * ACTIVE rows only (`disabled_cause IS NULL`). omp's remove only soft-deletes:
 * the "deleted by user" row keeps the old key. Without this filter a key the
 * user removed was still found, so Cody kept reading that account's balance
 * and spend, kept an "out of credits" blackout alive for it, and the
 * OpenRouter row in Usage never went away.
 */
function readEngineKey(): string | null {
  const file = path.join(getAgentDir(), "agent.db");
  if (!fs.existsSync(file)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row: unknown = db
      .prepare("SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL ORDER BY id ASC LIMIT 1")
      .get("openrouter");
    if (!isRecord(row)) return null;
    const data = asString(row.data);
    if (!data) return null;
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) return null;
    const key = asString(parsed.key)?.trim();
    return key ? key : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch { /* Already closed or never opened. */ }
  }
}

/** The key Cody should read the account with, and where it came from. */
export function resolveOpenRouterKey(): ResolvedOpenRouterKey | null {
  const stored = readProviderKeys()[OPENROUTER_KEY_VARIABLE]?.trim();
  if (stored) return { key: stored, source: "cody" };
  const fromEnvironment = process.env[OPENROUTER_KEY_VARIABLE]?.trim();
  if (fromEnvironment) return { key: fromEnvironment, source: "environment" };
  const engine = readEngineKey();
  if (engine) return { key: engine, source: "engine" };
  return null;
}

/** The provisioning-scoped key, when the user has added one. Cody-only: it is
 * never injected into an engine child. */
export function resolveOpenRouterManagementKey(): string | null {
  const stored = readProviderKeys()[OPENROUTER_MANAGEMENT_KEY_VARIABLE]?.trim();
  if (stored) return stored;
  const fromEnvironment = process.env[OPENROUTER_MANAGEMENT_KEY_VARIABLE]?.trim();
  return fromEnvironment ? fromEnvironment : null;
}
