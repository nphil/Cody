// How omp shapes a Messages request for a credential — with NO network: it only builds the client
// options omp would hand its HTTP client, through omp's own `ModelRegistry` and
// `buildAnthropicClientOptions`. Run under Bun:
//   bun probe-shape.mjs <packageRoot> <agentDir> [modelId = claude-opus-5-5]
// `<agentDir>/models.yml` must already hold the credits providers `anthropic-api` and
// `anthropic-api-2` (the test writes them with Cody's own `syncClaudeCreditsProviders`). One fake key
// is stored under each, and each provider's request is shaped on its own. Prints one `RESULT:{json}` line.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, agentDir] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = agentDir;
const require = createRequire(join(packageRoot, "package.json"));
const firstImport = async (candidates) => {
  for (const candidate of candidates) {
    try {
      const resolved = candidate.startsWith("/") ? candidate : require.resolve(candidate);
      if (existsSync(resolved)) return await import(pathToFileURL(resolved).href);
    } catch { /* next */ }
  }
  throw new Error(`none of ${candidates.join(", ")} could be loaded`);
};
const ai = await import(pathToFileURL(require.resolve("@oh-my-pi/pi-ai/auth-storage.js")).href);
const utils = await import(pathToFileURL(require.resolve("@oh-my-pi/pi-utils/dirs.js")).href);
const { ModelRegistry } = await firstImport(["@oh-my-pi/pi-coding-agent/config/model-registry", join(packageRoot, "src/config/model-registry.ts")]);
const { buildAnthropicClientOptions } = await firstImport(["@oh-my-pi/pi-ai/providers/anthropic", join(packageRoot, "node_modules/@oh-my-pi/pi-ai/src/providers/anthropic.ts")]);

const KEYS = { "anthropic-api": "sk-ant-api03-FAKE-shape-key-7777", "anthropic-api-2": "sk-ant-api03-FAKE-shape-key-8888" };
const LOGIN_TOKEN = "sk-ant-oat01-FAKE-login-token-6666";
const auth = await ai.AuthStorage.create(utils.getAgentDbPath());
for (const [provider, key] of Object.entries(KEYS)) await auth.credentials.upsert(provider, { type: "api_key", key, source: "login" });
await auth.credentials.reload();
const registry = new ModelRegistry(auth, join(agentDir, "models.yml"));
await registry.refresh?.("offline");

const summarize = (options) => {
  const headers = options.defaultHeaders ?? {};
  const names = Object.keys(headers);
  const lower = (name) => names.find((key) => key.toLowerCase() === name);
  return {
    apiKeySet: Boolean(options.apiKey),
    authTokenSet: Boolean(options.authToken),
    isOAuthToken: options.isOAuthToken === true,
    baseURL: options.baseURL ?? null,
    headerNames: names.map((name) => name.toLowerCase()).sort(),
    authorization: lower("authorization") ? String(headers[lower("authorization")]).replace(/(Bearer\s+.{12}).*/, "$1…") : null,
    xApiKey: lower("x-api-key") ? String(headers[lower("x-api-key")]).slice(0, 13) : null,
    beta: lower("anthropic-beta") ? String(headers[lower("anthropic-beta")]) : null,
  };
};

const modelId = process.argv[4] ?? "claude-opus-5-5";
const planModel = registry.find("anthropic", modelId);
const result = {
  plan: planModel ? { provider: planModel.provider, id: planModel.id, baseUrl: planModel.baseUrl } : null,
  providers: {},
  loginTokenAsKey: null,
  planToken: null,
};
let firstModel = null;
for (const provider of Object.keys(KEYS)) {
  const model = registry.find(provider, modelId);
  firstModel ??= model;
  const entry = { model: null, resolvedKeyPrefix: null, resolvedKeyLast4: null, shape: null };
  if (model) {
    entry.model = { provider: model.provider, id: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl, officialEndpoint: model.compat?.officialEndpoint ?? null, isOAuth: model.isOAuth ?? null };
    const key = await registry.getApiKey(model, `sess-${provider}`);
    entry.resolvedKeyPrefix = typeof key === "string" ? key.slice(0, 13) : null;
    entry.resolvedKeyLast4 = typeof key === "string" ? key.slice(-4) : null;
    entry.shape = summarize(buildAnthropicClientOptions({ model, apiKey: key, isOAuth: model.isOAuth, hasTools: true, thinkingEnabled: false }));
  }
  result.providers[provider] = entry;
}
if (firstModel) {
  // Why Cody refuses a sign-in token as a "key": omp sniffs the prefix, and would send it as the plan's OAuth.
  result.loginTokenAsKey = summarize(buildAnthropicClientOptions({ model: firstModel, apiKey: LOGIN_TOKEN, isOAuth: firstModel.isOAuth, hasTools: true, thinkingEnabled: false }));
}
if (planModel) {
  result.planToken = summarize(buildAnthropicClientOptions({ model: planModel, apiKey: LOGIN_TOKEN, isOAuth: true, hasTools: true, thinkingEnabled: false }));
}
await auth.close();
process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
