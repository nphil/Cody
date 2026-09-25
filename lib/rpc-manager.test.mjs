import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse } from "yaml";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, WebRpcError, buildEngineRpcLaunch, buildSessionSpawnArgs, guardHostToolResultFrame, launchWithSessionOverlays } = await jiti.import("./rpc-manager.ts");
const routing = jiti("./local-model-routing.ts");
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
    const [profileOverlayPath] = mixedLaunch.env.PI_CONFIG_FILES.split(delimiter);
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
    const configFiles = launch.env.PI_CONFIG_FILES.split(delimiter);
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

test("OMP startup guards fresh sessions against an auto-resumed transcript", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /harness\.id === "omp" && !sessionFile && created\.sessionFile && existsSync\(created\.sessionFile\)/);
  assert.match(source, /this\.engine\.label === "omp" && !resumable && this\._sessionFile && existsSync\(this\._sessionFile\)/);
  assert.match(source, /await created\.send\(\{ type: "new_session" \}\)/);
  assert.match(source, /await proc\.sendCommand\(\{ type: "new_session" \}\)/);
});

test("MCP probing bounds the prompt acknowledgement and resets an unresponsive session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /const PROMPT_ACK_TIMEOUT_MS = 30_000/);
  assert.match(source, /sendCommand\(\{ type: "prompt", message: "\/mcp list" \}, PROMPT_ACK_TIMEOUT_MS\)/);
  assert.match(source, /error instanceof RpcCommandTimeoutError/);
  assert.match(source, /await this\.destroyAndWait\(\)/);
  assert.match(source, /session_unresponsive/);
});

test("session-list updates invalidate only the active transcript when its path is known", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /invalidateSessionListMeta\(\);/);
  assert.match(source, /invalidateSessionEntriesCache\(this\._sessionFile\);/);
  assert.match(source, /invalidateSessionListCache\(\);/);
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

test("omp launches keep the historic CLI surface (--mode rpc-ui --cwd … --resume …)", async () => {
  const { ompHarness } = await jiti.import("./harness/omp.ts");
  const harness = { ...ompHarness, resolveBinary: () => "/tools/bin/omp" };
  const launch = buildEngineRpcLaunch(harness, { cwd: "/work", sessionFile: "/abs/s.jsonl" });
  assert.equal(launch.bin, "/tools/bin/omp");
  assert.equal(launch.readiness, "ready-frame");
  assert.deepEqual(launch.args, ["--mode", "rpc-ui", "--cwd", "/work", "--resume", "/abs/s.jsonl"]);
  const minimal = buildEngineRpcLaunch(harness, {
    cwd: "/work",
    sessionFile: "",
    profile: { profileId: "minimal", toolNames: ["read", "bash"] },
  });
  assert.deepEqual(minimal.args, ["--mode", "rpc-ui", "--cwd", "/work", "--no-tools", "--tools", "read,bash"]);

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

test("prompt completion is driven by agent_end / prompt_result, not prompt_done", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /case "prompt_result":/);
  assert.match(source, /isTerminal !== false/);
  assert.doesNotMatch(source, /"prompt_done"/);
});

test("agent startup broadcasts a session-list refresh without waiting for a reply", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const agentStart = source.slice(source.indexOf('case "agent_start":'), source.indexOf('case "agent_end":'));

  assert.match(agentStart, /this\.invalidateSessionLists\(\)/);
  assert.match(source, /private invalidateSessionLists\(\)/);
  assert.match(source, /invalidateSessionListCache\(\)/);
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

test("timed-out extension dialogs are not replayed on reconnect", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const onEvent = source.slice(source.indexOf("onEvent(listener: EventListener)"), source.indexOf("onDestroy(cb:"));

  assert.match(onEvent, /expiresAt !== undefined && expiresAt <= now/);
  assert.match(onEvent, /this\.forgetPendingUiRequest\(id\)/);
  // The expiry also fires on its own so a long-lived session stops holding it.
  assert.match(source, /setTimeout\(\(\) => this\.forgetPendingUiRequest\(id\), timeout\)/);
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
