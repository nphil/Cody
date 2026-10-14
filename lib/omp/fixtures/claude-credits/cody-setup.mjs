// Cody's REAL credits modules, run in a child process so a test can set several scenarios up at
// once: Cody reads its agent dir from the environment at call time, so two scenarios in one
// process would trample each other.
//   node cody-setup.mjs '<json>'
//   { repoRoot, agentDir, root, baseUrl, keys: [key for the 1st plan account, for the 2nd, …], layers: [] }
// It saves each key for its plan account through `saveClaudeApiKey` (the real Bun bridges, the real
// AuthStorage, `baseUrl` aiming the credits at the fake) — each key lands in a provider of its own,
// `anthropic-api`, `anthropic-api-2`, … in the order saved — then builds the chat's overlay through
// `materializeClaudeCreditsOverlay`, and prints one JSON line:
//   { status, overlay, providers: [the provider names models.yml holds], chains: the overlay's fallback chains }
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
const overlay = await jiti.import(path.join(spec.repoRoot, "lib/omp/claude-credits-overlay.ts"));

const deps = { baseUrl: spec.baseUrl };
let status = await credits.readClaudeCreditsStatus(true, deps);
if (!status.available) throw new Error(`Cody's credential bridge is unavailable: ${status.reason}`);
for (const [index, key] of spec.keys.entries()) {
  const account = status.accounts[index];
  if (!account) throw new Error(`no plan account #${index + 1} to save a key for`);
  await credits.saveClaudeApiKey(account.accountId, key, deps);
}
status = await credits.readClaudeCreditsStatus(true, deps);
const overlayFile = overlay.materializeClaudeCreditsOverlay(spec.layers ?? []);
const modelsFile = path.join(spec.agentDir, "models.yml");
process.stdout.write(JSON.stringify({
  status,
  overlay: overlayFile,
  providers: existsSync(modelsFile) ? Object.keys(parse(readFileSync(modelsFile, "utf8"))?.providers ?? {}) : [],
  chains: overlayFile ? parse(readFileSync(overlayFile, "utf8"))?.retry?.fallbackChains ?? null : null,
}));
