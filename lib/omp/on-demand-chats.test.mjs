import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

// Per-chat toolset state is `<agent dir>/cody-on-demand-chats.json`, and
// `computer.enabled` is read from `<agent dir>/config.yml`: temp agent dir first.
const agentDir = mkdtempSync(join(tmpdir(), "cody-ondemand-chats-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const loadChats = () => createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, fsCache: false }).import("./on-demand-chats.ts");
const chats = await loadChats();
const { ON_DEMAND_COMPUTER_ENV, ON_DEMAND_REGISTRY_ENV } = await createJiti(import.meta.url).import("../on-demand-mcp/registry.ts");

const root = resolve(import.meta.dirname, "..", "..");
const storePath = join(agentDir, "cody-on-demand-chats.json");
const configPath = join(agentDir, "config.yml");
const readStoreFile = () => JSON.parse(readFileSync(storePath, "utf8"));

beforeEach(() => {
  for (const name of readdirSync(agentDir)) rmSync(join(agentDir, name), { recursive: true, force: true });
});

test("nothing stored: no toolsets, and a missing or invalid session id reads as empty", () => {
  assert.deepEqual(chats.readSessionToolsets("chat-1"), []);
  assert.deepEqual(chats.readSessionToolsets(undefined), []);
  assert.deepEqual(chats.readSessionToolsets(""), []);
  assert.deepEqual(chats.readSessionToolsets("bad\nid"), []);
});

test("set reports whether anything changed, stores per chat, and survives a restart (fresh module, same disk)", async () => {
  assert.equal(chats.setSessionToolset("chat-1", "computer", true), true);
  assert.equal(chats.setSessionToolset("chat-1", "computer", true), false, "already on");
  assert.equal(chats.setSessionToolset("chat-2", "computer", false), false, "already off");
  assert.deepEqual(readStoreFile(), { version: 1, sessions: { "chat-1": ["computer"] } });

  const restarted = await loadChats();
  assert.notEqual(restarted, chats);
  assert.deepEqual(restarted.readSessionToolsets("chat-1"), ["computer"]);
  assert.deepEqual(restarted.readSessionToolsets("chat-2"), []);

  assert.equal(restarted.setSessionToolset("chat-1", "computer", false), true);
  assert.deepEqual(chats.readSessionToolsets("chat-1"), []);
  assert.deepEqual(readStoreFile().sessions, {}, "an empty entry is dropped, not kept as []");
});

test("only known toolsets and valid ids are accepted on write", () => {
  assert.throws(() => chats.setSessionToolset("chat-1", "rea", true), /not a toolset a chat can switch on here/);
  assert.throws(() => chats.setSessionToolset("", "computer", true), /Invalid session id/);
  assert.throws(() => chats.setSessionToolset("a\u0000b", "computer", true), /Invalid session id/);
  assert.throws(() => chats.setSessionToolset("x".repeat(513), "computer", true), /Invalid session id/);
  assert.equal(chats.setSessionToolset("x".repeat(512), "computer", true), true);
});

test("rename moves a chat's state to its real session id and leaves other chats alone", () => {
  chats.setSessionToolset("pre-spawn", "computer", true);
  chats.setSessionToolset("other", "computer", true);
  chats.renameSessionToolsets("pre-spawn", "real-id");
  assert.deepEqual(chats.readSessionToolsets("pre-spawn"), []);
  assert.deepEqual(chats.readSessionToolsets("real-id"), ["computer"]);
  assert.deepEqual(chats.readSessionToolsets("other"), ["computer"]);
  // no-ops: same id, unknown source, invalid ids
  chats.renameSessionToolsets("real-id", "real-id");
  chats.renameSessionToolsets("ghost", "elsewhere");
  chats.renameSessionToolsets("", "x");
  chats.renameSessionToolsets("x", "");
  assert.deepEqual(Object.keys(readStoreFile().sessions).sort(), ["other", "real-id"]);
});

test("copy gives a fork what its parent had; the parent keeps it; later changes are independent", () => {
  chats.setSessionToolset("parent", "computer", true);
  chats.copySessionToolsets("parent", "fork");
  assert.deepEqual(chats.readSessionToolsets("fork"), ["computer"]);
  assert.deepEqual(chats.readSessionToolsets("parent"), ["computer"]);
  chats.setSessionToolset("fork", "computer", false);
  assert.deepEqual(chats.readSessionToolsets("parent"), ["computer"]);
  chats.copySessionToolsets("nothing-here", "fork2");
  assert.deepEqual(chats.readSessionToolsets("fork2"), []);
});

test("forget drops one chat only and is harmless for an unknown chat", () => {
  chats.setSessionToolset("a", "computer", true);
  chats.setSessionToolset("b", "computer", true);
  chats.forgetSessionToolsets("a");
  chats.forgetSessionToolsets("never-existed");
  chats.forgetSessionToolsets("");
  assert.deepEqual(readStoreFile().sessions, { b: ["computer"] });
});

test("a corrupt or foreign store reads as empty, and unknown toolsets and bad entries in it are ignored", () => {
  for (const content of ["{nope", "[]", '{"sessions":[]}', ""]) {
    writeFileSync(storePath, content);
    assert.deepEqual(chats.readSessionToolsets("a"), [], content);
  }
  writeFileSync(storePath, JSON.stringify({ version: 1, sessions: { a: ["computer", "computer", "rea", 5], b: "computer", c: [], "d\ne": ["computer"], f: ["computer"] } }));
  assert.deepEqual(chats.readSessionToolsets("a"), ["computer"]);
  assert.deepEqual(chats.readSessionToolsets("b"), []);
  assert.deepEqual(chats.readSessionToolsets("c"), []);
  assert.deepEqual(chats.readSessionToolsets("f"), ["computer"]);
  // a write rebuilds the file from the valid part
  chats.setSessionToolset("g", "computer", true);
  assert.deepEqual(readStoreFile().sessions, { a: ["computer"], f: ["computer"], g: ["computer"] });
});

test("computerIsOnDemand: config.yml absent, false, unset or invalid is on demand; true is not", () => {
  assert.equal(chats.computerIsOnDemand(), true, "no config.yml");
  writeFileSync(configPath, "computer:\n  enabled: false\n");
  assert.equal(chats.computerIsOnDemand(), true);
  writeFileSync(configPath, "theme: dark\n");
  assert.equal(chats.computerIsOnDemand(), true);
  writeFileSync(configPath, "computer:\n  enabled: \"yes\"\n");
  assert.equal(chats.computerIsOnDemand(), true, "only a real boolean true opts out");
  writeFileSync(configPath, "computer: [unclosed\n");
  assert.equal(chats.computerIsOnDemand(), true, "unreadable YAML does not break launching");
  writeFileSync(configPath, "computer:\n  enabled: true\n");
  assert.equal(chats.computerIsOnDemand(), false);
});

test("computerLayerPath points at the layer beside the module", () => {
  assert.equal(chats.computerLayerPath("/app"), join("/app", "lib", "omp", "cody-on-demand-computer-on.yml"));
  assert.match(readFileSync(chats.computerLayerPath(root), "utf8"), /computer:\s*\n\s+enabled: true/);
});

test("onDemandLaunch: a chat that has not switched computer on is offered it ('off'), no layer", () => {
  const launch = chats.onDemandLaunch("chat-1", root);
  assert.deepEqual(launch.env, { [ON_DEMAND_REGISTRY_ENV]: join(agentDir, "cody-on-demand-mcp.json"), [ON_DEMAND_COMPUTER_ENV]: "off" });
  assert.equal(launch.layer, undefined);
  assert.equal(launch.computerLayer, join(root, "lib", "omp", "cody-on-demand-computer-on.yml"));
});

test("onDemandLaunch: a chat that switched computer on gets 'on' and the per-chat layer; other chats stay off", () => {
  chats.setSessionToolset("chat-1", "computer", true);
  const on = chats.onDemandLaunch("chat-1", root);
  assert.equal(on.env[ON_DEMAND_COMPUTER_ENV], "on");
  assert.equal(on.layer, on.computerLayer);
  assert.equal(on.layer, join(root, "lib", "omp", "cody-on-demand-computer-on.yml"));
  assert.equal(chats.onDemandLaunch("chat-2", root).env[ON_DEMAND_COMPUTER_ENV], "off");
  assert.equal(chats.onDemandLaunch("chat-2", root).layer, undefined);
});

test("onDemandLaunch: when config.yml keeps computer on for every chat, only the registry path is passed", () => {
  writeFileSync(configPath, "computer:\n  enabled: true\n");
  chats.setSessionToolset("chat-1", "computer", true);
  const launch = chats.onDemandLaunch("chat-1", root);
  assert.deepEqual(launch.env, { [ON_DEMAND_REGISTRY_ENV]: join(agentDir, "cody-on-demand-mcp.json") });
  assert.equal(launch.layer, undefined);
});

test("onDemandLaunch: without the layer file (a package that lacks it) desktop control is not offered at all", () => {
  const bare = mkdtempSync(join(tmpdir(), "cody-ondemand-bare-"));
  try {
    mkdirSync(join(bare, "lib", "omp"), { recursive: true });
    chats.setSessionToolset("chat-1", "computer", true);
    const launch = chats.onDemandLaunch("chat-1", bare);
    assert.deepEqual(Object.keys(launch.env), [ON_DEMAND_REGISTRY_ENV]);
    assert.equal(launch.layer, undefined);
    assert.equal(launch.computerLayer, join(bare, "lib", "omp", "cody-on-demand-computer-on.yml"));
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
