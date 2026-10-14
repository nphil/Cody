// Seeds a throwaway agent dir with FAKE Claude plan accounts, through omp's own AuthStorage.
// Run under Bun (omp's packages are Bun-only):
//   bun seed-plans.mjs <packageRoot> <agentDir> '<json: { "plans": ["A", "B"] }>'
// Each label becomes one OAuth account whose access token ends in that label, so a fake server
// can tell the accounts apart. Nothing here is a real credential, and nothing touches the network.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, agentDir, spec] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = agentDir;
const require = createRequire(join(packageRoot, "package.json"));
const ai = await import(pathToFileURL(require.resolve("@oh-my-pi/pi-ai/auth-storage.js")).href);
const utils = await import(pathToFileURL(require.resolve("@oh-my-pi/pi-utils/dirs.js")).href);
const { plans = [] } = JSON.parse(spec);

const auth = await ai.AuthStorage.create(utils.getAgentDbPath());
const now = Date.now();
await auth.credentials.set("anthropic", plans.map((label) => ({
  type: "oauth",
  access: `sk-ant-oat01-FAKE-${label}`,
  refresh: `fake-refresh-${label}`,
  expires: now + 48 * 3600e3,
  email: `plan-${label.toLowerCase()}@example.test`,
  accountId: `acct-${label}`,
  orgId: `org-${label}`,
  orgName: `Org ${label}`,
})));
await auth.close();
process.stdout.write(JSON.stringify({ seeded: plans }));
