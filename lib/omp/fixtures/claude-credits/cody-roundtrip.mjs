// Cody's REAL key handling against a REAL omp credential store, step by step, in a child process
// (Cody reads its agent dir from the environment, so it cannot share a process with another
// scenario). Run by node:
//   node cody-roundtrip.mjs '<json>'
//   { repoRoot, agentDir, root, baseUrl, keys: [k1, k2, k3] }
// The agent dir already holds two seeded plan accounts. After every step it prints what is
// physically in omp's SQLite store (never a key: last four characters only), Cody's own record and
// which providers models.yml holds, so the test can say what each step did to omp's real data.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";
import { parse } from "yaml";

const spec = JSON.parse(process.argv[2]);
process.env.PI_CODING_AGENT_DIR = spec.agentDir;
process.env.CODY_PACKAGE_DIR = spec.repoRoot;
process.env.PI_CONFIG_FILES = "";
process.env.HOME = spec.root;
process.env.TMPDIR = spec.root;
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;
process.env.ANTHROPIC_API_KEY = "";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const credits = await jiti.import(path.join(spec.repoRoot, "lib/omp/claude-credits.ts"));
const creditsStore = await jiti.import(path.join(spec.repoRoot, "lib/omp/claude-credits-store.ts"));
const deps = { baseUrl: spec.baseUrl };
const [KEY_1, KEY_2, KEY_3] = spec.keys;

function storedRows() {
  const db = new DatabaseSync(path.join(spec.agentDir, "agent.db"), { readOnly: true });
  try {
    return db.prepare("SELECT id, provider, credential_type AS type, disabled_cause AS disabled, data FROM auth_credentials ORDER BY id").all().map((row) => {
      const data = JSON.parse(row.data);
      return { id: row.id, provider: row.provider, type: row.type, disabled: row.disabled, last4: typeof data.key === "string" ? data.key.slice(-4) : null, source: data.source ?? null };
    });
  } finally {
    db.close();
  }
}
const modelsFile = path.join(spec.agentDir, "models.yml");
const providersInModels = () => (existsSync(modelsFile) ? Object.keys(parse(readFileSync(modelsFile, "utf8"))?.providers ?? {}) : []);

const out = { steps: [], statuses: {} };
async function step(name, action) {
  let error = null;
  try {
    await action();
  } catch (thrown) {
    error = { code: thrown.code ?? null, status: thrown.status ?? null };
  }
  out.steps.push({
    name,
    error,
    rows: storedRows(),
    record: creditsStore.readClaudeCreditsStore().map(({ keyId, provider, account }) => ({ keyId, provider, account })),
    providers: providersInModels(),
  });
}

const first = await credits.readClaudeCreditsStatus(true, deps);
if (!first.available) throw new Error(`the credential bridge is unavailable: ${first.reason}`);
const [one, two] = first.accounts;
out.statuses.before = first;

await step("save a key for the first account", () => credits.saveClaudeApiKey(one.accountId, KEY_1, deps));
await step("replace it with another", () => credits.saveClaudeApiKey(one.accountId, KEY_2, deps));
await step("save that same key for the second account", () => credits.saveClaudeApiKey(two.accountId, KEY_2, deps));
await step("save a different key for the second account", () => credits.saveClaudeApiKey(two.accountId, KEY_3, deps));
out.statuses.both = await credits.readClaudeCreditsStatus(true, deps);
await step("remove the first account's key", () => credits.removeClaudeApiKey(out.statuses.both.accounts[0].key.keyId, deps));
// The first provider is free again: the next key saved takes it, ahead of the second account's.
await step("save a new key for the first account", () => credits.saveClaudeApiKey(one.accountId, KEY_1, deps));
out.statuses.refilled = await credits.readClaudeCreditsStatus(true, deps);
await step("remove the second account's key", () => credits.removeClaudeApiKey(out.statuses.refilled.accounts[1].key.keyId, deps));
await step("remove the last key", () => credits.removeClaudeApiKey(out.statuses.refilled.accounts[0].key.keyId, deps));
out.statuses.after = await credits.readClaudeCreditsStatus(true, deps);
process.stdout.write(JSON.stringify(out));
