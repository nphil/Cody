import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A REAL omp credential store, seeded through omp's own AuthStorage API, for
 * the tests that must see omp's soft deletes: removing an account leaves a
 * tombstone row (`disabled_cause` set) that a hand-written fixture cannot
 * reproduce, and that is exactly what made Remove answer "no account matching
 * that id". Fake credentials only; the store lives in a throwaway dir.
 */

const SEED_SCRIPT = [
  'import { createRequire } from "node:module";',
  'import { join } from "node:path";',
  'import { pathToFileURL } from "node:url";',
  'const [, , packageRoot, agentDir, stepsJson] = process.argv;',
  'process.env.PI_CODING_AGENT_DIR = agentDir;',
  'const require = createRequire(join(packageRoot, "package.json"));',
  'const ai = await import(pathToFileURL(require.resolve("@oh-my-pi/pi-ai/auth-storage.js")).href);',
  'const utils = await import(pathToFileURL(require.resolve("@oh-my-pi/pi-utils/dirs.js")).href);',
  'const storage = await ai.AuthStorage.create(utils.getAgentDbPath());',
  'await storage.credentials.reload();',
  'const ids = {};',
  'for (const step of JSON.parse(stepsJson)) {',
  '  if (step.op === "upsert") {',
  '    const before = new Set(storage.credentials.list().map((row) => row.id));',
  '    await storage.credentials.upsert(step.provider, step.credential);',
  '    ids[step.as] = storage.credentials.list(step.provider).find((row) => !before.has(row.id))?.id;',
  '  } else if (step.op === "disable") await storage.credentials.disable(ids[step.ref], step.cause);',
  '  else if (step.op === "removeById") await storage.credentials.removeById(step.provider, ids[step.ref]);',
  '}',
  'await storage.close();',
  'process.stdout.write(JSON.stringify(ids));',
].join("\n");

export const oauthCredential = (email) => ({ type: "oauth", access: `fake-access-${email}`, refresh: `fake-refresh-${email}`, expires: Date.now() + 3_600_000, email, accountId: `acct-${email}` });
export const apiKeyCredential = (key) => ({ type: "api_key", key, source: "login" });
/** The cause omp records when a token refresh fails: an account worth showing. */
export const REFRESH_FAILED = "oauth refresh failed: invalid_grant";

/** The first `bun` on PATH, or null. */
export function findBun() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "bun");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The omp package root that owns `bin`, or null. */
export function packageRootOf(bin) {
  let current = fs.realpathSync(bin);
  for (let depth = 0; depth < 8; depth += 1) {
    current = path.dirname(current);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (typeof manifest.name === "string" && manifest.name.includes("pi-coding-agent")) return current;
    } catch {
      // Keep walking.
    }
  }
  return null;
}

/**
 * Seed a fresh store. `steps` run in order; `as` names the credential id an
 * `upsert` created so a later `disable`/`removeById` step can name it:
 *   {op:"upsert", provider, credential, as}   {op:"disable", ref, cause}
 *   {op:"removeById", provider, ref}          (omp's soft delete: "deleted by user")
 * Returns the directory and the `as` → row id map. The caller removes the dir.
 */
export async function seedOmpStore({ bun, packageRoot, steps }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cody-omp-store-"));
  const script = path.join(dir, "seed.mjs");
  fs.writeFileSync(script, SEED_SCRIPT);
  const result = spawnSync(bun, [script, packageRoot, dir, JSON.stringify(steps)], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
  if (result.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`seeding the omp store failed: ${result.stderr}`);
  }
  return { dir, ids: JSON.parse(result.stdout) };
}

/** What is physically in agent.db: id, provider, disabled_cause. */
export function storedRows(dir) {
  const db = new DatabaseSync(path.join(dir, "agent.db"), { readOnly: true });
  try { return db.prepare("SELECT id, provider, disabled_cause FROM auth_credentials ORDER BY id").all(); } finally { db.close(); }
}
