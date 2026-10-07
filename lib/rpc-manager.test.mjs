import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, WebRpcError, alignSessionTimeZone, buildEngineRpcLaunch, buildSessionSpawnArgs, getRpcSession, getSessionTimeZone, guardHostToolResultFrame, launchWithSessionOverlays, startRpcSession } = await jiti.import("./rpc-manager.ts");
const routing = jiti("./local-model-routing.ts");
function createDeliveryHarness(commandHandler, engine = {}) {
  let onFrame = () => {};
  const events = [];
  const frames = [];
  let sequence = 0;
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame(listener) { onFrame = listener; return () => { onFrame = () => {}; }; },
    sendFrame(frame) { frames.push(frame); },
    sendCommandWithId(command) {
      const id = `rpc-${++sequence}`;
      return commandHandler ? commandHandler(command, id) : { id, result: Promise.resolve({ agentInvoked: true }) };
    },
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: {}, label: "omp", relaunch: () => ({}), ...engine });
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, events, frames, emitFrame: (event) => onFrame(event) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
test("Local-only rejects an out-of-snapshot set_model before the RPC process mutates", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "cody-rpc-local-routing-"));
  const sent = [];
  let wrapper;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "models.yml"), [
      "providers:",
      "  local:",
      "    baseUrl: http://127.0.0.1:9999/v1",
      "    auth: none",
      "    api: openai-completions",
      "    models:",
      "      - id: primary",
      "        contextWindow: 24576",
      "        maxTokens: 8192",
      "      - id: fallback",
      "        contextWindow: 8192",
      "        maxTokens: 2048",
    ].join("\n"));
    routing.writeLocalRoutingConfig({
      primary: { provider: "local", modelId: "primary" },
      fallbacks: [{ provider: "local", modelId: "fallback" }],
      roles: {},
    });
    routing.setSessionLocalOnly("mixed-local-routing", true);
    const mixedLaunch = launchWithSessionOverlays(undefined, "mixed-local-routing");
    assert.equal(mixedLaunch.profileId, "minimal", "a mixed Local-only process uses the fallback-safe prompt profile");
    assert.deepEqual(mixedLaunch.toolNames, ["read", "bash"], "the fallback-safe launch keeps only the minimal tool surface");
    const [profileOverlayPath] = mixedLaunch.env.PI_CONFIG_FILES.split(":");
    const profileOverlay = parse(await readFile(profileOverlayPath, "utf8"));
    assert.deepEqual(profileOverlay.compaction, {
      enabled: true,
      thresholdTokens: 4916,
      reserveTokens: 1345,
      keepRecentTokens: 256,
      v2RetainedMessageBudget: 256,
      methodOrder: ["soft"],
      autoContinue: true,
      midTurnEnabled: true,
    }, "the emitted OMP overlay is calculated from the 8k/2k fallback envelope");

    routing.writeLocalRoutingConfig({ primary: { provider: "local", modelId: "primary" }, fallbacks: [], roles: {} });
    routing.setSessionLocalOnly("guarded-set-model", true);

    wrapper = new AgentSessionWrapper(
      { isAlive: true, dispose: async () => {}, sendCommand: async (command) => { sent.push(command); return { provider: "local", id: "primary" }; } },
      process.cwd(),
      { rpcUi: { commands: new Set(["set_model"]) }, label: "omp", relaunch: () => ({}) },
    );
    wrapper._sessionId = "guarded-set-model";
    await assert.rejects(
      wrapper.send({ type: "set_model", provider: "local", modelId: "fallback" }),
      (error) => error instanceof WebRpcError && error.code === "local_routing_forbidden",
    );
    assert.deepEqual(sent, [], "the forbidden model never reaches the process wrapper");
  } finally {
    await wrapper?.destroyAndWait();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("withPresetOverlay keeps the instance's own PI_CONFIG_FILES layers instead of dropping them for a preset overlay", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousConfigFiles = process.env.PI_CONFIG_FILES;
  const agentDir = mkdtempSync(join(tmpdir(), "cody-rpc-preset-overlay-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CONFIG_FILES = "/instance/base.yml";
    const store = await jiti.import("./model-presets/store.ts");
    const overlay = await jiti.import("./model-presets/overlay.ts");
    const preset = store.updatePreset("high", { roles: { default: "openai-codex/gpt-6-sol:high" } });
    overlay.setSessionPreset("preset-overlay-inherit-test", preset.id);
    const presetOverlayPath = overlay.materializePresetOverlay(store.getPreset(preset.id));

    // A cloud-model profile carries no env at all — materializeLocalModelProfile
    // returns a bare `{ profileId: "full" }` for it (lib/local-model-profile-runtime.ts).
    // withPresetOverlay must still find the instance's own PI_CONFIG_FILES
    // through process.env, not just through profile.env.
    const launch = launchWithSessionOverlays({ profileId: "full" }, "preset-overlay-inherit-test");
    const configFiles = launch.env.PI_CONFIG_FILES.split(":");
    assert.ok(configFiles.includes("/instance/base.yml"), "the instance's own PI_CONFIG_FILES layer must survive");
    assert.ok(configFiles.includes(presetOverlayPath), "the preset's own overlay is still appended");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousConfigFiles === undefined) delete process.env.PI_CONFIG_FILES;
    else process.env.PI_CONFIG_FILES = previousConfigFiles;
  }
});

test("resumed minimal sessions clear registered host tools before their first turn", async () => {
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
        return command.type === "get_state" ? { id: "resumed-minimal" } : {};
      },
    },
    process.cwd(),
    { rpcUi: { hostTools: true }, label: "omp", relaunch: () => ({}) },
  );
  wrapper.localProfileLaunch = { profileId: "minimal" };
  try {
    await wrapper.waitUntilReady();
    assert.deepEqual(commands.find((command) => command.type === "set_host_tools"), { type: "set_host_tools", tools: [] });
  } finally {
    await wrapper.destroyAndWait();
  }
});

test("a prompt the child never acks is bounded: the wrapper is recycled and reports session_unresponsive", async () => {
  const { RpcCommandTimeoutError } = await jiti.import("./omp/rpc-process.ts");
  let disposed = 0;
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => { disposed += 1; },
      onFrame: () => () => {},
      // The real RpcProcess rejects with this once `timeoutMs` elapses; a fake
      // that honours the argument keeps the test off the 30 s clock.
      sendCommand: async (command, timeoutMs) => {
        if (command.type === "prompt") throw new RpcCommandTimeoutError(command.type, timeoutMs);
        return {};
      },
    },
    process.cwd(),
    { rpcUi: {}, label: "omp", relaunch: () => ({}) },
  );
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "hello" }),
    (error) => error instanceof WebRpcError && error.code === "session_unresponsive",
  );
  assert.equal(wrapper.isRunning(), false, "a run nobody will ever report must not stay busy");
  assert.equal(disposed, 1, "the wedged child is recycled");
});

test("an idle streamingBehavior prompt marks the wrapper running exactly like a plain prompt", async () => {
  const sent = [];
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      sendCommand: async (command) => {
        sent.push(command);
        return {};
      },
    },
    process.cwd(),
    { rpcUi: {}, label: "omp", relaunch: () => ({}) },
  );
  try {
    assert.equal(wrapper.isRunning(), false, "a fresh wrapper starts idle");
    const result = await wrapper.send({
      type: "prompt",
      message: "hello",
      streamingBehavior: "steer",
      clientMessageId: "cmid-1",
    });
    assert.deepEqual(result, { delivery: "started", clientMessageId: "cmid-1" });
    assert.equal(wrapper.isRunning(), true, "an idle streamingBehavior prompt starts a run exactly like a plain prompt");
    // clientMessageId is Cody-side bookkeeping only — it must never reach omp.
    assert.deepEqual(sent, [{ type: "prompt", message: "hello", streamingBehavior: "steer" }]);
  } finally {
    await wrapper.destroyAndWait();
  }
});

test("a repeat clientMessageId rejoins the first outcome instead of sending to omp a second time", async () => {
  let sendCount = 0;
  let resolveSend;
  const sendPromise = new Promise((resolve) => { resolveSend = resolve; });
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      sendCommand: async (command) => {
        if (command.type === "prompt") {
          sendCount += 1;
          return sendPromise;
        }
        return {};
      },
    },
    process.cwd(),
    { rpcUi: {}, label: "omp", relaunch: () => ({}) },
  );
  try {
    const first = wrapper.send({ type: "prompt", message: "hi", streamingBehavior: "steer", clientMessageId: "dup-1" });
    const second = wrapper.send({ type: "prompt", message: "hi", streamingBehavior: "steer", clientMessageId: "dup-1" });
    assert.equal(sendCount, 1, "a second send with the same clientMessageId must not reach omp a second time");
    resolveSend({ agentInvoked: true });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, { delivery: "started", clientMessageId: "dup-1" });
    assert.deepEqual(secondResult, firstResult, "the repeat call gets the exact same settled outcome");
  } finally {
    await wrapper.destroyAndWait();
  }
});

test("a message sent mid-run is held without touching the child, and its slow hand-over never recycles it", async () => {
  let disposed = 0;
  let resolveSend;
  const sendPromise = new Promise((resolve) => { resolveSend = resolve; });
  const timeouts = [];
  let onFrame = () => {};
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => { disposed += 1; },
      onFrame(listener) { onFrame = listener; return () => {}; },
      sendCommandWithId: (command, timeoutMs) => {
        if (command.type === "prompt") timeouts.push(timeoutMs);
        return { id: "rpc-slow", result: command.type === "prompt" ? sendPromise : Promise.resolve({}) };
      },
      sendCommand: async () => ({}),
    },
    process.cwd(),
    { rpcUi: {}, label: "omp", relaunch: () => ({}) },
  );
  wrapper.start();
  try {
    // An already-running turn, by the wrapper's own state.
    wrapper.promptRunning = true;
    const ack = await wrapper.send({ type: "prompt", message: "keep going", streamingBehavior: "followUp", clientMessageId: "slow-1" });
    assert.equal(ack.held, true);
    assert.deepEqual(timeouts, [], "held: nothing has reached the engine yet");

    // The run ends; the held follow-up is handed over and its ack is slow.
    onFrame({ type: "agent_end", isTerminal: true, messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(timeouts, [undefined], "a hand-over never carries the idle ack-recycle timeout");
    assert.equal(disposed, 0, "a slow ack never recycles the child");
    assert.equal(wrapper.isAlive(), true);
    resolveSend({});
  } finally {
    wrapper.destroy();
  }
});

test("a rejected send is evicted from the clientMessageId cache so a retry with the same id reaches the child again", async () => {
  let attempts = 0;
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      sendCommand: async (command) => {
        if (command.type === "prompt") {
          attempts += 1;
          if (attempts === 1) throw new Error("transient failure");
          return { agentInvoked: true };
        }
        return {};
      },
    },
    process.cwd(),
    { rpcUi: {}, label: "omp", relaunch: () => ({}) },
  );
  try {
    await assert.rejects(
      wrapper.send({ type: "prompt", message: "hi", streamingBehavior: "steer", clientMessageId: "retry-1" }),
      /transient failure/,
    );
    assert.equal(attempts, 1, "the first attempt reached the child once");
    // The wrapper survives a restart() (only this.proc is swapped); a
    // rejected outcome must never be remembered for the rest of the TTL or a
    // retry — automatic or manual — could never actually resend the message.
    const result = await wrapper.send({ type: "prompt", message: "hi", streamingBehavior: "steer", clientMessageId: "retry-1" });
    assert.equal(attempts, 2, "a retry with the same clientMessageId must reach the child again after the first attempt failed");
    assert.deepEqual(result, { delivery: "started", clientMessageId: "retry-1" });
  } finally {
    await wrapper.destroyAndWait();
  }
});

test("a streamingBehavior send whose ack never lands does not destroy the child, even when the wrapper looks idle", async () => {
  let disposed = 0;
  let resolveSend;
  const sendPromise = new Promise((resolve) => { resolveSend = resolve; });
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => { disposed += 1; },
      sendCommand: async (command, timeoutMs) => {
        if (command.type === "prompt") {
          assert.equal(timeoutMs, undefined, "a streamingBehavior prompt must never carry the ack-recycle timeout, idle-looking or not");
          return sendPromise;
        }
        return {};
      },
    },
    process.cwd(),
    { rpcUi: {}, label: "omp", relaunch: () => ({}) },
  );
  try {
    // The wrapper reads idle — exactly the race window between one turn's
    // agent_end and the agent_start of a queued follow-up it auto-continues,
    // where the tracked flags lag the child's real state. A streamingBehavior
    // send here must never be recycled just because the flags read idle.
    assert.equal(wrapper.isRunning(), false);
    const raced = await Promise.race([
      wrapper.send({ type: "prompt", message: "hi", streamingBehavior: "followUp", clientMessageId: "idle-race-1" }).then(() => "settled"),
      new Promise((resolve) => setTimeout(resolve, 20)).then(() => "still-pending"),
    ]);
    assert.equal(raced, "still-pending", "the send must still be in flight after a short wait, not settled early");
    assert.equal(disposed, 0, "a streamingBehavior ack that never lands must never recycle the child, even when it looked idle at send time");
    assert.equal(wrapper.isAlive(), true);

    resolveSend({ agentInvoked: true });
    const result = await wrapper.send({ type: "prompt", message: "hi", streamingBehavior: "followUp", clientMessageId: "idle-race-1" });
    assert.deepEqual(result, { delivery: "started", clientMessageId: "idle-race-1" });
    assert.equal(disposed, 0, "settling later still must not have touched the child");
  } finally {
    await wrapper.destroyAndWait();
  }
});

const { MAX_RPC_FRAME_BYTES, encodeOutboundRpcFrame } = await jiti.import("./omp/rpc-frame.ts");
// rpc-manager.ts drives the user's `omp` binary over NDJSON (lib/omp/rpc-process)
// instead of embedding a Bun-only SDK. These are source-contract tests (the
// module cannot be imported from .mjs without a TS loader).

test("rpc-manager spawns omp via RpcProcess and has no SDK imports", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /from "\.\/omp\/rpc-process"/);
  assert.doesNotMatch(source, /@earendil-works/);
  assert.doesNotMatch(source, /@oh-my-pi/);
});

test("session startup negotiates RPC v2 when the installed OMP advertises it", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /await this\.proc\.negotiateProtocol\(ready\)/);
  assert.match(source, /await proc\.negotiateProtocol\(ready\)/);
});

test("registered host tools route to listeners; unknown ones are rejected", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // Registered host tools (set_host_tools) are forwarded to attached UI
  // listeners, which answer with host_tool_result.
  assert.match(source, /case "host_tool_call":/);
  assert.match(source, /this\.hostToolNames\.has\(toolName\)/);
  assert.match(source, /this\.pendingHostTools\.set\(id, event\)/);
  assert.match(source, /case "set_host_tools":/);
  assert.match(source, /case "host_tool_result":/);
  // Unregistered tools / no attached listener are settled with an error so
  // the agent turn cannot hang waiting for a response.
  assert.match(source, /type: "host_tool_result"/);
  assert.match(source, /isError: true/);
  // A disconnected UI rejects outstanding host tool calls.
  assert.match(source, /rejectPendingHostTools\(/);
  assert.match(source, /listeners\.length === 0/);
});


test("read_app_logs is server-settled, marks read, and only ever adds a one-line notice", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /name: "read_app_logs"/);
  // Reading is what silences the notice.
  assert.match(source, /markAppLogsRead\(this\._sessionId\)/);
  // open_preview and preview_screenshot carry the notice, never log content.
  const handler = source.slice(source.indexOf("private async handleServerHostTool("), source.indexOf("private rejectUnexpectedHostTool("));
  assert.equal(handler.match(/appLogNotice\(this\._sessionId\)/g).length, 2);
  assert.match(handler, /text: `\$\{status\}\$\{hint\}\$\{notice \? ` \$\{notice\}` : ""\}`/);
  assert.match(handler, /at \$\{shot\.width\}x\$\{shot\.height\}\.\$\{traded\}\$\{notice \? ` \$\{notice\}` : ""\}/);
  // Reading logs must not be able to reject a turn: no error path, one text result.
  assert.doesNotMatch(source.slice(source.indexOf('if (toolName === "read_app_logs")'), source.indexOf('if (toolName !== "preview_screenshot")')), /isError/);
});

test("registered host URI schemes route to listeners; unknown schemes are rejected", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // Registered schemes (set_host_uri_schemes) forward host_uri_request frames
  // to attached UI listeners, which answer with host_uri_result.
  assert.match(source, /case "set_host_uri_schemes":/);
  assert.match(source, /case "host_uri_request":/);
  assert.match(source, /case "host_uri_result":/);
  assert.match(source, /this\.hostUriSchemes\.get\(scheme\)/);
  assert.match(source, /registered\.writable/);
  // Unknown schemes / no listener get an error result so read/write never hangs.
  assert.match(source, /isError: true,\s*\n\s*error: `URI scheme/);
  // A disconnected UI rejects outstanding URI requests too.
  assert.match(source, /rejectPendingHostUris\(/);
});

test("browser host results retain their host-call ids instead of becoming RPC commands", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const toolResultCase = source.slice(
    source.indexOf('case "host_tool_result":'),
    source.indexOf('case "set_host_uri_schemes":'),
  );
  const uriResultCase = source.slice(
    source.indexOf('case "host_uri_result":'),
    source.indexOf("default:", source.indexOf('case "host_uri_result":')),
  );

  // Tool results go out through the size guard, URI results straight to the
  // process — neither is ever turned into a command with a fresh id.
  assert.match(toolResultCase, /this\.sendHostToolResult\(command/);
  assert.match(uriResultCase, /this\.proc\.sendFrame\(command/);
  for (const resultCase of [toolResultCase, uriResultCase]) {
    assert.doesNotMatch(resultCase, /this\.proc\.sendCommand\(command/);
  }
  // Every host_tool_result leaves through the one guarded helper (which is the
  // only place allowed to hand a host_tool_result to sendFrame).
  const sender = source.slice(source.indexOf("private sendHostToolResult("), source.indexOf("private async handleServerHostTool("));
  assert.match(sender, /guardHostToolResultFrame\(frame\)/);
  assert.match(sender, /this\.proc\.sendFrame\(outgoing\)/);
  assert.doesNotMatch(
    source.replace(sender, ""),
    /this\.proc\.sendFrame\(\{\s*\n\s*type: "host_tool_result"/,
  );
});

test("a host tool result too large for one frame answers with an error carrying the same id", () => {
  // The transport cannot chunk toward omp, so an oversized frame is DROPPED —
  // and a dropped result is a tool call omp waits on forever. The guard turns
  // that silence into a real failure the model can act on.
  const huge = {
    type: "host_tool_result",
    id: "host-42",
    result: { content: [{ type: "image", data: "A".repeat(MAX_RPC_FRAME_BYTES), mimeType: "image/png" }] },
  };
  const guarded = guardHostToolResultFrame(huge);

  assert.ok(guarded.oversizedBytes > MAX_RPC_FRAME_BYTES);
  assert.equal(guarded.frame.type, "host_tool_result");
  assert.equal(guarded.frame.id, "host-42");
  assert.equal(guarded.frame.isError, true);
  const text = guarded.frame.result.content[0].text;
  assert.equal(guarded.frame.result.content[0].type, "text");
  // Names the measured size and the limit, and is itself deliverable.
  assert.match(text, new RegExp(String(guarded.oversizedBytes)));
  assert.match(text, new RegExp(String(MAX_RPC_FRAME_BYTES)));
  // The real encoder is what drops frames: the replacement must survive it,
  // as exactly one line, or the guard would only have moved the hang.
  assert.throws(() => encodeOutboundRpcFrame(huge), { name: "RpcFrameTooLargeError" });
  assert.equal(encodeOutboundRpcFrame(guarded.frame).length, 1);
});

test("a host tool result within the limit is passed through untouched", () => {
  const frame = {
    type: "host_tool_result",
    id: "host-7",
    result: { content: [{ type: "text", text: "ok" }] },
  };
  const guarded = guardHostToolResultFrame(frame);

  assert.equal(guarded.oversizedBytes, null);
  assert.equal(guarded.frame, frame);
});

test("RPC process cleanup reaps Windows child trees as well as POSIX groups", async () => {
  const source = await readFile(new URL("./omp/rpc-process.ts", import.meta.url), "utf8");
  assert.match(source, /process\.platform === "win32"/);
  assert.match(source, /taskkill/);
  assert.match(source, /process\.kill\(-pid/);
});

test("existing sessions resume deterministically via the engine's resume flag", () => {
  // omp defaults: --resume <file>, presets and advisor only on new sessions.
  assert.deepEqual(buildSessionSpawnArgs("/abs/session.jsonl"), ["--resume", "/abs/session.jsonl"]);
  assert.deepEqual(buildSessionSpawnArgs("/abs/session.jsonl", ["read"], true), ["--resume", "/abs/session.jsonl"]);
  assert.deepEqual(buildSessionSpawnArgs("", []), ["--no-tools"]);
  assert.deepEqual(buildSessionSpawnArgs("", ["read", "bash", "edit", "write"]), ["--tools", "read,bash,edit,write"]);
  assert.deepEqual(buildSessionSpawnArgs("", undefined, true), ["--advisor"]);
  // The full preset means the engine's own complete toolset: no flag at all.
  assert.deepEqual(buildSessionSpawnArgs("", ["bash", "read", "edit", "write", "grep", "find", "ls"]), []);
});

test("OMP main sessions load Cody's extensions without enabling them for sidebars", async (t) => {
  const { ompHarness } = await jiti.import("./harness/omp.ts");
  const harness = { ...ompHarness, resolveBinary: () => "/tools/bin/omp" };
  // Resolved from the package dir the server sets, never the process cwd.
  const previousPackageDir = process.env.CODY_PACKAGE_DIR;
  process.env.CODY_PACKAGE_DIR = "/pkg";
  t.after(() => {
    if (previousPackageDir === undefined) delete process.env.CODY_PACKAGE_DIR;
    else process.env.CODY_PACKAGE_DIR = previousPackageDir;
  });
  const extensionsDir = join("/pkg", "lib", "omp", "extensions");
  const refusalExtension = join(extensionsDir, "cody-refusal-guard.ts");
  const localTimeExtension = join(extensionsDir, "cody-local-time.ts");
  const launch = buildEngineRpcLaunch(harness, { cwd: "/work", sessionFile: "/abs/s.jsonl" });
  assert.equal(launch.bin, "/tools/bin/omp");
  assert.equal(launch.readiness, "ready-frame");
  assert.deepEqual(launch.args, ["--mode", "rpc-ui", "--cwd", "/work", "--resume", "/abs/s.jsonl", "--extension", refusalExtension, "--extension", localTimeExtension]);
  const minimal = buildEngineRpcLaunch(harness, {
    cwd: "/work",
    sessionFile: "",
    profile: { profileId: "minimal", toolNames: ["read", "bash"] },
  });
  assert.deepEqual(minimal.args, ["--mode", "rpc-ui", "--cwd", "/work", "--no-tools", "--tools", "read,bash", "--extension", refusalExtension, "--extension", localTimeExtension]);

  const sidebar = buildEngineRpcLaunch(harness, { cwd: "/work", sessionFile: "", kind: "sidebar" });
  assert.ok(sidebar.args.includes("--no-extensions"));
  assert.ok(!sidebar.args.includes("--extension"));
  const compact = buildEngineRpcLaunch(harness, {
    cwd: "/work",
    sessionFile: "",
    profile: { profileId: "compact", toolNames: ["read", "bash", "edit", "write"] },
  });
  assert.ok(!compact.args.includes("--no-tools"));
});

test("pi launches use pi's CLI surface: --mode rpc, --session resume, no --cwd/--advisor", async () => {
  const { piHarness } = await jiti.import("./harness/pi.ts");
  const harness = { ...piHarness, resolveBinary: () => "/tools/bin/pi" };

  // New session: pi has no --cwd (spawn cwd carries it) and no --advisor;
  // passing either would be silently swallowed by pi's unknown-flag parser.
  const fresh = buildEngineRpcLaunch(harness, {
    cwd: "/work",
    sessionFile: "",
    toolNames: ["read", "bash", "edit", "write"],
    advisor: true,
  });
  assert.equal(fresh.readiness, "first-response");
  assert.equal(fresh.label, "pi");
  assert.deepEqual(fresh.args, ["--mode", "rpc", "--tools", "read,bash,edit,write"]);

  // Resume: pi's --resume is a boolean picker; the file goes to --session.
  const resumed = buildEngineRpcLaunch(harness, { cwd: "/work", sessionFile: "/abs/s.jsonl" });
  assert.deepEqual(resumed.args, ["--mode", "rpc", "--session", "/abs/s.jsonl"]);
});

test("an uninstalled rpc engine fails launch building with a stable code", async () => {
  const { piHarness } = await jiti.import("./harness/pi.ts");
  const harness = { ...piHarness, resolveBinary: () => null };
  assert.throws(
    () => buildEngineRpcLaunch(harness, { cwd: "/work", sessionFile: "" }),
    (error) => error.code === "engine_not_installed",
  );
});

test("utility RPC launches follow the engine: omp default, pi sessionless", async () => {
  const { utilityRpcLaunchFor } = await jiti.import("./rpc-manager.ts");
  const { ompHarness } = await jiti.import("./harness/omp.ts");
  const { piHarness } = await jiti.import("./harness/pi.ts");

  // omp: undefined keeps rpc-utility's default path (shared with auth routes).
  assert.equal(utilityRpcLaunchFor({ ...ompHarness, resolveBinary: () => "/tools/bin/omp" }), undefined);

  // pi: a sessionless catalog probe on pi's own dialect.
  const launch = utilityRpcLaunchFor({ ...piHarness, resolveBinary: () => "/tools/bin/pi" });
  assert.equal(launch.readiness, "first-response");
  assert.deepEqual(launch.args, ["--mode", "rpc", "--no-session", "--no-skills"]);

  // An ACP engine THROWS rather than answering `undefined`. This is the whole
  // bug: `undefined` is rpc-utility's "spawn the installed omp" signal, so
  // answering it for an engine that does not speak the dialect made
  // /api/models serve omp's catalog as Claude Code's and Codex's.
  // The two cases must never be spelled the same way.
  for (const id of ["claude", "codex"]) {
    const { getHarnessById } = await jiti.import("./harness/index.ts");
    assert.throws(
      () => utilityRpcLaunchFor(getHarnessById(id)),
      (error) => error.code === "unsupported",
      `${id} must refuse the utility pipeline, not fall back to omp`,
    );
  }
});

test("pi's RPC vocabulary excludes omp-only commands that would hang id-less", async () => {
  const { piHarness } = await jiti.import("./harness/pi.ts");
  const commands = piHarness.rpcUi.commands;

  // The chat surface pi actually serves.
  for (const supported of ["prompt", "steer", "follow_up", "abort", "get_state", "get_messages", "set_model", "set_thinking_level", "compact", "fork", "bash"]) {
    assert.ok(commands.has(supported), `pi must support ${supported}`);
  }
  // omp-only commands: pi answers unknown types with an id-less error that
  // never settles the request, so these must be rejected Cody-side.
  for (const ompOnly of ["get_subagents", "set_subagent_subscription", "set_host_tools", "set_fast_mode", "abort_compaction", "get_login_providers", "login", "handoff", "set_todos"]) {
    assert.ok(!commands.has(ompOnly), `pi must not be sent ${ompOnly}`);
  }
});

test("pi tool preset names translate to omp builtin names", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // omp renamed find->glob and dropped ls (tools/builtin-names.ts).
  assert.match(source, /find: "glob"/);
  assert.match(source, /DROPPED_TOOL_NAMES = new Set\(\["ls"\]\)/);
});

test("commands with no omp equivalent fail with a clear unsupported error", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const unsupported = source.slice(
    source.indexOf("const UNSUPPORTED_COMMANDS"),
    source.indexOf("const TOOL_NAME_ALIASES"),
  );

  for (const command of ["navigate_tree", "clear_queue", "get_tools", "set_tools"]) {
    assert.match(unsupported, new RegExp(`${command}:`));
  }
});

test("delivery transitions persist in the server ledger and emit updates by id", async () => {
  const { wrapper, events } = createDeliveryHarness();
  try {
    await wrapper.send({ type: "prompt", message: "ledger proof", streamingBehavior: "steer", clientMessageId: "ledger-1" });
    assert.deepEqual(wrapper.getDeliveryLedger(["ledger-1"]).map(({ status }) => status), ["started"]);
    assert.deepEqual(events.filter(({ type }) => type === "cody_delivery").map(({ status }) => status), ["started"]);
  } finally { await wrapper.destroyAndWait(); }
});

test("a message_end before its ack makes the ack and ledger delivered", async () => {
  const pending = deferred();
  const { wrapper, events, emitFrame } = createDeliveryHarness((_command, id) => ({ id, result: pending.promise }));
  try {
    const sending = wrapper.send({ type: "prompt", message: "late ack", streamingBehavior: "steer", clientMessageId: "late-ack" });
    emitFrame({ type: "message_end", message: { role: "user", timestamp: Date.now() + 10_000, content: "late ack" } });
    pending.resolve({ agentInvoked: true });
    assert.deepEqual(await sending, { delivery: "started", clientMessageId: "late-ack", status: "delivered" });
    assert.equal(wrapper.getDeliveryLedger(["late-ack"])[0].status, "delivered");
    assert.deepEqual(events.filter(({ type }) => type === "cody_delivery").map(({ status }) => status), ["delivered"]);
  } finally { await wrapper.destroyAndWait(); }
});

test("an unacked send is unknown after child exit and resends to a new wrapper", async () => {
  const first = deferred();
  const crashed = createDeliveryHarness((_command, id) => ({ id, result: first.promise }));
  const sending = crashed.wrapper.send({ type: "prompt", message: "retry me", streamingBehavior: "steer", clientMessageId: "unacked" });
  crashed.wrapper.handleProcessExit("child exited");
  first.reject(new Error("child exited"));
  await assert.rejects(sending, /child exited/);
  assert.equal(crashed.wrapper.getDeliveryLedger(["unacked"])[0].status, "unknown");
  await crashed.wrapper.destroyAndWait();
  let attempts = 0;
  const restarted = createDeliveryHarness((_command, id) => { attempts += 1; return { id, result: Promise.resolve({ agentInvoked: true }) }; });
  try {
    const ack = await restarted.wrapper.send({ type: "prompt", message: "retry me", streamingBehavior: "steer", clientMessageId: "unacked" });
    assert.equal(attempts, 1);
    assert.equal(ack.delivery, "started");
    assert.equal(restarted.wrapper.getDeliveryLedger(["unacked"])[0].status, "started");
  } finally { await restarted.wrapper.destroyAndWait(); }
});

test("prompt_result is matched by RPC id and an aborted queued send is failed", async () => {
  const { wrapper, events, emitFrame } = createDeliveryHarness(() => ({ id: "rpc-aborted", result: Promise.resolve({ agentInvoked: true }) }));
  try {
    wrapper.promptRunning = true;
    // A steer mid-run goes straight into the engine's own queue.
    await wrapper.send({ type: "prompt", message: "queued", streamingBehavior: "steer", clientMessageId: "aborted-queued" });
    assert.equal(wrapper.getDeliveryLedger(["aborted-queued"])[0].status, "queued");
    assert.notEqual(wrapper.getDeliveryLedger(["aborted-queued"])[0].held, true);
    emitFrame({ type: "prompt_result", id: "rpc-aborted", status: "aborted" });
    assert.equal(wrapper.getDeliveryLedger(["aborted-queued"])[0].status, "failed");
    assert.ok(events.some((event) => event.type === "cody_delivery" && event.clientMessageId === "aborted-queued" && event.status === "failed"));
  } finally { await wrapper.destroyAndWait(); }
});

test("only a legacy prompt_result with agentInvoked false clears promptRunning", async () => {
  const { wrapper, emitFrame } = createDeliveryHarness();
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "prompt_result", status: "completed", sessionSettled: false });
    assert.equal(wrapper.promptRunning, true);
    emitFrame({ type: "prompt_result", agentInvoked: false });
    assert.equal(wrapper.promptRunning, false);
  } finally { await wrapper.destroyAndWait(); }
});

test("terminal agent_end settles a started delivery as delivered", async () => {
  const { wrapper, emitFrame } = createDeliveryHarness();
  try {
    await wrapper.send({ type: "prompt", message: "started", streamingBehavior: "steer", clientMessageId: "terminal" });
    emitFrame({ type: "agent_end", isTerminal: true, messages: [] });
    assert.equal(wrapper.getDeliveryLedger(["terminal"])[0].status, "delivered");
  } finally { await wrapper.destroyAndWait(); }
});

test("child loss resolves started as delivered and queued as failed", async () => {
  const { wrapper, events } = createDeliveryHarness();
  try {
    await wrapper.send({ type: "prompt", message: "active", streamingBehavior: "steer", clientMessageId: "active" });
    await wrapper.send({ type: "prompt", message: "queued", streamingBehavior: "followUp", clientMessageId: "queued" });
    wrapper.handleProcessExit("child exited");
    assert.deepEqual(wrapper.getDeliveryLedger(["active", "queued"]).map(({ status }) => status), ["delivered", "failed"]);
    assert.deepEqual(events.filter(({ type }) => type === "cody_delivery").slice(-2).map(({ status }) => status), ["delivered", "failed"]);
  } finally { await wrapper.destroyAndWait(); }
});

test("one joined user message settles all accepted prompts in send order", async () => {
  const { wrapper, emitFrame } = createDeliveryHarness();
  try {
    wrapper.promptRunning = true;
    await wrapper.send({ type: "prompt", message: "first", streamingBehavior: "followUp", clientMessageId: "join-a" });
    await wrapper.send({ type: "prompt", message: "second", streamingBehavior: "followUp", clientMessageId: "join-b" });
    emitFrame({ type: "message_end", message: { role: "user", timestamp: Date.now() + 10_000, content: "first\n\nsecond" } });
    assert.deepEqual(wrapper.getDeliveryLedger(["join-a", "join-b"]).map(({ status }) => status), ["delivered", "delivered"]);
  } finally { await wrapper.destroyAndWait(); }
});

test("an image-only user message settles its accepted delivery", async () => {
  const { wrapper, emitFrame } = createDeliveryHarness();
  try {
    await wrapper.send({ type: "prompt", message: "", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], streamingBehavior: "steer", clientMessageId: "image-only" });
    emitFrame({ type: "message_end", message: { role: "user", timestamp: Date.now() + 10_000, content: [{ type: "image" }] } });
    assert.equal(wrapper.getDeliveryLedger(["image-only"])[0].status, "delivered");
  } finally { await wrapper.destroyAndWait(); }
});

test("prompt completion is driven by agent_end / prompt_result, not prompt_done", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /case "prompt_result":/);
  assert.match(source, /isTerminal !== false/);
  assert.doesNotMatch(source, /"prompt_done"/);
});

test("agent startup broadcasts a session-list refresh without waiting for a reply", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const agentStart = source.slice(source.indexOf('case "agent_start":'), source.indexOf('case "agent_end":'));

  assert.match(agentStart, /invalidateSessionListCache\(\)/);
  assert.match(agentStart, /refreshSessionList = true/);
  assert.match(source, /notifyRunningChange\(\{ refreshSessionList \}\)/);
  assert.match(source, /snapshot === lastRunningSnapshot && !refreshSessionList/);
});

test("live MCP status uses only OMP's local /mcp list command", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("async getMcpList()"), source.indexOf("private buildWebState"));

  assert.match(method, /message: "\/mcp list"/);
  assert.match(method, /mcp_list_timeout/);
  assert.match(source, /case "command_output":/);
  assert.match(source, /Wait for the current run to finish/);
});

test("`!!` shell commands are rejected instead of silently entering context", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const bashCase = source.slice(source.indexOf('case "bash": {'), source.indexOf("default: {"));

  // omp's RPC bash is `{type:"bash", command}` only — there is no exclusion
  // option, so honoring `!!` is impossible and must fail loudly.
  assert.match(bashCase, /command\.excludeFromContext === true/);
  assert.match(bashCase, /WebRpcError\(bashExcludeMessage\(this\.engine\.label\), "bash_exclude_unsupported"\)/);
  assert.doesNotMatch(bashCase, /excludeFromContext: /);
});

test("auto-compaction results carry the same estimatedTokensAfter as manual compact", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const autoCase = source.slice(
    source.indexOf('case "auto_compaction_end":'),
    source.indexOf('case "session_info_update":'),
  );

  assert.match(autoCase, /patchEstimatedTokensAfter\(event\.result\)/);
  // Both paths must go through the one estimator, not duplicate the formula.
  assert.equal(source.match(/estimatedTokensAfter = Math\.round/g)?.length, 1);
});

test("timed-out extension dialogs are not replayed on reconnect, live ones are", async () => {
  const { wrapper, emitFrame } = createDeliveryHarness();
  try {
    emitFrame({ type: "extension_ui_request", id: "expired", method: "select", title: "Old question", options: ["a", "b"], timeout: 20 });
    emitFrame({ type: "extension_ui_request", id: "live", method: "select", title: "Current question", options: ["a", "b"] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const replayed = [];
    wrapper.onEvent((event) => replayed.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ids = replayed.filter((event) => event.type === "extension_ui_request").map((event) => event.id);
    assert.deepEqual(ids, ["live"]);
  } finally {
    wrapper.destroy();
  }
});


test("spawn cwd falls back when the session's recorded directory is gone", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("export function resolveSpawnCwd"),
    source.indexOf("function patchEstimatedTokensAfter"),
  );

  assert.match(helper, /existsSync\(recordedCwd\)/);
  assert.match(helper, /homedir\(\)/);
});

test("every _sessionId write goes through setSessionId, which drops a stale plan keeper on a real change", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // A branch/new_session/switch_session/non-resumable restart lands on a
  // different session id, and that can surface through EITHER
  // applyIdentity or buildWebState (whichever next reads get_state).
  // lib/plan-keeper's overlay is keyed by session id (cody-plan/<id>.json),
  // so a keeper built for the OLD id must not keep running against it once
  // identity moves on from either path.
  const setter = source.slice(source.indexOf("private setSessionId("), source.indexOf("private applyIdentity("));
  assert.match(setter, /if \(this\._sessionId && this\._sessionId !== id\)/);
  assert.match(setter, /this\.planKeeper\?\.dispose\(\);/);
  assert.match(setter, /this\.planKeeper = null;/);
  assert.match(setter, /this\._sessionId = id;/);

  const applyIdentity = source.slice(source.indexOf("private applyIdentity("), source.indexOf("handleProcessExit("));
  assert.match(applyIdentity, /this\.setSessionId\(state\.sessionId\);/);
  assert.doesNotMatch(applyIdentity, /this\._sessionId = state\.sessionId/, "must route through the setter, not write the field directly");

  const buildWebState = source.slice(source.indexOf("private buildWebState("), source.indexOf("refreshIdentityAfterSessionChange("));
  assert.match(buildWebState, /this\.setSessionId\(state\.sessionId\);/);
  assert.doesNotMatch(buildWebState, /this\._sessionId = state\.sessionId/, "must route through the setter, not write the field directly");
});

test("buildSessionSpawnArgs with kind: 'sidebar' includes all required flags", () => {
  const args = buildSessionSpawnArgs("", undefined, false, "sidebar", "/home/user/.omp/agent/cody-sidebar-chats/-home-user-project", { resumeFlag: "--resume", supportsAdvisor: true });
  assert.ok(args.includes("--no-tools"), "includes --no-tools");
  assert.ok(args.includes("--no-skills"), "includes --no-skills");
  assert.ok(args.includes("--no-extensions"), "includes --no-extensions");
  assert.ok(args.includes("--no-rules"), "includes --no-rules");
  assert.ok(args.includes("--no-prewalk"), "includes --no-prewalk");
  assert.ok(args.includes("--no-title"), "includes --no-title");
  assert.ok(args.includes("--session-dir"), "includes --session-dir flag");
  assert.ok(args.includes("/home/user/.omp/agent/cody-sidebar-chats/-home-user-project"), "includes computed sidebar dir path");
  assert.ok(args.includes("--system-prompt"), "includes --system-prompt flag");
  const systemPromptIdx = args.indexOf("--system-prompt");
  // Assert the CONTRACT, not the sentence. The sidebar now reads on demand,
  // so "cannot read or edit files" became false: it must be told it starts
  // with no context, which tools fetch it, and that editing is still out.
  const prompt = args[systemPromptIdx + 1] ?? "";
  assert.ok(prompt.includes("side panel"), "system prompt mentions side panel context");
  assert.ok(/NO project context/i.test(prompt), "system prompt says it starts without project context");
  assert.ok(prompt.includes("read_project_context"), "system prompt names a context tool to use on demand");
  assert.ok(/cannot edit files/i.test(prompt), "system prompt keeps the no-editing restriction");
});

// ---------------------------------------------------------------------------
// Safety-refusal decisions (lib/omp/extensions/cody-refusal-guard.ts). omp
// gives the guard's dialog only its 30 s handler budget, so the wrapper must
// answer at once in every policy and keep the user's choice in its own state.
// ---------------------------------------------------------------------------

async function withRefusalPolicy(policy, body) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "cody-refusal-policy-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    if (policy) writeFileSync(join(agentDir, "cody-refusal-policy.json"), JSON.stringify({ version: 1, policy }));
    const sentFrames = [];
    let onFrame = () => {};
    const proc = {
      isAlive: true,
      dispose: async () => {},
      onFrame(listener) { onFrame = listener; return () => { onFrame = () => {}; }; },
      sendFrame(frame) { sentFrames.push(frame); },
      sendCommand: async () => ({ entries: [] }),
      sendCommandWithId: (_command, id = "rpc-1") => ({ id, result: Promise.resolve({ agentInvoked: false }) }),
    };
    const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: {}, label: "omp", relaunch: () => ({}) });
    wrapper.start();
    const events = [];
    wrapper.onEvent((event) => events.push(event));
    try {
      await body({ wrapper, events, sentFrames, emitFrame: (event) => onFrame(event) });
    } finally {
      wrapper.destroy();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

const refusalRequest = (id, mode = "fallback") => ({
  type: "extension_ui_request",
  id,
  method: "select",
  title: `CODY_REFUSAL_DECISION ${JSON.stringify({ kind: "cody.refusal-decision", mode, from: "p/primary", to: mode === "fallback" ? "p/fallback" : null, userEntryId: "u1" })}`,
  options: mode === "fallback" ? ["continue", "rewind", "hold"] : ["keep", "rewind", "hold"],
});

test("ask: the guard is answered hold at once, and the question waits in wrapper state, never as a generic dialog", async () => {
  await withRefusalPolicy("ask", async ({ wrapper, events, sentFrames, emitFrame }) => {
    emitFrame(refusalRequest("r1"));
    assert.deepEqual(sentFrames, [{ type: "extension_ui_response", id: "r1", value: "hold" }]);
    assert.equal(wrapper.hasPendingRefusalDecision(), true);
    assert.equal(wrapper.hasPendingInput(), true);
    assert.ok(!events.some((event) => event.type === "extension_ui_request"), "the namespaced dialog is never forwarded");
    const decision = events.find((event) => event.type === "cody_refusal_decision")?.decision;
    assert.equal(decision?.toModel, "p/fallback");
    assert.equal(decision?.canContinue, true);
  });
});

test("a new message retires an unanswered refusal question", async () => {
  await withRefusalPolicy("ask", async ({ wrapper, events, emitFrame }) => {
    emitFrame(refusalRequest("r1", "no_fallback"));
    assert.equal(wrapper.hasPendingRefusalDecision(), true);
    await wrapper.send({ type: "prompt", message: "moving on", clientMessageId: "c1" });
    assert.equal(wrapper.hasPendingRefusalDecision(), false);
    assert.equal(events.filter((event) => event.type === "cody_refusal_decision").at(-1)?.decision, null);
  });
});

test("a fallback the guard stops is never announced; any other fallback is, after the short hold", async () => {
  await withRefusalPolicy("ask", async ({ events, emitFrame }) => {
    emitFrame({ type: "retry_fallback_applied", from: "p/primary", to: "p/fallback", role: "default" });
    emitFrame(refusalRequest("r1"));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.ok(!events.some((event) => event.type === "retry_fallback_applied"));
  });
  await withRefusalPolicy("fallback", async ({ events, sentFrames, emitFrame }) => {
    emitFrame({ type: "retry_fallback_applied", from: "p/primary", to: "p/fallback", role: "default" });
    emitFrame(refusalRequest("r2"));
    assert.deepEqual(sentFrames, [{ type: "extension_ui_response", id: "r2", value: "continue" }]);
    assert.equal(events.filter((event) => event.type === "retry_fallback_applied").length, 1);
  });
  await withRefusalPolicy(null, async ({ events, emitFrame }) => {
    emitFrame({ type: "retry_fallback_applied", from: "p/primary", to: "p/fallback", role: "default", reason: "rate limit" });
    assert.equal(events.filter((event) => event.type === "retry_fallback_applied").length, 0, "held briefly");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(events.filter((event) => event.type === "retry_fallback_applied").length, 1, "then released");
  });
});

// ---------------------------------------------------------------------------
// Held queue: follow-ups sent mid-run stay in Cody until the engine would read
// them, so they can be edited on every omp build (omp 18.4.4+ can additionally
// take back one it already holds; those cases are tested further down).
// ---------------------------------------------------------------------------

function createQueueHarness() {
  let onFrame = () => {};
  const sentPrompts = [];
  const events = [];
  let sequence = 0;
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame(listener) { onFrame = listener; return () => { onFrame = () => {}; }; },
    sendFrame() {},
    sendCommand: async () => ({}),
    sendCommandWithId(command) {
      if (command.type === "prompt") sentPrompts.push({ message: command.message, streamingBehavior: command.streamingBehavior });
      return { id: `rpc-${++sequence}`, result: Promise.resolve({ agentInvoked: true }) };
    },
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: {}, label: "omp", relaunch: () => ({}) });
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { wrapper, events, sentPrompts, settle, emitFrame: (event) => onFrame(event) };
}

test("a deleted queued message never reaches the engine; the rest go out in order when the run ends", async () => {
  const { wrapper, sentPrompts, settle, emitFrame } = createQueueHarness();
  try {
    wrapper.promptRunning = true;
    await wrapper.send({ type: "prompt", message: "first", streamingBehavior: "followUp", clientMessageId: "q1" });
    await wrapper.send({ type: "prompt", message: "delete me", streamingBehavior: "followUp", clientMessageId: "q2" });
    await wrapper.send({ type: "prompt", message: "third", streamingBehavior: "followUp", clientMessageId: "q3" });
    assert.deepEqual(sentPrompts, [], "held while the run is live");
    assert.equal(wrapper.getDeliveryLedger(["q2"])[0].held, true);

    const result = await wrapper.send({ type: "withdraw_queued", clientMessageId: "q2" });
    assert.equal(result.withdrawn, true);
    assert.equal(result.text, "delete me");
    assert.equal(wrapper.getDeliveryLedger(["q2"])[0].status, "withdrawn");

    emitFrame({ type: "agent_end", isTerminal: true, messages: [] });
    await settle();
    assert.deepEqual(sentPrompts.map((prompt) => prompt.message), ["first", "third"]);
  } finally { wrapper.destroy(); }
});

test("a steer mid-run reaches the engine at once, even with no tool running; follow-ups wait for the run to end", async () => {
  const { wrapper, sentPrompts, settle, emitFrame } = createQueueHarness();
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "prompt", message: "later", streamingBehavior: "followUp", clientMessageId: "f1" });
    // The model is only writing: omp still takes a steer now (live steering,
    // or the next step boundary). Holding it for a tool made it wait out the
    // whole reply.
    const ack = await wrapper.send({ type: "prompt", message: "now", streamingBehavior: "steer", clientMessageId: "s1" });
    await settle();
    assert.notEqual(ack.held, true);
    assert.deepEqual(sentPrompts, [{ message: "now", streamingBehavior: "steer" }]);
    const late = await wrapper.send({ type: "withdraw_queued", clientMessageId: "s1" });
    assert.deepEqual(late, { withdrawn: false, reason: "already_sent" }, "the engine has it: it cannot be taken back");
    assert.equal(wrapper.getDeliveryLedger(["f1"])[0].held, true);

    emitFrame({ type: "agent_end", isTerminal: true, messages: [] });
    await settle();
    assert.deepEqual(sentPrompts.map((prompt) => prompt.message), ["now", "later"]);
  } finally { wrapper.destroy(); }
});

function recordAborts(wrapper) {
  const aborts = [];
  const original = wrapper.proc.sendCommand;
  wrapper.proc.sendCommand = async (command, timeout) => {
    if (command.type === "abort") aborts.push(command);
    return original(command, timeout);
  };
  return aborts;
}

test("Steer on a held follow-up sends it as a steer and cuts the model's reply short so it is read now", async () => {
  const { wrapper, events, sentPrompts, settle, emitFrame } = createQueueHarness();
  const aborts = recordAborts(wrapper);
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "prompt", message: "sooner please", streamingBehavior: "followUp", clientMessageId: "p1" });
    await wrapper.send({ type: "prompt", message: "after it all", streamingBehavior: "followUp", clientMessageId: "p2" });
    const result = await wrapper.send({ type: "steer_now", clientMessageId: "p1" });
    assert.deepEqual(result, { steered: true, mode: "interrupted" });
    assert.deepEqual(sentPrompts, [{ message: "sooner please", streamingBehavior: "steer" }]);
    assert.equal(aborts.length, 1, "the reply is interrupted");
    const entry = wrapper.getDeliveryLedger(["p1"])[0];
    assert.equal(entry.held, false, "handed over: no longer editable");

    // omp ends the aborted run, then continues with the steer. That end is a
    // hand-off: the page must not see the run finish, and the other held
    // follow-up must not jump in ahead of the steer.
    emitFrame({ type: "agent_end", isTerminal: true, messages: [] });
    await settle();
    assert.equal(events.filter((event) => event.type === "agent_end").at(-1).isTerminal, false);
    assert.equal(wrapper.isRunning(), true);
    assert.equal(sentPrompts.length, 1);

    emitFrame({ type: "agent_start" });
    emitFrame({ type: "agent_end", isTerminal: true, messages: [] });
    await settle();
    assert.equal(events.filter((event) => event.type === "agent_end").at(-1).isTerminal, true, "the real end is terminal");
    assert.deepEqual(sentPrompts.map((prompt) => prompt.message), ["sooner please", "after it all"]);
  } finally { wrapper.destroy(); }
});

test("Steer never aborts a running tool: the steer lands when the step ends", async () => {
  const { wrapper, emitFrame } = createQueueHarness();
  const aborts = recordAborts(wrapper);
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    emitFrame({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
    await wrapper.send({ type: "prompt", message: "look here", streamingBehavior: "steer", clientMessageId: "s1" });
    assert.deepEqual(await wrapper.send({ type: "steer_now", clientMessageId: "s1" }), { steered: true, mode: "next_step" });
    assert.equal(aborts.length, 0);
    // Once the tool is done, the model is only writing: now it can be cut short.
    emitFrame({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" });
    assert.deepEqual(await wrapper.send({ type: "steer_now", clientMessageId: "s1" }), { steered: true, mode: "interrupted" });
    assert.equal(aborts.length, 1);
  } finally { wrapper.destroy(); }
});

test("Steer only pulls forward what the engine has not read: follow-ups in its queue and read messages are refused", async () => {
  const { wrapper, emitFrame } = createQueueHarness();
  const aborts = recordAborts(wrapper);
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "prompt", message: "read already", streamingBehavior: "steer", clientMessageId: "r1" });
    emitFrame({ type: "message_end", message: { role: "user", content: "read already" } });
    assert.equal((await wrapper.send({ type: "steer_now", clientMessageId: "r1" })).reason, "already_read");
    assert.equal((await wrapper.send({ type: "steer_now", clientMessageId: "nope" })).reason, "unknown");
    assert.equal(aborts.length, 0);
  } finally { wrapper.destroy(); }
});

test("if the engine does not continue after a Steer interrupt, the run still ends for every listener", async () => {
  const { wrapper, events, settle, emitFrame } = createQueueHarness();
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "prompt", message: "now", streamingBehavior: "steer", clientMessageId: "s2" });
    await wrapper.send({ type: "steer_now", clientMessageId: "s2" });
    emitFrame({ type: "agent_end", isTerminal: true, messages: [] });
    await settle();
    assert.equal(wrapper.isRunning(), true, "a hand-off at first");
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    assert.equal(events.filter((event) => event.type === "agent_end").at(-1).isTerminal, true);
    assert.equal(wrapper.isRunning(), false);
  } finally { wrapper.destroy(); }
});

test("a held follow-up is never stranded when the run ends without an agent_end reaching the hold", async () => {
  const { wrapper, sentPrompts } = createQueueHarness();
  try {
    wrapper.promptRunning = true;
    await wrapper.send({ type: "prompt", message: "after the run", streamingBehavior: "followUp", clientMessageId: "g1" });
    // The run settles through a path that does not flush the hold itself.
    wrapper.promptRunning = false;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.deepEqual(sentPrompts.map((prompt) => prompt.message), ["after the run"]);
  } finally { wrapper.destroy(); }
});

test("closing a session tells every attached listener, once, however it closed", async () => {
  const { wrapper } = createQueueHarness();
  let closed = 0;
  let detachedClosed = 0;
  wrapper.onClose(() => { closed += 1; });
  const off = wrapper.onClose(() => { detachedClosed += 1; });
  off();
  await wrapper.destroyAndWait();
  await wrapper.destroyAndWait();
  assert.equal(closed, 1);
  assert.equal(detachedClosed, 0, "a stream that already went away is not called");
  let late = 0;
  wrapper.onClose(() => { late += 1; });
  assert.equal(late, 1, "subscribing to a session that is already closed answers at once");
});

test("Stop hands held messages back and sends none of them, and the main agent stays stopped", async () => {
  const { wrapper, events, sentPrompts, settle, emitFrame } = createQueueHarness();
  try {
    wrapper.promptRunning = true;
    await wrapper.send({ type: "prompt", message: "queued before stop", streamingBehavior: "followUp", clientMessageId: "h1" });
    await wrapper.send({ type: "abort" });
    await settle();
    assert.equal(wrapper.getDeliveryLedger(["h1"])[0].status, "withdrawn");
    const returned = events.find((event) => event.type === "cody_queue_returned");
    assert.deepEqual(returned?.messages.map((message) => message.text), ["queued before stop"]);
    // The engine ends the aborted run; nothing held may start a new one.
    emitFrame({ type: "agent_end", isTerminal: true, messages: [] });
    await settle();
    assert.deepEqual(sentPrompts, []);
  } finally { wrapper.destroy(); }
});

// ---------------------------------------------------------------------------
// Stop with messages still queued. omp 18.7's `abort_and_restore_queue` takes
// its queue back before the abort, so nothing runs on it afterwards; what it
// hands back, with the follow-ups Cody itself holds, returns to the composer.
// ---------------------------------------------------------------------------

const RESTORED_IMAGE = { type: "image", data: "UklGRg==", mimeType: "image/webp" };

/** A queue harness whose engine answers Stop the way omp 18.7 does. `during`
 *  runs while the restore is in flight: omp reports every prompt it withdrew
 *  `aborted` before it answers. */
function createRestoreHarness(answer, during = () => {}) {
  const harness = createQueueHarness();
  const engine = [];
  harness.wrapper.proc.sendCommand = async (command) => {
    engine.push(command.type);
    if (command.type !== "abort_and_restore_queue") return {};
    during(harness);
    return answer;
  };
  return { ...harness, engine };
}

test("Stop takes omp's queue back: what it returns and the held follow-ups reach the composer as one draft, oldest send first, and nothing runs afterwards", async () => {
  const { wrapper, events, engine, sentPrompts, settle, emitFrame } = createRestoreHarness({
    steering: [{ text: "  fix the typo  " }, { text: "[Image]", images: [RESTORED_IMAGE] }],
    followUp: [{ text: "then run the tests" }, { text: "from outside Cody" }],
  });
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const send = async (command) => { await wrapper.send(command); await settle(); };
    await send({ type: "prompt", message: "  fix the typo  ", streamingBehavior: "steer", clientMessageId: "s1" });
    await send({ type: "prompt", message: "held follow-up", streamingBehavior: "followUp", clientMessageId: "h1" });
    await send({ type: "prompt", message: "", images: [image], streamingBehavior: "steer", clientMessageId: "s2" });
    await send({ type: "follow_up", message: "then run the tests", clientMessageId: "f1" });
    const handedToOmp = sentPrompts.length;

    await wrapper.send({ type: "abort" });

    assert.deepEqual(engine.filter((type) => type === "abort" || type === "abort_and_restore_queue"), ["abort_and_restore_queue"], "one command: the restore aborts too");
    const returned = events.filter((event) => event.type === "cody_queue_returned");
    assert.equal(returned.length, 1, "one frame, so the composer takes one draft");
    assert.deepEqual(returned[0].messages.map((message) => message.text), ["  fix the typo  ", "held follow-up", "[Image]", "then run the tests", "from outside Cody"]);
    assert.deepEqual(returned[0].messages.map((message) => message.clientMessageId), ["s1", "h1", "s2", "f1", undefined]);
    assert.deepEqual(returned[0].messages[2].images, [RESTORED_IMAGE], "omp's own copy of the picture comes back, not the ledger's");
    assert.deepEqual(wrapper.getDeliveryLedger(["s1", "h1", "s2", "f1"]).map((row) => row.status), ["withdrawn", "withdrawn", "withdrawn", "withdrawn"]);

    // The engine ends the aborted run; neither what it returned nor what Cody held may start another.
    emitFrame({ type: "agent_end", isTerminal: true, messages: [] });
    await settle();
    assert.equal(sentPrompts.length, handedToOmp);
  } finally { wrapper.destroy(); }
});

test("omp reports each withdrawn prompt `aborted` before it answers a Stop: those rows end withdrawn, and only a row it did not hand back is failed", async () => {
  const { wrapper, events, emitFrame, settle } = createRestoreHarness(
    { steering: [{ text: "handed back" }], followUp: [] },
    ({ wrapper: stopped, emitFrame: emit }) => {
      for (const { rpcId } of stopped.getDeliveryLedger(["r0", "a1", "a2"])) {
        emit({ type: "prompt_result", id: rpcId, agentInvoked: true, status: "aborted", sessionSettled: true });
      }
    },
  );
  try {
    await wrapper.send({ type: "prompt", message: "go", clientMessageId: "r0" });
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "prompt", message: "handed back", streamingBehavior: "steer", clientMessageId: "a1" });
    await wrapper.send({ type: "prompt", message: "read just before", streamingBehavior: "steer", clientMessageId: "a2" });
    await wrapper.send({ type: "steer", message: "a steer command gets no prompt_result", clientMessageId: "a3" });
    assert.deepEqual(wrapper.getDeliveryLedger(["r0", "a1", "a2", "a3"]).map((row) => row.status), ["started", "queued", "queued", "queued"]);

    await wrapper.send({ type: "abort" });
    await settle();

    const rows = Object.fromEntries(wrapper.getDeliveryLedger(["r0", "a1", "a2", "a3"]).map((row) => [row.clientMessageId, row]));
    assert.equal(rows.r0.status, "delivered", "the prompt that started the run was read");
    assert.equal(rows.a1.status, "withdrawn", "an aborted report that beat the answer does not make it a failure");
    assert.equal(rows.a2.status, "failed");
    assert.equal(rows.a2.error, "Stopped before this message was read.");
    assert.equal(rows.a3.status, "failed", "nothing else would ever settle a steer command");
    assert.deepEqual(events.find((event) => event.type === "cody_queue_returned")?.messages.map((message) => message.text), ["handed back"]);
  } finally { wrapper.destroy(); }
});

test("what omp could not fit in its answer is reported beside what did come back, and a Stop that gives back nothing says nothing", async () => {
  const stopWith = async (answer, { held = false } = {}) => {
    const harness = createRestoreHarness(answer);
    try {
      harness.wrapper.promptRunning = true;
      if (held) await harness.wrapper.send({ type: "prompt", message: "held", streamingBehavior: "followUp", clientMessageId: "h1" });
      await harness.wrapper.send({ type: "abort" });
      return harness.events.filter((event) => event.type === "cody_queue_returned");
    } finally { harness.wrapper.destroy(); }
  };

  const [cut] = await stopWith({ steering: [{ text: "kept" }], followUp: [], imagesDropped: true, truncated: true });
  assert.deepEqual(cut.messages.map((message) => message.text), ["kept"]);
  assert.equal(cut.truncated, true);
  assert.equal(cut.imagesDropped, true);

  const [onlyTheNotice] = await stopWith({ steering: [], followUp: [], truncated: true });
  assert.deepEqual(onlyTheNotice.messages, []);
  assert.equal(onlyTheNotice.truncated, true);

  assert.deepEqual(await stopWith({ steering: [], followUp: [] }), []);
  const [plain] = await stopWith({ steering: [], followUp: [] }, { held: true });
  assert.deepEqual(plain.messages.map((message) => message.text), ["held"]);
  assert.equal("truncated" in plain || "imagesDropped" in plain, false, "flags appear only when omp set them");
});

test("an omp without abort_and_restore_queue is stopped with a plain abort and not asked again; any other failure still returns what Cody held", async () => {
  const { RpcCommandError } = await jiti.import("./omp/rpc-process.ts");
  const old = createQueueHarness();
  const oldEngine = [];
  old.wrapper.proc.sendCommand = async (command) => {
    oldEngine.push(command.type);
    if (command.type === "abort_and_restore_queue") throw new RpcCommandError(command.type, "Unknown command: abort_and_restore_queue");
    return {};
  };
  try {
    old.wrapper.promptRunning = true;
    await old.wrapper.send({ type: "prompt", message: "held", streamingBehavior: "followUp", clientMessageId: "h1" });
    await old.wrapper.send({ type: "abort" });
    assert.deepEqual(oldEngine, ["abort_and_restore_queue", "abort"]);
    assert.deepEqual(old.events.filter((event) => event.type === "cody_queue_returned").map((event) => event.messages.map((message) => message.text)), [["held"]]);
    await old.wrapper.send({ type: "abort" });
    assert.deepEqual(oldEngine, ["abort_and_restore_queue", "abort", "abort"], "the answer is remembered");
  } finally { old.wrapper.destroy(); }

  const broken = createQueueHarness();
  const brokenEngine = [];
  broken.wrapper.proc.sendCommand = async (command) => {
    brokenEngine.push(command.type);
    if (command.type === "abort_and_restore_queue") throw new Error("engine exploded");
    return {};
  };
  try {
    broken.wrapper.promptRunning = true;
    await broken.wrapper.send({ type: "prompt", message: "held", streamingBehavior: "followUp", clientMessageId: "h1" });
    await assert.rejects(broken.wrapper.send({ type: "abort" }), /engine exploded/);
    assert.deepEqual(brokenEngine, ["abort_and_restore_queue"], "an engine failure is not an old engine");
    assert.deepEqual(broken.events.find((event) => event.type === "cody_queue_returned")?.messages.map((message) => message.text), ["held"]);
  } finally { broken.wrapper.destroy(); }
});

test("an engine with a restricted RPC vocabulary is only ever sent a plain abort on Stop", async () => {
  const sent = [];
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      onFrame() { return () => {}; },
      sendFrame() {},
      sendCommand: async (command) => { sent.push(command.type); return {}; },
      sendCommandWithId: () => ({ id: "x", result: Promise.resolve({ agentInvoked: true }) }),
    },
    process.cwd(),
    { rpcUi: { commands: new Set(["abort", "prompt", "get_state"]) }, label: "pi", relaunch: () => ({}) },
  );
  wrapper.start();
  try {
    await wrapper.send({ type: "abort" });
    assert.deepEqual(sent.filter((type) => type.startsWith("abort")), ["abort"]);
  } finally { wrapper.destroy(); }
});

test("Steer now interrupts with a plain abort: the steer it carries on into must stay queued in omp", async () => {
  const { wrapper, engine, emitFrame } = createRestoreHarness({ steering: [], followUp: [] });
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "prompt", message: "now", streamingBehavior: "steer", clientMessageId: "s1" });
    assert.deepEqual(await wrapper.send({ type: "steer_now", clientMessageId: "s1" }), { steered: true, mode: "interrupted" });
    assert.equal(engine.includes("abort"), true);
    assert.equal(engine.includes("abort_and_restore_queue"), false);
  } finally { wrapper.destroy(); }
});

test("Edit brings back the pictures omp returns for a message it had queued, and the ones it was sent with when omp has none", async () => {
  const { wrapper, emitFrame } = createQueueHarness();
  let answer;
  wrapper.proc.sendCommand = async (command) => (command.type === "remove_queued_message" ? answer : {});
  const sent = { type: "image", data: "AAAA", mimeType: "image/png" };
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "prompt", message: "one", images: [sent], streamingBehavior: "steer", clientMessageId: "e1" });
    await wrapper.send({ type: "prompt", message: "two", images: [sent], streamingBehavior: "steer", clientMessageId: "e2" });
    await wrapper.send({ type: "prompt", message: "three", streamingBehavior: "steer", clientMessageId: "e3" });
    answer = { removed: true, images: [RESTORED_IMAGE] };
    assert.deepEqual(await wrapper.send({ type: "withdraw_queued", clientMessageId: "e1" }), { withdrawn: true, text: "one", images: [RESTORED_IMAGE] });
    answer = { removed: true, imagesDropped: true };
    assert.deepEqual(await wrapper.send({ type: "withdraw_queued", clientMessageId: "e2" }), { withdrawn: true, text: "two", images: [sent] });
    answer = { removed: true };
    assert.deepEqual(await wrapper.send({ type: "withdraw_queued", clientMessageId: "e3" }), { withdrawn: true, text: "three", images: [] });
  } finally { wrapper.destroy(); }
});

test("while stopped, a run the engine starts on its own is aborted at its first reply; the next user send lifts that", async () => {
  const aborts = [];
  const { wrapper, emitFrame } = createQueueHarness();
  const original = wrapper.proc.sendCommand;
  wrapper.proc.sendCommand = async (command, timeout) => {
    if (command.type === "abort" || command.type === "abort_and_restore_queue") aborts.push(command.type);
    return original(command, timeout);
  };
  try {
    await wrapper.send({ type: "abort" });
    assert.deepEqual(aborts, ["abort_and_restore_queue"], "the user's Stop takes the queue back too");
    emitFrame({ type: "agent_start" });
    emitFrame({ type: "message_start", message: { role: "assistant" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(aborts.length, 2, "a self-started run is stopped");
    await wrapper.send({ type: "prompt", message: "go on", streamingBehavior: "steer", clientMessageId: "u1" });
    emitFrame({ type: "message_start", message: { role: "assistant" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(aborts.length, 2, "the user's own send is not stopped");
  } finally { wrapper.destroy(); }
});


test("a browser page coming and going never re-sends the tool roster; hardware changes it once", async () => {
  const { getDeviceBridge } = await jiti.import("./devices/bus.ts");
  const rosters = [];
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame() { return () => {}; },
    sendFrame() {},
    sendCommand: async (command) => {
      if (command.type === "set_host_tools") rosters.push(command.tools.map((tool) => tool.name).filter((name) => name.startsWith("device_") || name === "usb_transfer" || name === "ble_gatt"));
      return {};
    },
    sendCommandWithId: () => ({ id: "x", result: Promise.resolve({}) }),
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: { hostTools: true }, label: "omp", relaunch: () => ({}) });
  wrapper.start();
  try {
    const sessionId = `device-churn-${Date.now()}`;
    wrapper.setSessionId(sessionId);
    const bridge = getDeviceBridge(sessionId);
    // A page attaching, dropping and re-attaching with nothing granted: the
    // roster (device_list only) is the same throughout, so nothing is sent.
    let detach = bridge.attach(() => {});
    detach();
    detach = bridge.attach(() => {});
    assert.deepEqual(rosters, [], "socket churn alone must not reach the engine");

    // Hardware granted: the working tools are published once.
    bridge.setDevices([{ id: "d1", kind: "serial", label: "Board", open: false }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(rosters.length, 1);
    assert.ok(rosters[0].includes("device_open"));

    // The page drops and comes straight back with the same grant: still one.
    detach();
    detach = bridge.attach(() => {});
    bridge.setDevices([{ id: "d1", kind: "serial", label: "Board", open: false }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(rosters.length, 1, "a reconnect inside the grace period changes nothing the engine sees");
  } finally { wrapper.destroy(); }
});

test("concurrent status reads share one engine command instead of queuing copies", async () => {
  const sent = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame() { return () => {}; },
    sendFrame() {},
    sendCommand: async (command) => { sent.push(command.type); await gate; return command.type === "get_subagents" ? { subagents: [] } : { sessionId: "s", isStreaming: false }; },
    sendCommandWithId: () => ({ id: "x", result: Promise.resolve({}) }),
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: {}, label: "omp", relaunch: () => ({}) });
  wrapper.start();
  try {
    const reads = [
      wrapper.send({ type: "get_subagents" }),
      wrapper.send({ type: "get_subagents" }),
      wrapper.send({ type: "get_subagents" }),
    ];
    assert.deepEqual(sent.filter((type) => type === "get_subagents"), ["get_subagents"], "one copy while the first is waiting its turn");
    release();
    const results = await Promise.all(reads);
    assert.equal(results.length, 3);
    await wrapper.send({ type: "get_subagents" });
    assert.equal(sent.filter((type) => type === "get_subagents").length, 2, "a read after the last one settled goes out fresh");
  } finally { wrapper.destroy(); }
});

// ---------------------------------------------------------------------------
// omp 18.4.x seams: a session omp moves to a new file, ask dialogs, queue
// editing, cache warming, and the commands forwarded as they are.
// ---------------------------------------------------------------------------

/** Set environment variables for one run and put every one of them back. */
async function withEnv(overrides, run) {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settleFor = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scripted stand-in for `omp --mode rpc-ui`: just enough protocol for the
 *  wrapper to start, report an identity and run a command. FAKE_OMP_LOG
 *  records every command it receives; FAKE_OMP_LEGACY=1 plays an omp that
 *  predates the 18.4 commands (they answer "Unknown command"). */
const FAKE_OMP = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const legacy = process.env.FAKE_OMP_LEGACY === "1";
const NEWER = new Set(["set_ask_dialog", "remove_queued_message", "promote_queued_message", "predict_word", "predict_word_feedback", "cancel_subagent", "steer_subagent"]);
let sessionId = process.env.FAKE_OMP_SESSION_ID;
let sessionFile = process.env.FAKE_OMP_SESSION_FILE;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");

if (process.env.FAKE_OMP_STARTS) fs.appendFileSync(process.env.FAKE_OMP_STARTS, JSON.stringify({ tz: process.env.TZ ?? null, args: process.argv.slice(2) }) + "\n");
// omp 18.6.3+: resuming a session whose saved model is gone exits before ready,
// unless --model names another. FAKE_OMP_SAVED_MODEL is the file standing in for
// the session's model_change entry; set_model is what writes it.
if (process.env.FAKE_OMP_SAVED_MODEL && process.argv.includes("--resume") && !process.argv.includes("--model") && !fs.existsSync(process.env.FAKE_OMP_SAVED_MODEL)) {
  process.stderr.write("error: Could not restore model bogusprov/nope-1\n    at lnu (cli.js:24401:18753)\n");
  process.exit(1);
}
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (process.env.FAKE_OMP_LOG) fs.appendFileSync(process.env.FAKE_OMP_LOG, line + "\n");
  const reply = (fields) => send({ type: "response", id: command.id, command: command.type, ...fields });
  if (legacy && NEWER.has(command.type)) return reply({ success: false, error: "Unknown command: " + command.type });
  switch (command.type) {
    case "get_state":
      return reply({ success: true, data: { sessionId, sessionFile, isStreaming: false, isCompacting: false, messageCount: 0, queuedMessageCount: 0 } });
    case "set_ask_dialog":
      return reply({ success: true, data: { enabled: command.enabled === true } });
    case "set_model":
      if (process.env.FAKE_OMP_SAVED_MODEL) fs.writeFileSync(process.env.FAKE_OMP_SAVED_MODEL, command.provider + "/" + command.modelId);
      return reply({ success: true, data: { provider: command.provider, id: command.modelId } });
    case "bash":
      // This write finds the session file owned by another omp process, so omp
      // moves the live session to a sibling file under a new id and says so.
      sessionId = process.env.FAKE_OMP_MOVED_ID;
      sessionFile = process.env.FAKE_OMP_MOVED_FILE;
      send({ type: "notice", level: "warning", source: "session-persistence", message: "Session is open for writing in another omp process, so this session now saves to " + sessionFile + " instead of mixing its entries into that file." });
      // The transcript reaches the new file a moment after the notice.
      setTimeout(() => fs.writeFileSync(sessionFile, "{}\n"), 150);
      return reply({ success: true, data: { output: "", exitCode: 0, cancelled: false, truncated: false } });
    case "fake_emit":
      send(command.frame);
      return reply({ success: true });
    default:
      return reply({ success: true });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** Run `run` against the real startRpcSession with FAKE_OMP as the engine
 *  binary and a private agent dir (accounts, owners and presets included). */
async function withFakeOmp(envFor, run) {
  const { invalidateOmpCliCache } = await jiti.import("./omp/omp-cli.ts");
  const root = mkdtempSync(join(tmpdir(), "cody-rpc-fake-omp-"));
  const bin = join(root, "fake-omp");
  const log = join(root, "commands.log");
  writeFileSync(bin, FAKE_OMP);
  chmodSync(bin, 0o755);
  mkdirSync(join(root, "agent"), { recursive: true });
  const commandsSent = () => (existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : []);
  try {
    return await withEnv({ PI_CODING_AGENT_DIR: join(root, "agent"), CODY_OMP_BIN: bin, FAKE_OMP_LOG: log, ...envFor(root) }, async () => {
      invalidateOmpCliCache();
      return run({ root, commandsSent });
    });
  } finally {
    invalidateOmpCliCache();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a live session omp moves to a new file stays reachable: registry, owner, preset and preview follow it, and every page is told to adopt the new id", async () => {
  const { setSessionOwner, getSessionOwner } = await jiti.import("./auth/session-owners.ts");
  const overlay = await jiti.import("./model-presets/overlay.ts");
  const { resolveDisplaySessionId } = await jiti.import("./display/bus.ts");
  const planOverlay = await jiti.import("./plan-keeper/overlay.ts");
  await withFakeOmp((root) => ({
    FAKE_OMP_SESSION_ID: "old-session",
    FAKE_OMP_SESSION_FILE: join(root, "old.jsonl"),
    FAKE_OMP_MOVED_ID: "moved-session",
    FAKE_OMP_MOVED_FILE: join(root, "moved.jsonl"),
  }), async ({ root, commandsSent }) => {
    setSessionOwner("old-session", "account-1");
    overlay.setSessionPreset("old-session", "high");
    planOverlay.writePlanOverlay("old-session", { subtasks: { "Write the tests": [{ content: "cover the move", status: "pending" }] }, autoCompleted: [], updatedAt: 5 });
    const { session } = await startRpcSession("old-session", join(root, "old.jsonl"), root);
    try {
      assert.deepEqual(
        commandsSent().filter((command) => command.type === "set_ask_dialog").map(({ enabled }) => enabled),
        [true],
        "a fresh child is opted in to ask dialogs",
      );
      assert.equal(getRpcSession("old-session"), session);
      const events = [];
      session.onEvent((event) => events.push(event));

      await session.send({ type: "bash", command: "echo hi" });
      await waitFor(() => events.some((event) => event.type === "cody_session_moved"), "the move announcement");

      const announced = events.filter((event) => event.type === "cody_session_moved");
      assert.equal(announced.length, 1);
      assert.equal(announced[0].sessionId, "moved-session");
      assert.equal(announced[0].previousSessionId, "old-session");
      assert.equal(existsSync(join(root, "moved.jsonl")), true, "announced only once the new file exists to be read");
      assert.ok(events.some((event) => event.type === "notice" && event.source === "session-persistence"), "omp's own notice is still forwarded");

      assert.equal(getRpcSession("moved-session"), session, "the live wrapper answers to its new id");
      assert.equal(getRpcSession("old-session"), undefined, "and no longer to the frozen one");
      assert.equal(session.sessionId, "moved-session");
      assert.equal(session.sessionFile, join(root, "moved.jsonl"));
      assert.equal(getSessionOwner("moved-session"), "account-1", "a session without an owner is visible to every account");
      assert.equal(getSessionOwner("old-session"), "account-1", "the untouched original keeps its owner");
      assert.equal(overlay.readSessionPresetId("moved-session"), "high");
      assert.deepEqual(planOverlay.readPlanOverlay("moved-session")?.subtasks, { "Write the tests": [{ content: "cover the move", status: "pending" }] }, "the plan checklist belongs to the conversation, not the file");
      assert.equal(resolveDisplaySessionId("old-session"), "moved-session", "the preview stream follows the conversation");
    } finally {
      await session.destroyAndWait();
    }
  });
});

test("an omp that predates ask dialogs still starts: the opt-in is refused and ignored", async () => {
  await withFakeOmp((root) => ({
    FAKE_OMP_LEGACY: "1",
    FAKE_OMP_SESSION_ID: "legacy-session",
    FAKE_OMP_SESSION_FILE: join(root, "legacy.jsonl"),
  }), async ({ root, commandsSent }) => {
    const { session } = await startRpcSession("legacy-session", join(root, "legacy.jsonl"), root);
    try {
      assert.equal(session.isAlive(), true);
      assert.equal(getRpcSession("legacy-session"), session);
      assert.ok(commandsSent().some((command) => command.type === "set_ask_dialog"), "it was offered, and refused as unknown");
    } finally {
      await session.destroyAndWait();
    }
  });
});

test("an engine with a restricted RPC vocabulary is never offered the ask dialog opt-in", async () => {
  const sent = [];
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      onFrame: () => () => {},
      waitReady: async () => ({}),
      negotiateProtocol: async () => {},
      sendCommand: async (command) => {
        sent.push(command.type);
        return command.type === "get_state" ? { sessionId: "restricted-engine" } : {};
      },
    },
    process.cwd(),
    { rpcUi: { commands: new Set(["get_state", "prompt"]) }, label: "pi", relaunch: () => ({}) },
  );
  try {
    await wrapper.waitUntilReady();
    // Such an engine answers an unknown command with an id-less error that
    // can never settle the request: asking would hang the session start.
    assert.deepEqual(sent, ["get_state"]);
  } finally {
    await wrapper.destroyAndWait();
  }
});

function createMoveHarness(root) {
  let onFrame = () => {};
  const sent = [];
  const state = { sessionId: "old-session", sessionFile: join(root, "old.jsonl"), isStreaming: false, isCompacting: false };
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame(listener) { onFrame = listener; return () => { onFrame = () => {}; }; },
    sendFrame() {},
    sendCommand: async (command) => {
      sent.push(command);
      if (command.type === "get_state") return { ...state };
      return command.type === "branch" ? { cancelled: false, text: "" } : {};
    },
  };
  const wrapper = new AgentSessionWrapper(proc, root, { rpcUi: {}, label: "omp", relaunch: () => ({}) });
  wrapper.start();
  wrapper.setSessionId("old-session");
  wrapper._sessionFile = state.sessionFile;
  const identityChanges = [];
  wrapper.onIdentityChange((oldId, newId) => identityChanges.push([oldId, newId]));
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, state, sent, events, identityChanges, emitFrame: (frame) => onFrame(frame) };
}

test("a session move is processed once whichever path notices it first, and unrelated notices never trigger one", async () => {
  const { setSessionOwner, getSessionOwner } = await jiti.import("./auth/session-owners.ts");
  for (const firstToNotice of ["the notice", "a state poll", "a state poll alone"]) {
    const root = mkdtempSync(join(tmpdir(), "cody-rpc-move-once-"));
    mkdirSync(join(root, "agent"), { recursive: true });
    const newId = `new-session-${firstToNotice.replace(/\W/g, "-")}`;
    try {
      await withEnv({ PI_CODING_AGENT_DIR: join(root, "agent") }, async () => {
        const { wrapper, state, sent, events, identityChanges, emitFrame } = createMoveHarness(root);
        try {
          setSessionOwner("old-session", "account-1");
          writeFileSync(join(root, "new.jsonl"), "{}\n");

          // A persistence FAILURE and any other warning are not a move.
          emitFrame({ type: "notice", level: "error", source: "session-persistence", message: "Session persistence failed" });
          emitFrame({ type: "notice", level: "warning", message: "something else" });
          await settleFor();
          assert.equal(sent.some((command) => command.type === "get_state"), false, "identity is left alone");

          state.sessionId = newId;
          state.sessionFile = join(root, "new.jsonl");
          const notice = () => emitFrame({ type: "notice", level: "warning", source: "session-persistence", message: "Session moved" });
          const poll = () => wrapper.send({ type: "get_state" });
          // The notice and a state poll both see the new id; the order decides
          // who gets there first, and a poll alone covers a notice that never came.
          if (firstToNotice === "the notice") { notice(); await poll(); }
          else if (firstToNotice === "a state poll") { const polling = poll(); notice(); await polling; }
          else await poll();
          await waitFor(() => events.some((event) => event.type === "cody_session_moved"), "the move announcement");
          await settleFor(60);

          assert.deepEqual(identityChanges, [["old-session", newId]], "the registry callback fires once");
          assert.equal(events.filter((event) => event.type === "cody_session_moved").length, 1, "the page is told once");
          assert.equal(getSessionOwner(newId), "account-1");
        } finally {
          wrapper.destroy();
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a fork re-keys the wrapper and carries its owner over, but is not announced as a session move", async () => {
  const { setSessionOwner, getSessionOwner } = await jiti.import("./auth/session-owners.ts");
  const root = mkdtempSync(join(tmpdir(), "cody-rpc-fork-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  try {
    await withEnv({ PI_CODING_AGENT_DIR: join(root, "agent") }, async () => {
      const { wrapper, state, events, identityChanges } = createMoveHarness(root);
      try {
        setSessionOwner("old-session", "account-1");
        state.sessionId = "forked-session";
        state.sessionFile = join(root, "forked.jsonl");
        // The file is there, so a move announcement would not be held back.
        writeFileSync(state.sessionFile, "{}\n");
        const result = await wrapper.send({ type: "fork", entryId: "entry-1" });
        await settleFor(60);
        assert.deepEqual(result, { cancelled: false, newSessionId: "forked-session" });
        assert.deepEqual(identityChanges, [["old-session", "forked-session"]]);
        assert.equal(getSessionOwner("forked-session"), "account-1");
        assert.equal(getSessionOwner("old-session"), "account-1", "the parent keeps its owner");
        assert.equal(events.some((event) => event.type === "cody_session_moved"), false, "the fork's own answer already tells the page");
      } finally {
        wrapper.destroy();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork_session forks at a message or copies the whole chat with omp's own fork, and the wrapper follows omp onto the new file", async () => {
  const { setSessionOwner, getSessionOwner } = await jiti.import("./auth/session-owners.ts");
  const root = mkdtempSync(join(tmpdir(), "cody-rpc-fork-session-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  try {
    await withEnv({ PI_CODING_AGENT_DIR: join(root, "agent") }, async () => {
      const { wrapper, state, sent, events, identityChanges } = createMoveHarness(root);
      try {
        setSessionOwner("old-session", "account-1");
        const moveTo = (id) => {
          state.sessionId = id;
          state.sessionFile = join(root, `${id}.jsonl`);
          writeFileSync(state.sessionFile, "{}\n");
        };
        moveTo("cut-at-reply");
        assert.deepEqual(await wrapper.send({ type: "fork_session", entryId: "reply-7" }), { cancelled: false, newSessionId: "cut-at-reply" });
        moveTo("whole-copy");
        assert.deepEqual(await wrapper.send({ type: "fork_session" }), { cancelled: false, newSessionId: "whole-copy" });
        await settleFor(60);

        assert.deepEqual(sent.filter((command) => command.type === "fork"), [{ type: "fork", entryId: "reply-7" }, { type: "fork" }], "omp's fork: with the message when there is one, none for the whole chat");
        assert.equal(sent.some((command) => command.type === "branch"), false, "never the user-message fork");
        assert.deepEqual(identityChanges, [["old-session", "cut-at-reply"], ["cut-at-reply", "whole-copy"]]);
        assert.equal(getSessionOwner("whole-copy"), "account-1", "the copy belongs to whoever owned the chat");
        assert.equal(events.some((event) => event.type === "cody_session_moved"), false, "the fork's own answer already tells the page");
      } finally {
        wrapper.destroy();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork_session is refused while the chat is working, before omp is asked, and omp's own session_busy reads the same", async () => {
  const { RpcCommandError } = await jiti.import("./omp/rpc-process.ts");
  const { wrapper } = createQueueHarness();
  const engine = [];
  let answer = null;
  wrapper.proc.sendCommand = async (command) => {
    engine.push(command.type);
    if (command.type === "fork" && answer) throw answer;
    return {};
  };
  const busy = (error) => error instanceof WebRpcError && error.code === "session_busy" && /Wait for the current run/.test(error.message);
  try {
    wrapper.promptRunning = true;
    await assert.rejects(wrapper.send({ type: "fork_session" }), busy);
    assert.equal(engine.includes("fork"), false, "the engine is not even asked");

    wrapper.promptRunning = false;
    answer = new RpcCommandError("fork", "Cannot fork the session while session maintenance or user work is still running", "session_busy");
    await assert.rejects(wrapper.send({ type: "fork_session", entryId: "reply-7" }), busy);

    // An omp that predates fork: its own answer reaches the caller, which hides the control.
    answer = new RpcCommandError("fork", "Unknown command: fork");
    await assert.rejects(wrapper.send({ type: "fork_session" }), (error) => error instanceof RpcCommandError && /Unknown command/.test(error.message));
  } finally { wrapper.destroy(); }
});

test("a prompt with images gets a longer ack bound than a plain one, so a slow vision description cannot recycle the child", async () => {
  const bounds = [];
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      sendCommand: async (command, timeoutMs) => {
        if (command.type === "prompt") bounds.push(timeoutMs);
        return {};
      },
    },
    process.cwd(),
    { rpcUi: {}, label: "omp", relaunch: () => ({}) },
  );
  try {
    await wrapper.send({ type: "prompt", message: "plain" });
    await wrapper.send({ type: "prompt", message: "what is this?", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
    // omp acks only after admission, and with a text-only model that waits on
    // a vision description of up to about 20 s.
    assert.deepEqual(bounds, [30_000, 60_000]);
  } finally {
    await wrapper.destroyAndWait();
  }
});

test("cache-warming frames reach listeners but never keep an unattended child alive or touch its state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const build = () => {
    let onFrame = () => {};
    const wrapper = new AgentSessionWrapper(
      { isAlive: true, dispose: async () => {}, onFrame(listener) { onFrame = listener; return () => {}; }, sendFrame() {}, sendCommand: async () => ({}) },
      process.cwd(),
      { rpcUi: {}, label: "omp", relaunch: () => ({}) },
    );
    wrapper.start();
    return { wrapper, emitFrame: (frame) => onFrame(frame) };
  };
  const warmed = build();
  const control = build();
  const heard = [];
  const detach = warmed.wrapper.onEvent((event) => heard.push(event.type));

  t.mock.timers.tick(9 * 60_000);
  warmed.emitFrame({ type: "cache_warming_start", phase: "idle", provider: "anthropic", model: "m" });
  warmed.emitFrame({ type: "cache_warming_end", phase: "idle", provider: "anthropic", model: "m", outcome: "hit" });
  control.emitFrame({ type: "turn_end" });
  detach();
  assert.deepEqual(heard, ["cache_warming_start", "cache_warming_end"]);
  assert.equal(warmed.wrapper.isRunning(), false, "a cache refresh is not agent activity");

  // The idle window opened at startup closes for the warmed session, whose
  // only traffic was cache refreshes; real activity extends it.
  t.mock.timers.tick(2 * 60_000);
  assert.equal(warmed.wrapper.isAlive(), false);
  assert.equal(control.wrapper.isAlive(), true);
  control.wrapper.destroy();
});

test("an ask dialog waits for its answer like any dialog: replayed to a page that attaches late, gone once omp cancels it, answered as sent", async () => {
  const { wrapper } = createQueueHarness();
  const frames = [];
  wrapper.proc.sendFrame = (frame) => frames.push(frame);
  const emitUi = (frame) => wrapper.handleFrame({ type: "extension_ui_request", ...frame });
  try {
    emitUi({ id: "ask-1", method: "ask", questions: [{ id: "q1", question: "Which one?", options: [{ label: "A" }, { label: "B", description: "second" }] }] });
    const late = [];
    wrapper.onEvent((event) => late.push(event));
    assert.deepEqual(late.map((event) => [event.method, event.id]), [["ask", "ask-1"]], "a reconnecting page still sees the open question");

    emitUi({ id: "cancel-1", method: "cancel", targetId: "ask-1" });
    assert.equal(late.at(-1).method, "cancel", "omp's expiry notice reaches the open page");
    const afterwards = [];
    wrapper.onEvent((event) => afterwards.push(event));
    assert.deepEqual(afterwards, [], "an expired question is not replayed");

    await wrapper.send({ type: "extension_ui_response", id: "ask-2", answers: [{ id: "q1", selectedOptions: ["A"], customInput: "because" }] });
    await wrapper.send({ type: "extension_ui_response", id: "ask-3", cancelled: true });
    assert.deepEqual(frames, [
      { type: "extension_ui_response", id: "ask-2", answers: [{ id: "q1", selectedOptions: ["A"], customInput: "because" }] },
      { type: "extension_ui_response", id: "ask-3", cancelled: true },
    ]);
  } finally { wrapper.destroy(); }
});

test("the omp 18.4 commands are forwarded as they are, answers come back untouched, and omp's refusal reaches the caller in omp's own words", async () => {
  const { RpcCommandError } = await jiti.import("./omp/rpc-process.ts");
  const { wrapper } = createQueueHarness();
  const seen = [];
  wrapper.proc.sendCommand = async (command) => {
    seen.push(command);
    if (command.type === "predict_word") return { suffix: "p" };
    if (command.type === "cancel_subagent") return { cancelled: true };
    if (command.type === "steer_subagent" || command.type === "predict_word_feedback") return undefined;
    throw new RpcCommandError(command.type, `Unknown command: ${command.type}`);
  };
  try {
    assert.deepEqual(await wrapper.send({ type: "predict_word", text: "hel", cursor: 3 }), { suffix: "p" });
    assert.equal(await wrapper.send({ type: "predict_word_feedback", text: "hel", cursor: 3, suggestion: "p", accepted: true }), null);
    assert.deepEqual(await wrapper.send({ type: "cancel_subagent", subagentId: "sub-1" }), { cancelled: true });
    assert.equal(await wrapper.send({ type: "steer_subagent", subagentId: "sub-1", message: "look here" }), null);
    assert.deepEqual(seen, [
      { type: "predict_word", text: "hel", cursor: 3 },
      { type: "predict_word_feedback", text: "hel", cursor: 3, suggestion: "p", accepted: true },
      { type: "cancel_subagent", subagentId: "sub-1" },
      { type: "steer_subagent", subagentId: "sub-1", message: "look here" },
    ]);
    for (const type of ["remove_queued_message", "promote_queued_message"]) {
      await assert.rejects(
        wrapper.send({ type, message: "m", queue: "followUp" }),
        (error) => error instanceof RpcCommandError && /Unknown command/.test(error.message),
      );
    }
  } finally { wrapper.destroy(); }
});

test("Steer on a follow-up omp already holds promotes it by the exact text sent, and from then on it is a steer", async () => {
  const { wrapper, emitFrame } = createQueueHarness();
  const engine = [];
  wrapper.proc.sendCommand = async (command) => {
    engine.push(command);
    if (command.type === "promote_queued_message") return { promoted: true };
    if (command.type === "remove_queued_message") return { removed: true };
    return {};
  };
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    emitFrame({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
    await wrapper.send({ type: "follow_up", message: "  keep going\n", clientMessageId: "f1" });
    assert.equal(wrapper.getDeliveryLedger(["f1"])[0].status, "queued");

    assert.deepEqual(await wrapper.send({ type: "steer_now", clientMessageId: "f1" }), { steered: true, mode: "next_step" });
    assert.deepEqual(
      engine.filter((command) => command.type === "promote_queued_message"),
      [{ type: "promote_queued_message", message: "  keep going\n" }],
      "omp finds a queued message by the text as submitted, not the trimmed ledger text",
    );
    assert.equal(engine.some((command) => command.type === "abort"), false, "a running tool is never aborted for a steer");

    // It sits in omp's steering queue now, so that is where it is taken back from.
    assert.deepEqual(await wrapper.send({ type: "withdraw_queued", clientMessageId: "f1" }), { withdrawn: true, text: "  keep going\n", images: [] });
    assert.deepEqual(engine.find((command) => command.type === "remove_queued_message"), { type: "remove_queued_message", message: "  keep going\n", queue: "steering" });
    assert.equal(wrapper.getDeliveryLedger(["f1"])[0].status, "withdrawn");
  } finally { wrapper.destroy(); }
});

test("Delete and Edit take a message omp already queued back out of omp's queue, attachments included", async () => {
  const { wrapper, emitFrame } = createQueueHarness();
  const engine = [];
  wrapper.proc.sendCommand = async (command) => {
    engine.push(command);
    return command.type === "remove_queued_message" ? { removed: true } : {};
  };
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "prompt", message: "look at this ", images: [image], streamingBehavior: "steer", clientMessageId: "s1" });
    const snapshot = wrapper.getDeliveryLedger(["s1"])[0];
    assert.equal(snapshot.status, "queued");
    assert.equal("submitted" in snapshot, false, "the payload is bookkeeping, never part of a snapshot");

    assert.deepEqual(await wrapper.send({ type: "withdraw_queued", clientMessageId: "s1" }), { withdrawn: true, text: "look at this ", images: [image] });
    assert.deepEqual(engine.find((command) => command.type === "remove_queued_message"), { type: "remove_queued_message", message: "look at this ", queue: "steering" });
    assert.equal(wrapper.getDeliveryLedger(["s1"])[0].status, "withdrawn");
  } finally { wrapper.destroy(); }
});

test("on an omp without queue editing, Steer still refuses an in-queue follow-up and Delete still says it was handed over", async () => {
  const { RpcCommandError } = await jiti.import("./omp/rpc-process.ts");
  const { wrapper, emitFrame } = createQueueHarness();
  const engine = [];
  wrapper.proc.sendCommand = async (command) => {
    engine.push(command.type);
    if (command.type === "promote_queued_message" || command.type === "remove_queued_message") {
      throw new RpcCommandError(command.type, `Unknown command: ${command.type}`);
    }
    return {};
  };
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "follow_up", message: "later", clientMessageId: "f1" });
    assert.equal((await wrapper.send({ type: "steer_now", clientMessageId: "f1" })).reason, "not_steer");
    assert.deepEqual(await wrapper.send({ type: "withdraw_queued", clientMessageId: "f1" }), { withdrawn: false, reason: "already_sent" });
    assert.equal(wrapper.getDeliveryLedger(["f1"])[0].status, "queued", "nothing was changed on the engine or in the ledger");
    assert.equal(engine.includes("abort"), false);
  } finally { wrapper.destroy(); }
});

test("an engine with a restricted RPC vocabulary is never sent omp's queue commands, so Delete and Steer answer as they always did", async () => {
  const sent = [];
  let onFrame = () => {};
  const wrapper = new AgentSessionWrapper(
    {
      isAlive: true,
      dispose: async () => {},
      onFrame(listener) { onFrame = listener; return () => {}; },
      sendFrame() {},
      sendCommand: async (command) => { sent.push(command.type); return {}; },
      sendCommandWithId: () => ({ id: "x", result: Promise.resolve({ agentInvoked: true }) }),
    },
    process.cwd(),
    { rpcUi: { commands: new Set(["follow_up", "prompt", "get_state"]) }, label: "pi", relaunch: () => ({}) },
  );
  wrapper.start();
  try {
    wrapper.promptRunning = true;
    onFrame({ type: "agent_start" });
    await wrapper.send({ type: "follow_up", message: "later", clientMessageId: "f1" });
    // Such an engine answers an unknown command with an id-less error that can
    // never settle the request: sending one would hang Delete and Steer.
    assert.equal((await wrapper.send({ type: "steer_now", clientMessageId: "f1" })).reason, "not_steer");
    assert.deepEqual(await wrapper.send({ type: "withdraw_queued", clientMessageId: "f1" }), { withdrawn: false, reason: "already_sent" });
    assert.deepEqual(sent, [], "nothing outside the engine's vocabulary reached it");
  } finally { wrapper.destroy(); }
});

test("a message omp read while the request was on its way is neither promoted nor taken back, and other failures are not swallowed", async () => {
  const { wrapper, emitFrame } = createQueueHarness();
  let reply = { promoted: false, removed: false };
  wrapper.proc.sendCommand = async (command) => {
    if (command.type === "promote_queued_message") return { promoted: reply.promoted };
    if (command.type === "remove_queued_message") {
      if (reply.error) throw reply.error;
      return { removed: reply.removed };
    }
    return {};
  };
  try {
    wrapper.promptRunning = true;
    emitFrame({ type: "agent_start" });
    await wrapper.send({ type: "follow_up", message: "gone already", clientMessageId: "f1" });
    assert.equal((await wrapper.send({ type: "steer_now", clientMessageId: "f1" })).reason, "already_read");
    assert.deepEqual(await wrapper.send({ type: "withdraw_queued", clientMessageId: "f1" }), { withdrawn: false, reason: "already_sent" });
    assert.equal(wrapper.getDeliveryLedger(["f1"])[0].status, "queued", "the engine's answer is not the ledger's to overrule");

    reply = { ...reply, error: new Error("engine exploded") };
    await assert.rejects(wrapper.send({ type: "withdraw_queued", clientMessageId: "f1" }), /engine exploded/);
  } finally { wrapper.destroy(); }
});

// ---------------------------------------------------------------------------
// Time zones: the zone a child starts under, the zone each message carries, the
// question lib/omp/extensions/cody-local-time.ts asks before every prompt, and
// the restart a change of zone needs.
// ---------------------------------------------------------------------------

const TIME_ZONE_QUESTION = (id) => ({ type: "extension_ui_request", id, method: "input", title: 'CODY_TIME_ZONE {"v":1}' });

/** The `TZ` of every omp child started so far, oldest first. */
const childZones = (root) => {
  const file = join(root, "starts.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).tz) : [];
};

/** Have the fake omp print a frame exactly as the real one would. */
const fakeEmit = (session, frame) => session.proc.sendCommand({ type: "fake_emit", frame });

/** Env for a fake omp whose accounts, sessions and start log live under `root`. */
const zoneEnv = (root, extra = {}) => ({
  FAKE_OMP_STARTS: join(root, "starts.log"),
  FAKE_OMP_SESSION_FILE: join(root, "s.jsonl"),
  CODY_ACCOUNTS_DIR: join(root, "accounts"),
  ...extra,
});

test("the local-time extension's question is answered at once with the message's zone and the shell's, and never reaches a page", async () => {
  const { wrapper, events, frames, emitFrame } = createDeliveryHarness(undefined, { timeZone: "Asia/Tokyo" });
  try {
    const answerTo = (id) => JSON.parse(frames.find((frame) => frame.id === id).value);

    emitFrame(TIME_ZONE_QUESTION("q1"));
    assert.deepEqual(answerTo("q1"), { zone: "Asia/Tokyo", shell: "Asia/Tokyo" }, "before any message the child's own zone answers");

    await wrapper.send({ type: "prompt", message: "hello", streamingBehavior: "steer", timeZone: "America/New_York" });
    emitFrame(TIME_ZONE_QUESTION("q2"));
    assert.deepEqual(answerTo("q2"), { zone: "America/New_York", shell: "Asia/Tokyo" }, "the message's zone — and the shell's, which a running process cannot change");

    // A command that merely carries a bad value must not move the agent's clock.
    await wrapper.send({ type: "steer", message: "again", timeZone: "Mars/Phobos" });
    emitFrame(TIME_ZONE_QUESTION("q3"));
    assert.equal(answerTo("q3").zone, "America/New_York");

    assert.deepEqual(frames.map((frame) => frame.type), ["extension_ui_response", "extension_ui_response", "extension_ui_response"]);
    assert.equal(events.some((event) => event.type === "extension_ui_request"), false, "no page is shown the question");
    assert.equal(wrapper.hasPendingInput(), false, "and nothing waits on a person");
  } finally { await wrapper.destroyAndWait(); }
});

test("the hidden per-prompt line never reaches a page, while the engine's other hidden messages still do", async () => {
  const { wrapper, events, emitFrame } = createDeliveryHarness();
  try {
    const hidden = { role: "custom", customType: "cody-local-time", content: "Current local time: Friday 2 October 2026, 14:58 EDT (America/New_York, UTC-04:00).", display: false, timestamp: 1 };
    // The MCP mount notice drives a live toast, so it has to keep arriving.
    const mount = { role: "custom", customType: "xdev-mount-notice", content: "xd:// device inventory changed.", display: false, timestamp: 2 };
    for (const message of [hidden, mount]) {
      emitFrame({ type: "message_start", message });
      emitFrame({ type: "message_end", message });
    }
    assert.deepEqual(
      events.filter((event) => event.type.startsWith("message_")).map((event) => `${event.type}:${event.message.customType}`),
      ["message_start:xdev-mount-notice", "message_end:xdev-mount-notice"],
    );
  } finally { await wrapper.destroyAndWait(); }
});

test("a child starts under the zone it was started for, else its owner's, else the server's", async () => {
  const { createUser } = await jiti.import("./auth/users.ts");
  const { setSessionOwner } = await jiti.import("./auth/session-owners.ts");
  const prefs = await jiti.import("./time-zone-prefs.ts");
  await withFakeOmp((root) => zoneEnv(root, { FAKE_OMP_SESSION_ID: "tz-owner", TZ: "Australia/Sydney" }), async ({ root }) => {
    const startOnce = async (spawn) => {
      const { session } = await startRpcSession("tz-owner", join(root, "s.jsonl"), root, undefined, false, undefined, undefined, undefined, undefined, spawn);
      const zone = session.timeZone;
      await session.destroyAndWait();
      return zone;
    };
    assert.equal(await startOnce(undefined), "Australia/Sydney", "nobody owns it and nobody typed: the server's zone");

    const traveler = createUser({ username: "traveler", fullName: "Traveler", passwordHash: "x", role: "member" });
    setSessionOwner("tz-owner", traveler.id);
    prefs.noteDeviceTimeZone(traveler, "Pacific/Auckland");
    assert.equal(await startOnce(undefined), "Pacific/Auckland", "a session merely viewed starts where its owner was last seen");

    prefs.setExplicitTimeZone(traveler, "Europe/Paris");
    assert.equal(await startOnce(undefined), "Europe/Paris", "their own choice beats where they were last seen");

    assert.equal(await startOnce({ timeZone: "Asia/Tokyo" }), "Asia/Tokyo", "the zone the caller resolved for a message is the child's TZ");
    assert.deepEqual(childZones(root), ["Australia/Sydney", "Pacific/Auckland", "Europe/Paris", "Asia/Tokyo"], "and it is what the child process really ran under");
  });
});

test("a change of zone restarts an idle child before the message goes out, and never one that is mid-turn", async () => {
  await withFakeOmp((root) => zoneEnv(root, { FAKE_OMP_SESSION_ID: "tz-restart" }), async ({ root, commandsSent }) => {
    const { session } = await startRpcSession("tz-restart", join(root, "s.jsonl"), root, undefined, false, undefined, undefined, undefined, undefined, { timeZone: "America/New_York" });
    try {
      assert.deepEqual(childZones(root), ["America/New_York"]);
      assert.equal(await alignSessionTimeZone(session, "America/New_York"), session);
      assert.deepEqual(childZones(root), ["America/New_York"], "the same zone is no reason to restart");

      // The tablet lands in Tokyo and its next message arrives while the chat is idle.
      assert.equal(await alignSessionTimeZone(session, "Asia/Tokyo"), session, "the same wrapper carries on");
      assert.deepEqual(childZones(root), ["America/New_York", "Asia/Tokyo"]);
      assert.equal(session.timeZone, "Asia/Tokyo");
      assert.equal(getRpcSession("tz-restart"), session, "still the registered session, listeners and ledger intact");

      await session.send({ type: "prompt", message: "what time is it", timeZone: "Asia/Tokyo" });
      const sent = commandsSent().map((command) => command.type);
      assert.ok(sent.lastIndexOf("set_ask_dialog") < sent.lastIndexOf("prompt"), "the message went to the new child, after its start-up");
      assert.equal(session.isRunning(), true, "a turn is now running");

      // The device moves again mid-turn: nothing is restarted, but the agent's
      // clock and Cody's tools already speak the new zone.
      await session.send({ type: "steer", message: "also", timeZone: "Europe/Paris" });
      assert.equal(await alignSessionTimeZone(session, "Europe/Paris"), session);
      assert.deepEqual(childZones(root), ["America/New_York", "Asia/Tokyo"], "a running turn is never killed for a clock");
      assert.equal(session.timeZone, "Asia/Tokyo", "the shell still runs in the old zone");
      assert.equal(getSessionTimeZone("tz-restart"), "Europe/Paris");

      // Once the turn is over, the next message from Paris moves the child.
      await fakeEmit(session, { type: "agent_end", isTerminal: true, messages: [] });
      await waitFor(() => !session.isRunning(), "the turn to end");
      await alignSessionTimeZone(session, "Europe/Paris");
      assert.deepEqual(childZones(root), ["America/New_York", "Asia/Tokyo", "Europe/Paris"]);
      assert.equal(session.timeZone, "Europe/Paris");
    } finally {
      await session.destroyAndWait();
    }
  });
});

test("concurrent messages from a new zone share one restart instead of racing it", async () => {
  await withFakeOmp((root) => zoneEnv(root, { FAKE_OMP_SESSION_ID: "tz-join" }), async ({ root }) => {
    const { session } = await startRpcSession("tz-join", join(root, "s.jsonl"), root, undefined, false, undefined, undefined, undefined, undefined, { timeZone: "America/New_York" });
    try {
      await Promise.all([alignSessionTimeZone(session, "Asia/Tokyo"), alignSessionTimeZone(session, "Asia/Tokyo"), alignSessionTimeZone(session, "Asia/Tokyo")]);
      assert.deepEqual(childZones(root), ["America/New_York", "Asia/Tokyo"], "one restart, not three");
    } finally {
      await session.destroyAndWait();
    }
  });
});

test("a message the engine has not finished with keeps its child where it is", async () => {
  const { wrapper } = createDeliveryHarness(undefined, { timeZone: "America/New_York" });
  try {
    wrapper.promptRunning = true;
    await wrapper.send({ type: "follow_up", message: "later", clientMessageId: "m1" });
    wrapper.promptRunning = false;
    wrapper.streaming = false;
    assert.equal(wrapper.getDeliveryLedger(["m1"])[0].status, "queued");
    assert.equal(await wrapper.alignTimeZone("Asia/Tokyo"), false, "restarting would fail the queued message");
    assert.equal(wrapper.timeZone, "America/New_York");
  } finally { await wrapper.destroyAndWait(); }
});

test("Cody's tools print times in the zone of the newest message", async () => {
  await withFakeOmp((root) => zoneEnv(root, { FAKE_OMP_SESSION_ID: "tz-tools" }), async ({ root, commandsSent }) => {
    const sessionsDir = join(root, "agent", "sessions", "-project");
    mkdirSync(sessionsDir, { recursive: true });
    const file = join(sessionsDir, "clocked.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "clocked", cwd: "/proj", title: "Clocked" })}\n`);
    const moment = new Date("2026-10-01T23:31:39.753Z");
    utimesSync(file, moment, moment);

    const { session } = await startRpcSession("tz-tools", join(root, "s.jsonl"), root, undefined, false, undefined, undefined, undefined, undefined, { timeZone: "America/New_York" });
    try {
      const listing = async (id) => {
        await fakeEmit(session, { type: "host_tool_call", id, toolName: "list_sessions", arguments: {} });
        await waitFor(() => commandsSent().some((command) => command.type === "host_tool_result" && command.id === id), `the answer to ${id}`);
        return commandsSent().find((command) => command.type === "host_tool_result" && command.id === id).result.content[0].text;
      };
      assert.match(await listing("t1"), /clocked \| .* \| 2026-10-01 19:31 EDT$/m, "in the zone the chat started in");

      await session.send({ type: "prompt", message: "from the other side of the world", streamingBehavior: "steer", timeZone: "Asia/Tokyo" });
      const tokyo = await listing("t2");
      assert.match(tokyo, /2026-10-02 08:31 UTC\+09:00$/m, "and in the zone of the newest message once the device moves");
      assert.doesNotMatch(tokyo, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "never as a bare UTC string");
    } finally {
      await session.destroyAndWait();
    }
  });
});

test("an ACP engine is moved to a new zone by closing its idle child and starting the session again, never mid-turn", async () => {
  const { claudeHarness } = await jiti.import("./harness/claude.ts");
  const { AcpEngineSession } = await jiti.import("./harness/acp-session.ts");
  const stub = fileURLToPath(new URL("./harness/acp-agent-stub.mjs", import.meta.url));
  const spec = { id: "stubengine", name: "StubEngine", binaryPath: process.execPath, args: [stub], env: { ACP_STUB_ECHO_TZ: "1", ACP_STUB_DELAY_MS: "300" }, setupHint: "" };
  const realCreateSession = claudeHarness.createSession;
  claudeHarness.createSession = (options) => new AcpEngineSession(spec, options);
  const root = mkdtempSync(join(tmpdir(), "cody-rpc-acp-zone-"));
  try {
    await withEnv({ CODY_HARNESS: "claude", PI_CODING_AGENT_DIR: join(root, "agent"), CODY_ACCOUNTS_DIR: join(root, "accounts"), PI_CONFIG_DIR: join(root, "agent") }, async () => {
      mkdirSync(join(root, "agent"), { recursive: true });
      const { session, realSessionId } = await startRpcSession("acp-zone", "", root, undefined, false, "", undefined, undefined, undefined, { timeZone: "America/New_York" });
      let current = session;
      try {
        assert.equal(current.timeZone, "America/New_York");
        assert.equal(await alignSessionTimeZone(current, "America/New_York"), current, "same zone: same session");

        const moved = await alignSessionTimeZone(current, "Asia/Tokyo");
        assert.notEqual(moved, current, "an ACP child cannot be restarted in place");
        assert.equal(current.isAlive(), false, "the idle child was closed");
        assert.equal(moved.timeZone, "Asia/Tokyo");
        assert.equal(getRpcSession(realSessionId), moved, "and the registry answers with its replacement under the same id");
        current = moved;

        // Mid-turn the child stays: the next idle message moves it.
        await current.send({ type: "prompt", message: "start a turn" });
        assert.equal(current.isRunning(), true);
        assert.equal(await alignSessionTimeZone(current, "Europe/Paris"), current);
        assert.equal(current.timeZone, "Asia/Tokyo", "a running turn is never closed for a clock");
      } finally {
        await current.destroyAndWait();
      }
    });
  } finally {
    claudeHarness.createSession = realCreateSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the local-time extension and the wrapper agree on the question, the answer, and what the agent reads", async () => {
  const extension = await jiti.import("./omp/extensions/cody-local-time.ts");
  let beforeAgentStart;
  extension.default({ on: (_event, handler) => { beforeAgentStart = handler; } });

  const { wrapper, frames, events, emitFrame } = createDeliveryHarness(undefined, { timeZone: "Asia/Tokyo" });
  try {
    // The tablet that was in Tokyo sends from New York while the Tokyo child is still running.
    await wrapper.send({ type: "prompt", message: "what time is it?", streamingBehavior: "steer", timeZone: "America/New_York" });
    const branch = [{ type: "custom_message", customType: "cody-local-time", display: false, details: { zone: "Asia/Tokyo" } }];
    // omp's dialog goes out as a frame; the wrapper's reply comes back as the dialog's answer.
    const ctx = {
      mode: "rpc",
      agent: { kind: "main" },
      sessionManager: { getBranch: () => branch },
      ui: {
        input: async (title) => {
          emitFrame({ type: "extension_ui_request", id: "ask-1", method: "input", title });
          return frames.find((frame) => frame.id === "ask-1")?.value;
        },
      },
    };
    const { message } = await beforeAgentStart({ prompt: "what time is it?" }, ctx);
    assert.match(message.content, /^The user's device time zone changed: was Asia\/Tokyo, now America\/New_York\. Current local time: .*\(America\/New_York, UTC-0[45]:00\)\. /);
    assert.match(message.content, /Shell commands \(`date`\) still report Asia\/Tokyo until the next idle restart\.$/);
    assert.equal(events.some((event) => event.type === "extension_ui_request"), false, "the question never became a dialog on a page");
  } finally { await wrapper.destroyAndWait(); }
});

test("a main chat's agent is offered the scheduling tools; the sidebar and a minimal local profile are not", async () => {
  const { SCHEDULE_TOOL_NAMES } = await jiti.import("./scheduled/tools.ts");
  const offered = (engine, minimal = false) => {
    const { wrapper } = createDeliveryHarness(undefined, engine);
    if (minimal) wrapper.localProfileLaunch = { profileId: "minimal" };
    return { wrapper, names: wrapper.hostToolsForCurrentProfile().map((tool) => tool.name) };
  };
  const main = offered({});
  const sidebar = offered({ kind: "sidebar" });
  const minimal = offered({}, true);
  try {
    assert.deepEqual(SCHEDULE_TOOL_NAMES, ["schedule_message", "list_scheduled", "cancel_scheduled"]);
    for (const name of SCHEDULE_TOOL_NAMES) {
      assert.ok(main.names.includes(name), `${name} is in a main chat's roster`);
      assert.ok(!sidebar.names.includes(name), `${name} is not offered to the sidebar chat`);
      assert.ok(!minimal.names.includes(name), `${name} is not offered to a minimal local profile`);
    }
    // The page's own tools are published beside them, never instead of them.
    main.wrapper.hostTools = [{ name: "open_preview", description: "x", parameters: { type: "object", properties: {} } }];
    const merged = main.wrapper.hostToolsForCurrentProfile().map((tool) => tool.name);
    assert.ok(merged.includes("open_preview") && merged.includes("schedule_message"));
  } finally {
    await Promise.all([main.wrapper, sidebar.wrapper, minimal.wrapper].map((wrapper) => wrapper.destroyAndWait()));
  }
});

test("an agent's scheduling calls are settled by Cody for that chat: stored as the agent's, listed, and withdrawn by id", async () => {
  const schedule = await jiti.import("./scheduled/store.ts");
  await withFakeOmp((root) => zoneEnv(root, { FAKE_OMP_SESSION_ID: "sched-tools" }), async ({ root, commandsSent }) => {
    const { session } = await startRpcSession("sched-tools", join(root, "s.jsonl"), root, undefined, false, undefined, undefined, undefined, undefined, { timeZone: "America/New_York" });
    try {
      await waitFor(
        () => commandsSent().some((command) => command.type === "set_host_tools" && command.tools.some((tool) => tool.name === "schedule_message")),
        "the roster that carries the scheduling tools",
      );
      const call = async (id, toolName, args) => {
        await fakeEmit(session, { type: "host_tool_call", id, toolName, arguments: args });
        await waitFor(() => commandsSent().some((command) => command.type === "host_tool_result" && command.id === id), `the answer to ${id}`);
        return commandsSent().find((command) => command.type === "host_tool_result" && command.id === id).result.content[0].text;
      };

      const at = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      const scheduled = await call("s1", "schedule_message", { message: "run the full suite and report", at });
      assert.match(scheduled, /^Scheduled sch_\S+ for \d{4}-\d{2}-\d{2} \d{2}:\d{2} E[DS]T \(in 3 h\)\./, "the time is told in the chat's own zone, with how far off it is");
      const [stored] = schedule.listItemsForSession("sched-tools");
      assert.equal(stored.message, "run the full suite and report");
      assert.equal(stored.source, "agent", "marked as the agent's");
      assert.equal(stored.mode, "at");

      assert.match(await call("s2", "list_scheduled", {}), new RegExp(`${stored.id} \\| .* \\| by the agent \\| pending \\| "run the full suite and report"`));
      assert.match(await call("s3", "cancel_scheduled", { id: stored.id }), /^Cancelled /);
      assert.deepEqual(schedule.listItemsForSession("sched-tools"), []);
      assert.equal(await call("s4", "list_scheduled", {}), "Nothing is scheduled for this chat.");
      assert.match(await call("s5", "schedule_message", { message: "x", at: "yesterday" }), /could not be read/, "a refusal is an answer, not a stuck turn");
    } finally {
      await session.destroyAndWait();
    }
  });
});

test("what is scheduled for a chat goes with it when omp moves the live session to a new id", async () => {
  const schedule = await jiti.import("./scheduled/store.ts");
  await withFakeOmp((root) => ({
    FAKE_OMP_SESSION_ID: "sched-old",
    FAKE_OMP_SESSION_FILE: join(root, "old.jsonl"),
    FAKE_OMP_MOVED_ID: "sched-moved",
    FAKE_OMP_MOVED_FILE: join(root, "moved.jsonl"),
  }), async ({ root }) => {
    const inserted = schedule.insertItem({ sessionId: "sched-old", accountKey: "", message: "carry on", mode: "at", dueAt: Date.now() + 60_000, source: "user" });
    assert.equal(inserted.ok, true);
    const { session } = await startRpcSession("sched-old", join(root, "old.jsonl"), root);
    try {
      const events = [];
      session.onEvent((event) => events.push(event));
      await session.send({ type: "bash", command: "echo hi" });
      await waitFor(() => events.some((event) => event.type === "cody_session_moved"), "the move announcement");
      assert.deepEqual(schedule.listItemsForSession("sched-old"), [], "never copied: both ids would send it");
      assert.deepEqual(schedule.listItemsForSession("sched-moved").map((item) => item.id), [inserted.item.id]);
    } finally {
      await session.destroyAndWait();
    }
  });
});

// ---------------------------------------------------------------------------
// omp 18.6.3+: a chat whose saved model is gone does not start. Reopening it is
// a one-time choice of another model, not a standing override.
// ---------------------------------------------------------------------------

const childArgs = (root) => {
  const file = join(root, "starts.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).args) : [];
};
const modelFlag = (args) => (args.includes("--model") ? args[args.indexOf("--model") + 1] : null);

test("a chat whose saved model is gone fails with a structured error naming it, and leaves nothing half-started", async () => {
  const { unrestorableModelOf } = await jiti.import("./rpc-manager.ts");
  await withFakeOmp((root) => zoneEnv(root, { FAKE_OMP_SESSION_ID: "gone-model", FAKE_OMP_SAVED_MODEL: join(root, "saved-model") }), async ({ root }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = await startRpcSession("gone-model", join(root, "s.jsonl"), root).then(() => assert.fail("the child exits before ready"), (error) => error);
      assert.equal(failure.code, "model_unrestorable");
      assert.deepEqual(unrestorableModelOf(failure), { provider: "bogusprov", modelId: "nope-1" });
      assert.match(failure.message, /bogusprov\/nope-1/);
      assert.equal(getRpcSession("gone-model"), undefined, "no session is registered for a child that never started");
    }
    assert.deepEqual(childArgs(root).map(modelFlag), [null, null], "nothing forced a model on the plain retry");
  });
});

test("recovering a chat resumes it once with the chosen model, records it, and later restarts no longer force it", async () => {
  await withFakeOmp((root) => zoneEnv(root, { FAKE_OMP_SESSION_ID: "recover-model", FAKE_OMP_SAVED_MODEL: join(root, "saved-model") }), async ({ root, commandsSent }) => {
    const { session } = await startRpcSession("recover-model", join(root, "s.jsonl"), root, undefined, false, undefined, undefined, undefined, undefined, { timeZone: "America/New_York", restoreModel: { provider: "anthropic", modelId: "claude-opus-5-5" } });
    try {
      assert.equal(getRpcSession("recover-model"), session);
      assert.deepEqual(childArgs(root).map(modelFlag), ["anthropic/claude-opus-5-5"], "this one spawn names the model");
      const written = commandsSent().filter((command) => command.type === "set_model");
      assert.deepEqual(written.map(({ provider, modelId }) => ({ provider, modelId })), [{ provider: "anthropic", modelId: "claude-opus-5-5" }], "the choice is written into the session, which is what makes it stick");

      // A later restart (here a change of zone) resumes from the session alone.
      await alignSessionTimeZone(session, "Asia/Tokyo");
      assert.deepEqual(childArgs(root).map(modelFlag), ["anthropic/claude-opus-5-5", null], "the restart does not carry the override");
      assert.equal(session.isAlive(), true, "and it starts, because the session now has a model");
    } finally {
      await session.destroyAndWait();
    }
  });
});

test("a recovery model that could be read as a flag never reaches the command line", () => {
  const harness = { id: "omp", displayName: "omp", binaryName: "omp", resolveBinary: () => "/bin/omp", rpcUi: { mode: "rpc-ui", supportsCwdFlag: true, resumeFlag: "--resume", supportsAdvisor: true } };
  const launch = (restoreModel) => buildEngineRpcLaunch(harness, { cwd: "/tmp", sessionFile: "/tmp/s.jsonl", restoreModel });
  assert.equal(modelFlag(launch({ provider: "openrouter", modelId: "vendor/model-1" }).args), "openrouter/vendor/model-1", "an id with slashes of its own is passed whole");
  assert.equal(modelFlag(launch(undefined).args), null);
  assert.throws(() => launch({ provider: "--config", modelId: "x" }), (error) => error.code === "invalid_model");
});

function goalFixture(overrides = {}) {
  const goal = { id: "g1", objective: "ship it", status: "active", tokenBudget: 5000, tokensUsed: 250, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2, ...overrides };
  return { goal, state: { enabled: true, mode: "active", goal } };
}

test("a goal command is checked and cut down to what the engine reads, then answered with the engine's own {goal, state}", async () => {
  const sent = [];
  const answer = goalFixture();
  const wrapper = new AgentSessionWrapper(
    { isAlive: true, dispose: async () => {}, sendCommand: async (command) => { sent.push(command); return answer; } },
    process.cwd(),
    { rpcUi: { commands: new Set(["goal"]) }, label: "omp", relaunch: () => ({}) },
  );
  try {
    assert.equal(await wrapper.send({ type: "goal", op: "create", objective: "  ship it  ", token_budget: 5000, stray: true }), answer);
    assert.deepEqual(sent.pop(), { type: "goal", op: "create", objective: "ship it", token_budget: 5000 });
    await wrapper.send({ type: "goal", op: "create", objective: "no budget", token_budget: null });
    assert.deepEqual(sent.pop(), { type: "goal", op: "create", objective: "no budget" });
    // Only a create carries an objective or a budget.
    await wrapper.send({ type: "goal", op: "pause", objective: "ignored", token_budget: 7 });
    assert.deepEqual(sent.pop(), { type: "goal", op: "pause" });

    const refused = [
      {}, { op: "bogus" }, { op: "constructor" }, { op: "create" }, { op: "create", objective: "   " }, { op: "create", objective: 42 },
      { op: "create", objective: "x", token_budget: 0 }, { op: "create", objective: "x", token_budget: -1 },
      { op: "create", objective: "x", token_budget: 1.5 }, { op: "create", objective: "x", token_budget: "200" },
    ];
    for (const bad of refused) {
      await assert.rejects(wrapper.send({ type: "goal", ...bad }), (error) => error instanceof WebRpcError && error.code === "invalid_goal", JSON.stringify(bad));
    }
    assert.deepEqual(sent, [], "nothing malformed reaches the engine");
  } finally {
    await wrapper.destroyAndWait();
  }
});

test("an engine without goal mode refuses goal as unsupported instead of waiting for an answer that never comes", async () => {
  const sent = [];
  const wrapper = new AgentSessionWrapper(
    { isAlive: true, dispose: async () => {}, sendCommand: async (command) => { sent.push(command); return {}; } },
    process.cwd(),
    { rpcUi: { commands: new Set(["prompt", "get_state"]) }, label: "pi", relaunch: () => ({}) },
  );
  try {
    await assert.rejects(wrapper.send({ type: "goal", op: "get" }), (error) => error.code === "unsupported");
    assert.deepEqual(sent, []);
  } finally {
    await wrapper.destroyAndWait();
  }
});

test("the state carries the engine's goal only when the engine reported one, with how long its clock has been waiting", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cody-rpc-goal-state-"));
  const base = { sessionId: "goal-state", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: false, messageCount: 0 };
  let reply = { ...base };
  const wrapper = new AgentSessionWrapper(
    { isAlive: true, dispose: async () => {}, sendCommand: async () => reply },
    process.cwd(),
    { rpcUi: {}, label: "omp", relaunch: () => ({}) },
  );
  try {
    // An older omp (and pi, and the ACP engines) send no `goal` key: the state must not grow one.
    const older = await wrapper.send({ type: "get_state" });
    assert.equal("goal" in older, false);
    assert.equal("goalAgeMs" in older, false);

    reply = { ...base, goal: null };
    const none = await wrapper.send({ type: "get_state" });
    assert.equal(none.goal, null, "the key alone says goals exist here");
    assert.equal(none.goalAgeMs, 0);

    const waiting = goalFixture({ updatedAt: Date.now() - 4_000 });
    reply = { ...base, goal: waiting.state };
    const active = await wrapper.send({ type: "get_state" });
    assert.deepEqual(active.goal, waiting.state);
    assert.ok(active.goalAgeMs >= 4_000 && active.goalAgeMs < 30_000, `age ${active.goalAgeMs}`);

    const paused = goalFixture({ status: "paused", updatedAt: Date.now() - 4_000 });
    reply = { ...base, goal: { ...paused.state, enabled: false } };
    assert.equal((await wrapper.send({ type: "get_state" })).goalAgeMs, 0, "a paused goal is not being timed");
  } finally {
    await wrapper.destroyAndWait();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
