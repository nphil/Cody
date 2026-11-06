import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createJiti } from "jiti";
import { parse } from "yaml";

const agentDir = mkdtempSync(join(tmpdir(), "cody-local-routing-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CONFIG_FILES = "";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const routing = await jiti.import("./local-model-routing.ts");
const rpc = await jiti.import("./rpc-manager.ts");

function writeModels(localUrl, cloudUrl) {
  writeFileSync(join(agentDir, "models.yml"), [
    "providers:",
    "  local:",
    `    baseUrl: ${localUrl}/v1`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: primary",
    "        contextWindow: 24576",
    "        maxTokens: 8192",
    "      - id: narrow-fallback",
    "        contextWindow: 8192",
    "        maxTokens: 2048",
    "      - id: cloud-override",
    `        baseUrl: ${cloudUrl}/v1`,
    "        contextWindow: 16384",
    "        maxTokens: 4096",
    "  cloud:",
    `    baseUrl: ${cloudUrl}/v1`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: main",
    "        contextWindow: 16384",
    "        maxTokens: 4096",
  ].join("\n"));
}

function writeInheritedCloudRouting() {
  writeFileSync(join(agentDir, "config.yml"), [
    "modelRoles:",
    "  default: cloud/main",
    "  custom-cloud-role: cloud/main",
    "retry:",
    "  enabled: true",
    "  modelFallback: true",
    "  maxRetries: 0",
    "  baseDelayMs: 1",
    "  maxDelayMs: 1",
    "  fallbackChains:",
    "    local/primary: [cloud/main]",
    "    local/*: [cloud/main]",
    "    default: [cloud/main]",
    "    custom-cloud-role: [cloud/main]",
  ].join("\n"));
}

function runOmp(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("omp", args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

test("Local-only replaces inherited cloud roles/chains and serves ordered local fallback without cloud traffic", async (t) => {
  let primaryRequests = 0;
  let fallbackRequests = 0;
  let fallbackToolCount = -1;
  let cloudRequests = 0;
  const local = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const model = JSON.parse(body).model;
    if (model === "primary") {
      primaryRequests += 1;
      response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "primary quota temporarily exhausted", type: "rate_limit_error" } }));
      return;
    }
    assert.equal(model, "narrow-fallback");
    fallbackRequests += 1;
    fallbackToolCount = Array.isArray(JSON.parse(body).tools) ? JSON.parse(body).tools.length : 0;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      id: "local-fallback",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "LOCAL FALLBACK SERVED" }, finish_reason: null }],
    })}\n\n`);
    response.end(`data: ${JSON.stringify({
      id: "local-fallback",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`);
  });
  const cloud = createServer((_request, response) => {
    cloudRequests += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "CLOUD TRAP" } }));
  });
  local.listen(0, "127.0.0.1");
  cloud.listen(0, "127.0.0.1");
  await Promise.all([once(local, "listening"), once(cloud, "listening")]);
  t.after(() => Promise.all([new Promise((resolve) => local.close(resolve)), new Promise((resolve) => cloud.close(resolve))]));

  const localUrl = `http://127.0.0.1:${local.address().port}`;
  // This resolves to the loopback trap only if OMP ever attempts the cloud
  // selector, but it is not itself a private/loopback URL and so cannot pass
  // Local-only endpoint validation by name alone.
  const cloudUrl = `http://cloud.127.0.0.1.nip.io:${cloud.address().port}`;
  writeModels(localUrl, cloudUrl);
  writeInheritedCloudRouting();

  const availability = routing.configuredLocalRoutingModels();
  assert.deepEqual(availability.models.map((model) => model.modelId), ["narrow-fallback", "primary"]);
  assert.throws(() => routing.writeLocalRoutingConfig({
    primary: { provider: "local", modelId: "primary" },
    fallbacks: [{ provider: "local", modelId: "cloud-override" }],
    roles: {},
  }), /not a configured usable local model/);

  routing.writeLocalRoutingConfig({
    primary: { provider: "local", modelId: "primary" },
    fallbacks: [{ provider: "local", modelId: "narrow-fallback" }],
    roles: {},
  });
  const intent = routing.setSessionLocalOnly("local-routing-test", true);
  assert.deepEqual(intent.envelope, { contextWindow: 8192, maxTokens: 2048 }, "the frozen safe envelope is the smaller fallback's actual pair");
  assert.deepEqual(routing.validateLocalRoutingModelSelection("local-routing-test", "local", "narrow-fallback"), { allowed: true });
  const cloudSelection = routing.validateLocalRoutingModelSelection("local-routing-test", "cloud", "main");
  assert.equal(cloudSelection.allowed, false);
  if (!cloudSelection.allowed) assert.match(cloudSelection.reason, /cannot select|frozen local model snapshot/);
  // The picker's view of the same rule: a local pick stays Local-only, a
  // cloud pick has to leave the mode first.
  const allowedModels = routing.localRoutingAllowedModels("local-routing-test");
  assert.ok(allowedModels.includes("local/primary") && allowedModels.includes("local/narrow-fallback"));
  assert.ok(!allowedModels.includes("cloud/main"));
  assert.deepEqual(routing.localRoutingAllowedModels("never-local-routing-test"), []);
  routing.renameSessionLocalRouting("local-routing-test", "real-local-routing-test");
  assert.equal(routing.readLocalRoutingIntent("local-routing-test").enabled, false);
  assert.equal(routing.readLocalRoutingIntent("real-local-routing-test").enabled, true);
  routing.copySessionLocalRouting("real-local-routing-test", "fork-local-routing-test");
  assert.deepEqual(routing.readLocalRoutingIntent("fork-local-routing-test").primary, { provider: "local", modelId: "primary" });
  assert.equal(routing.readLocalRoutingIntent("real-local-routing-test").enabled, true, "forking copies rather than moves the parent snapshot");
  const launch = routing.materializeLocalRoutingOverlay(routing.readLocalRoutingIntent("real-local-routing-test"));
  assert.ok(launch);

  const overlayPath = launch.env.PI_CONFIG_FILES;
  assert.equal(overlayPath, launch.overlayPath);
  const overlay = parse(readFileSync(overlayPath, "utf8"));
  assert.deepEqual(overlay.enabledModels, ["local/primary", "local/narrow-fallback"]);
  assert.equal(overlay.retry.modelFallback, true);
  assert.deepEqual(overlay.retry.fallbackChains["local/primary"], ["local/narrow-fallback"]);
  assert.deepEqual(overlay.retry.fallbackChains["local/narrow-fallback"], []);
  assert.equal(overlay.modelRoles["custom-cloud-role"], null);
  assert.equal(overlay.retry.fallbackChains["local/*"], null);

  const effectiveRoles = await runOmp(["config", "get", "modelRoles", "--json"], { PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_FILES: launch.env.PI_CONFIG_FILES });
  assert.equal(effectiveRoles.code, 0, effectiveRoles.stderr);
  const resolvedRoles = JSON.parse(effectiveRoles.stdout).value;
  assert.equal(resolvedRoles["custom-cloud-role"], null, "the inherited cloud role is tombstoned rather than merged");
  assert.equal(resolvedRoles.default, "local/primary");
  const effectiveChains = await runOmp(["config", "get", "retry.fallbackChains", "--json"], { PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_FILES: launch.env.PI_CONFIG_FILES });
  assert.equal(effectiveChains.code, 0, effectiveChains.stderr);
  const resolvedChains = JSON.parse(effectiveChains.stdout).value;
  assert.equal(resolvedChains["local/*"], null, "the inherited provider wildcard is tombstoned");
  assert.equal(resolvedChains["custom-cloud-role"], null, "the inherited custom-role fallback is tombstoned");
  assert.deepEqual(resolvedChains["local/primary"], ["local/narrow-fallback"]);

  const profile = rpc.launchWithSessionOverlays(undefined, "real-local-routing-test");
  const result = await runOmp(["-p", "--no-tools", "--tools", profile.toolNames.join(","), "--system-prompt", profile.systemPromptPath, "--model=local/primary", "Reply exactly with the success phrase."], { PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_FILES: profile.env.PI_CONFIG_FILES });
  assert.equal(result.code, 0, `${result.stderr}\nprimary requests=${primaryRequests}, fallback requests=${fallbackRequests}, cloud requests=${cloudRequests}`);
  assert.match(result.stdout, /LOCAL FALLBACK SERVED/);
  assert.ok(primaryRequests >= 1, "the configured local primary was attempted");
  assert.equal(fallbackRequests, 1, "a recoverable primary failure reached exactly the configured local fallback");
  assert.equal(fallbackToolCount, 2, "the fallback request used the frozen minimal read+bash tool surface");
  assert.equal(cloudRequests, 0, "no inherited cloud role, exact chain, or wildcard could receive traffic");

  // Later configuration changes do not affect the existing snapshot, while a
  // newly configured empty chain is terminal: it cannot auto-pick another local or cloud model.
  routing.writeLocalRoutingConfig({ primary: { provider: "local", modelId: "primary" }, fallbacks: [], roles: {} });
  assert.deepEqual(routing.readLocalRoutingIntent("real-local-routing-test").primary, { provider: "local", modelId: "primary" });
  const emptyLaunch = routing.materializeLocalRoutingOverlay(routing.setSessionLocalOnly("empty-local-routing-test", true));
  const primaryBeforeEmptyChain = primaryRequests;
  const emptyChainResult = await runOmp(["-p", "--model=local/primary", "Reply exactly with the success phrase."], { PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_FILES: emptyLaunch.env.PI_CONFIG_FILES });
  assert.equal(emptyChainResult.timedOut, false, "an empty configured chain stops with a terminal primary error");
  assert.notEqual(emptyChainResult.code, 0, "an empty configured fallback chain stops at its primary failure");
  assert.ok(primaryRequests > primaryBeforeEmptyChain, "the empty-chain primary was attempted");
  assert.equal(fallbackRequests, 1, "an empty chain did not auto-pick another local model");
  assert.equal(cloudRequests, 0, "an empty chain did not use inherited cloud routing");

  // Without a proven local candidate, Local-only remains a typed unavailable
  // intent and refuses mutation rather than inheriting the cloud configuration.
  writeFileSync(join(agentDir, "models.yml"), [
    "providers:",
    "  cloud:",
    `    baseUrl: ${cloudUrl}/v1`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: main",
    "        contextWindow: 16384",
    "        maxTokens: 4096",
  ].join("\n"));
  const unavailable = routing.readConfiguredLocalRoutingIntent();
  assert.equal(unavailable.enabled, false);
  assert.match(unavailable.error, /No configured usable local model/);
  assert.throws(() => routing.setSessionLocalOnly("no-local-model", true), /No configured usable local model/);
});
