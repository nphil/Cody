// What omp's OWN AuthStorage does with an Anthropic API key stored beside Claude plan accounts of
// the same provider — the fact the whole credits design rests on. Run under Bun:
//   bun probe-cascade.mjs <packageRoot> <agentDir>
// Fake credentials only, a fake usage fetch (nothing leaves the machine), and one
// `RESULT:{json}` line on stdout. Each step asks which credential three different sessions
// would be handed for `anthropic`, as `oauth:<label>`, `api-key:stored` or `api-key:env`.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, agentDir] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = agentDir;
const require = createRequire(join(packageRoot, "package.json"));
const ai = await import(pathToFileURL(require.resolve("@oh-my-pi/pi-ai/auth-storage.js")).href);
const utils = await import(pathToFileURL(require.resolve("@oh-my-pi/pi-utils/dirs.js")).href);

const now = Date.now();
const usage = { five_hour: { utilization: 10, resets_at: new Date(now + 3 * 3600e3).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(now + 5 * 86400e3).toISOString() } };
let usageFetches = 0;
const auth = await ai.AuthStorage.create(utils.getAgentDbPath(), {
  usageFetch: async () => {
    usageFetches += 1;
    return new Response(JSON.stringify(usage), { status: 200, headers: { "content-type": "application/json" } });
  },
});

const MODEL = "claude-opus-5-5";
const ENV_KEY = "sk-ant-api03-FAKE-env-key-9999";
const STORED_KEY = "sk-ant-api03-FAKE-stored-key-8888";
const oauth = (label) => ({ type: "oauth", access: `sk-ant-oat01-FAKE-${label}`, refresh: `fake-refresh-${label}`, expires: now + 24 * 3600e3, email: `plan-${label}@example.test`, accountId: `acct-${label}`, orgId: `org-${label}`, orgName: `Org ${label}` });
await auth.credentials.set("anthropic", [oauth("A"), oauth("B")]);
await auth.credentials.reload();

const describe = (key) => {
  if (key === undefined || key === null) return "none";
  if (key.startsWith("sk-ant-oat01-FAKE-")) return `oauth:${key.slice(-1)}`;
  if (key === STORED_KEY) return "api-key:stored";
  if (key === ENV_KEY) return "api-key:env";
  return "unknown";
};
const picks = async () => [describe(await auth.keys.get("anthropic", "s1", { modelId: MODEL })), describe(await auth.keys.get("anthropic", "s2", { modelId: MODEL })), describe(await auth.keys.get("anthropic", "s3", { modelId: MODEL }))];
const plans = () => auth.credentials.list("anthropic").filter((row) => row.credential.type === "oauth");
const steps = [];

steps.push({ step: "two plan accounts", picks: await picks() });

process.env.ANTHROPIC_API_KEY = ENV_KEY;
steps.push({ step: "plus ANTHROPIC_API_KEY in the environment", picks: await picks() });

await auth.credentials.upsert("anthropic", { type: "api_key", key: STORED_KEY, source: "login" });
await auth.credentials.reload();
steps.push({ step: "plus an api_key row stored under anthropic", picks: await picks(), rows: auth.credentials.list("anthropic").map((row) => row.credential.type) });

// Both plans hit their limit: what a 429 from Anthropic makes omp record against each account.
const marks = [];
for (const row of plans()) {
  const mark = await auth.limits.markReached("anthropic", "s1", { credentialId: row.id, retryAfterMs: 3 * 3600e3, providerTimed: true, modelId: MODEL });
  marks.push({ switched: mark.switched === true });
}
steps.push({ step: "both plans marked limited", picks: await picks(), marks });

// What rotation says when a plan 429s and only the API key remains beside the blocked plans.
const rotation = await auth.limits.rotate("anthropic", "s1", { error: "429 rate_limit_error: you have hit your usage limit", modelId: MODEL });
steps.push({ step: "rotate after a plan's 429", switched: rotation.switched === true, picks: await picks() });

// Only when the plans are GONE does the stored key finally serve.
for (const row of plans()) await auth.credentials.removeById("anthropic", row.id);
await auth.credentials.reload();
steps.push({ step: "plans removed", picks: await picks() });

await auth.close();
process.stdout.write(`RESULT:${JSON.stringify({ steps, usageFetches })}\n`);
