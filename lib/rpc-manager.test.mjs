import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, WebRpcError, buildEngineRpcLaunch, buildSessionSpawnArgs, guardHostToolResultFrame, launchWithSessionOverlays } = await jiti.import("./rpc-manager.ts");
const routing = jiti("./local-model-routing.ts");
function createDeliveryHarness(commandHandler) {
  let onFrame = () => {};
  const events = [];
  let sequence = 0;
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame(listener) { onFrame = listener; return () => { onFrame = () => {}; }; },
    sendCommandWithId(command) {
      const id = `rpc-${++sequence}`;
      return commandHandler ? commandHandler(command, id) : { id, result: Promise.resolve({ agentInvoked: true }) };
    },
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: {}, label: "omp", relaunch: () => ({}) });
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, events, emitFrame: (event) => onFrame(event) };
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
  // The digest is rendered here and the read is what silences the notice.
  assert.match(source, /formatAppLogDigest\(digest, query\)/);
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

test("OMP main sessions load the refusal extension without enabling it for sidebars", async (t) => {
  const { ompHarness } = await jiti.import("./harness/omp.ts");
  const harness = { ...ompHarness, resolveBinary: () => "/tools/bin/omp" };
  // Resolved from the package dir the server sets, never the process cwd.
  const previousPackageDir = process.env.CODY_PACKAGE_DIR;
  process.env.CODY_PACKAGE_DIR = "/pkg";
  t.after(() => {
    if (previousPackageDir === undefined) delete process.env.CODY_PACKAGE_DIR;
    else process.env.CODY_PACKAGE_DIR = previousPackageDir;
  });
  const refusalExtension = join("/pkg", "lib", "omp", "extensions", "cody-refusal-guard.ts");
  const launch = buildEngineRpcLaunch(harness, { cwd: "/work", sessionFile: "/abs/s.jsonl" });
  assert.equal(launch.bin, "/tools/bin/omp");
  assert.equal(launch.readiness, "ready-frame");
  assert.deepEqual(launch.args, ["--mode", "rpc-ui", "--cwd", "/work", "--resume", "/abs/s.jsonl", "--extension", refusalExtension]);
  const minimal = buildEngineRpcLaunch(harness, {
    cwd: "/work",
    sessionFile: "",
    profile: { profileId: "minimal", toolNames: ["read", "bash"] },
  });
  assert.deepEqual(minimal.args, ["--mode", "rpc-ui", "--cwd", "/work", "--no-tools", "--tools", "read,bash", "--extension", refusalExtension]);

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
// Held queue: messages sent mid-run stay in Cody until the engine would read
// them, because omp's RPC cannot take a message back out of its own queue.
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

test("promoting a held follow-up sends it to the engine as a steer right away", async () => {
  const { wrapper, sentPrompts, settle } = createQueueHarness();
  try {
    wrapper.promptRunning = true;
    await wrapper.send({ type: "prompt", message: "sooner please", streamingBehavior: "followUp", clientMessageId: "p1" });
    assert.deepEqual(sentPrompts, []);
    const result = await wrapper.send({ type: "promote_queued", clientMessageId: "p1" });
    assert.equal(result.promoted, true);
    await settle();
    assert.deepEqual(sentPrompts, [{ message: "sooner please", streamingBehavior: "steer" }]);
    const entry = wrapper.getDeliveryLedger(["p1"])[0];
    assert.equal(entry.status, "queued");
    assert.equal(entry.held, false, "handed over: no longer editable");
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

test("while stopped, a run the engine starts on its own is aborted at its first reply; the next user send lifts that", async () => {
  const aborts = [];
  const { wrapper, emitFrame } = createQueueHarness();
  const original = wrapper.proc.sendCommand;
  wrapper.proc.sendCommand = async (command, timeout) => {
    if (command.type === "abort") aborts.push(Date.now());
    return original(command, timeout);
  };
  try {
    await wrapper.send({ type: "abort" });
    assert.equal(aborts.length, 1);
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
