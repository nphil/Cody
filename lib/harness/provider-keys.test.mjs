import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Provider keys saved in Settings reach every engine child as environment
 * variables — the one credential path omp, pi, Hermes, Claude Code and Codex
 * all share. Before this, an engine with no key failed silently and the only
 * fix was a terminal inside the container.
 */
const agentDir = mkdtempSync(join(tmpdir(), "cody-provider-keys-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const keys = await jiti.import("./provider-keys.ts");
const { PROVIDER_CATALOG, providersForEngine } = await jiti.import("./provider-catalog.ts");

test("a saved key is stored 0600 in the instance data dir and read back", () => {
  keys.setProviderKey("OPENROUTER_API_KEY", "  sk-or-test  ");
  assert.equal(keys.readProviderKeys().OPENROUTER_API_KEY, "sk-or-test", "whitespace is not part of a key");
  const file = keys.getProviderKeysPath();
  assert.ok(file.startsWith(agentDir), "lives in the instance data dir, never under an engine's own dir");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, "utf8"), /"OPENROUTER_API_KEY"/);
});

test("an empty value clears a key, and an unknown variable is refused", () => {
  keys.setProviderKey("OPENROUTER_API_KEY", "");
  assert.equal(keys.readProviderKeys().OPENROUTER_API_KEY, undefined);
  assert.throws(() => keys.setProviderKey("PATH", "/tmp"), /Unknown provider variable/);
  assert.throws(() => keys.setProviderKey("LD_PRELOAD", "x"), /Unknown provider variable/);
});

test("the child environment is Cody's, then the saved keys, then the caller's own variables", () => {
  keys.setProviderKey("ANTHROPIC_API_KEY", "saved-key");
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "container-key";
  try {
    const env = keys.engineChildEnv({ CLAUDE_CODE_EXECUTABLE: "/tools/bin/claude", DROPPED: undefined });
    // A key saved in Settings is the newer, deliberate choice.
    assert.equal(env.ANTHROPIC_API_KEY, "saved-key");
    // The adapter's own variables still apply on top.
    assert.equal(env.CLAUDE_CODE_EXECUTABLE, "/tools/bin/claude");
    assert.equal("DROPPED" in env, false);
    // Everything else Cody has is passed through.
    assert.equal(env.PI_CODING_AGENT_DIR, agentDir);
    // ACP specs hand their variables over as {name, value} pairs.
    const acp = keys.engineChildEnv([{ name: "CODEX_PATH", value: "/tools/bin/codex" }]);
    assert.equal(acp.CODEX_PATH, "/tools/bin/codex");
    assert.equal(acp.ANTHROPIC_API_KEY, "saved-key");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
    keys.setProviderKey("ANTHROPIC_API_KEY", "");
  }
});

test("describing providers never leaks a value, and says where a key came from", () => {
  keys.setProviderKey("XAI_API_KEY", "xai-secret-value");
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "from-the-container";
  try {
    const described = keys.describeProviders("pi");
    const text = JSON.stringify(described);
    assert.ok(!text.includes("xai-secret-value"), "values must never leave the server");
    assert.ok(!text.includes("from-the-container"));
    const xai = described.find((provider) => provider.id === "xai");
    assert.equal(xai.configured, true);
    assert.deepEqual(xai.variables[0], { name: "XAI_API_KEY", label: "API key", secret: true, stored: true, fromEnvironment: false });
    const deepseek = described.find((provider) => provider.id === "deepseek");
    assert.equal(deepseek.configured, true);
    assert.equal(deepseek.variables[0].fromEnvironment, true);
    assert.equal(deepseek.variables[0].stored, false);
    // Bedrock needs all three before it counts as configured.
    const bedrock = described.find((provider) => provider.id === "bedrock");
    assert.equal(bedrock.variables.length, 3);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
    keys.setProviderKey("XAI_API_KEY", "");
  }
});

test("the catalog names each engine's providers by the variables that engine reads", () => {
  // Claude Code and Codex read exactly one key each; the rest read pi's env map.
  assert.deepEqual(providersForEngine("claude").map((p) => p.id), ["anthropic"]);
  assert.deepEqual(providersForEngine("codex").map((p) => p.id), ["openai"]);
  assert.ok(providersForEngine("pi").length >= 10);
  assert.ok(providersForEngine("hermes").some((p) => p.id === "ollama-cloud"));
  // No two providers claim the same variable, or a saved key would be ambiguous.
  const names = PROVIDER_CATALOG.flatMap((p) => p.variables.map((v) => v.name));
  assert.equal(new Set(names).size, names.length);
});

test("a store rewritten on disk cannot smuggle a variable outside the catalogue into the child environment", () => {
  // The file lives where an engine's own file tools can reach it, so the
  // read side gates names exactly like the write side does.
  writeFileSync(keys.getProviderKeysPath(), JSON.stringify({ version: 1, keys: { PATH: "/tmp/evil", NODE_OPTIONS: "--require /tmp/x.js", OPENAI_API_KEY: "sk-ok" } }));
  const stored = keys.readProviderKeys();
  assert.equal(stored.PATH, undefined);
  assert.equal(stored.NODE_OPTIONS, undefined);
  assert.equal(stored.OPENAI_API_KEY, "sk-ok");
  const env = keys.engineChildEnv();
  assert.notEqual(env.PATH, "/tmp/evil");
  assert.notEqual(env.NODE_OPTIONS, "--require /tmp/x.js");
  keys.setProviderKey("OPENAI_API_KEY", "");
});
