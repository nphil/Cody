import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp-test-package.mjs";
import { startLab } from "./fixtures/model-controls/rpc-lab.mjs";

/**
 * A chat that is restarted inside the provider's prompt-cache lifetime must send the SAME request prefix it sent
 * before (the system blocks, the tool list, every earlier message), or the provider re-writes the whole chat into
 * its cache at twice the price of reading it. Measured on real chats: a restart that changed the tool roster
 * (the browser's open_url / notify / open_file present at one start, absent at the next) re-wrote the chat every time.
 *
 * Proven here on a real engine against a fake Anthropic server, with Cody's own extensions and launch-default layers,
 * and with the roster read from Cody's own session wrapper (what it publishes with and without a browser attached).
 * Only the SHAPE is asserted (blocks, tool names and schemas, message prefix), never a provider's wording.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const { BROWSER_HOST_TOOLS, BROWSER_HOST_URI_SCHEMES } = await jiti.import("../browser-host-tools.ts");

const here = path.dirname(new URL(import.meta.url).pathname);
const EXTENSIONS = ["cody-refusal-guard", "cody-local-time", "cody-homelabber-gate", "cody-disk-budget", "cody-context-budget", "cody-on-demand-mcp", "cody-agent-switch", "cody-run-on-worker"];
const LAYERS = ["cody-launch-defaults.yml", "cody-launch-defaults-async-widgets.yml", "cody-launch-defaults-computer.yml", "cody-launch-defaults-intent-tracing.yml", "cody-launch-defaults-cross-instance.yml"];
const launch = () => ({
  args: EXTENSIONS.flatMap((name) => ["--extension", path.join(here, "extensions", `${name}.ts`)]),
  env: { PI_CONFIG_FILES: LAYERS.map((file) => path.join(here, file)).join(path.delimiter) },
});

/** What Cody's session wrapper hands a freshly started engine child, optionally after a browser registered its own tools. */
async function publishedRoster({ browserAttached }) {
  const commands = [];
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      onFrame: () => () => {},
      waitReady: async () => ({}),
      negotiateProtocol: async () => {},
      sendCommand: async (command) => {
        commands.push(command);
        return command.type === "get_state" ? { id: "roster-probe" } : {};
      },
    },
    process.cwd(),
    { rpcUi: { hostTools: true }, label: "omp", relaunch: () => ({}) },
  );
  try {
    await wrapper.waitUntilReady();
    if (browserAttached) {
      await wrapper.send({ type: "set_host_tools", tools: BROWSER_HOST_TOOLS });
      await wrapper.send({ type: "set_host_uri_schemes", schemes: BROWSER_HOST_URI_SCHEMES });
    }
    const last = (type) => commands.filter((command) => command.type === type).at(-1);
    return { tools: last("set_host_tools")?.tools ?? [], schemes: last("set_host_uri_schemes")?.schemes ?? [] };
  } finally {
    await wrapper.destroyAndWait();
  }
}

test("a chat with no browser attached advertises the same host tools as one with a browser", async () => {
  const without = await publishedRoster({ browserAttached: false });
  const withBrowser = await publishedRoster({ browserAttached: true });
  assert.deepEqual(without, withBrowser);
  const names = without.tools.map((tool) => tool.name);
  for (const tool of BROWSER_HOST_TOOLS) assert.ok(names.includes(tool.name), `${tool.name} is advertised without a browser`);
  assert.deepEqual(without.schemes.map((entry) => entry.scheme), BROWSER_HOST_URI_SCHEMES.map((entry) => entry.scheme));
});

test("a browser registering fewer or different tools never shrinks the roster, extras are added after the fixed tools", async () => {
  const commands = [];
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      onFrame: () => () => {},
      waitReady: async () => ({}),
      negotiateProtocol: async () => {},
      sendCommand: async (command) => {
        commands.push(command);
        return command.type === "get_state" ? { id: "roster-extra" } : {};
      },
    },
    process.cwd(),
    { rpcUi: { hostTools: true }, label: "omp", relaunch: () => ({}) },
  );
  try {
    await wrapper.waitUntilReady();
    await wrapper.send({ type: "set_host_tools", tools: [] });
    await wrapper.send({ type: "set_host_tools", tools: [{ name: "my_tool", description: "x", parameters: { type: "object" } }] });
    const roster = commands.filter((command) => command.type === "set_host_tools").at(-1).tools.map((tool) => tool.name);
    assert.deepEqual(roster.slice(0, BROWSER_HOST_TOOLS.length), BROWSER_HOST_TOOLS.map((tool) => tool.name));
    assert.ok(roster.includes("my_tool"));
  } finally {
    await wrapper.destroyAndWait();
  }
});

// ---- a real engine -------------------------------------------------------------------------------------------

const bin = ompTestPackageBin();
const realSkip = ompTestPackageSkip();

const stripCache = (value) => {
  if (Array.isArray(value)) return value.map(stripCache);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, entry]) => [key, stripCache(entry)]));
  return value;
};
/** The per-request billing header changes on every request by design; it is not part of what the cache keys on in practice. */
const system = (body) => stripCache(body.system).map((block) => ({ ...block, text: block.text.replace(/cch=[0-9a-f]+/g, "cch=*") }));
const tools = (body) => stripCache(body.tools);
/** A stored message is a plain string in one request and a one-block array in the next; same words either way. */
const messages = (body) => stripCache(body.messages).map((message) => ({ ...message, content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content }));

/** Two prompts with an engine restart between them; the second child is handed `rosterAfterRestart` before its prompt. */
async function runAcrossRestart({ rosterBefore, rosterAfterRestart }) {
  const { args, env } = launch();
  const lab = await startLab(bin, { args, env });
  try {
    const publish = async (roster) => {
      await lab.send({ type: "set_host_tools", tools: roster.tools });
      if (roster.schemes.length) await lab.send({ type: "set_host_uri_schemes", schemes: roster.schemes });
    };
    let from = lab.frames.length;
    await publish(rosterBefore);
    await lab.send({ type: "prompt", message: "first message" });
    await lab.settled({ from });
    const file = (await lab.state()).sessionFile;
    await lab.restart({ resume: file });
    from = lab.frames.length;
    await publish(rosterAfterRestart);
    await lab.send({ type: "prompt", message: "second message, after the restart" });
    await lab.settled({ from });
    const requests = lab.mock.requests.map((request) => request.body);
    assert.equal(requests.length, 2);
    return requests;
  } finally {
    await lab.stop();
  }
}

test("a real engine restarted with no browser attached sends the same prefix it sent with one", { skip: realSkip, timeout: 240_000 }, async () => {
  const [before, after] = await runAcrossRestart({
    rosterBefore: await publishedRoster({ browserAttached: true }),
    rosterAfterRestart: await publishedRoster({ browserAttached: false }),
  });
  assert.deepEqual(system(after), system(before));
  assert.deepEqual(tools(after), tools(before));
  assert.deepEqual(messages(after).slice(0, messages(before).length), messages(before));
});

// The control proves the lab can see the failure at all. omp decides at the first request AFTER A RESTART whether a tool
// the new child lacks is folded into its prompt or only announced, which depends on timing (that is why real chats
// flipped only some of the time), so the control compares two fresh engines that were handed the two rosters instead:
// that is deterministic. A fresh engine announces tools published after launch inside the opening message, so the
// control looks at the messages as well as the system blocks and tools.
test("control: the roster Cody used to publish with no browser attached DOES change the prefix (the lab sees the failure)", { skip: realSkip, timeout: 240_000 }, async () => {
  const withBrowser = await publishedRoster({ browserAttached: true });
  const browserNames = new Set(BROWSER_HOST_TOOLS.map((tool) => tool.name));
  const oldWithoutBrowser = { tools: withBrowser.tools.filter((tool) => !browserNames.has(tool.name)), schemes: [] };
  const firstRequest = async (roster) => {
    const { args, env } = launch();
    const lab = await startLab(bin, { args, env });
    try {
      await lab.send({ type: "set_host_tools", tools: roster.tools });
      const from = lab.frames.length;
      await lab.send({ type: "prompt", message: "first message" });
      await lab.settled({ from });
      return lab.mock.requests[0].body;
    } finally {
      await lab.stop();
    }
  };
  const [before, after] = [await firstRequest(withBrowser), await firstRequest(oldWithoutBrowser)];
  const shape = (body) => JSON.stringify([system(body), tools(body), messages(body)]);
  assert.notEqual(shape(after), shape(before), "a roster without the browser tools reads differently to the model");
});
