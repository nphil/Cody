import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner } = await jiti.import("./ChatInput.tsx");

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [
    name,
    JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8")),
  ])),
);

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, /(Model error|chatInput\.modelError)/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      modelError: "Invalid models.json schema",
      modelList: [],
      modelNames: {},
    }),
  );

  assert.match(html, />(No models|chatInput\.noModels)</);
  assert.match(html, /title="(No available models|chatInput\.noAvailableModels)"/);
});


test("renders goal, planning, and advisor indicators at the composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      model: { provider: "test", modelId: "model" },
      modelList: [{ provider: "test", modelId: "model", id: "model", name: "Test model" }],
      modelNames: {},
      activeGoal: { objective: "Ship the active goal bar", startedAt: 0 },
      activePlan: { objective: "Plan the implementation" },
      advisorEnabled: true,
    }),
  );

  assert.match(html, /Ship the active goal bar/);
  assert.match(html, /(Planning in progress|chatInput\.planningInProgress)/);
  assert.match(html, /(Advisor enabled|chatInput\.advisorEnabled)/);
});

const ompEngine = { id: "omp", displayName: "OMP", shortName: "omp", experimental: false };

test("renders the composer ring as an absence before the first usage read lands", () => {
  // The ring gauges the plan quota, which nothing has reported yet — context
  // usage lives in the top bar and never drove this gauge.
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      engine: ompEngine,
    }),
  );

  const ring = html.match(/<button type="button" title="[^"]*"[^>]*aria-haspopup="dialog"[^>]*>.*?<\/svg>/s)?.[0];
  assert.ok(ring, "expected the quota ring button in the composer");
  // An absence has no reported-value arc or percentage.
  assert.doesNotMatch(ring, /stroke-dashoffset/);
  // Never a zero, and never a bare percentage.
  assert.doesNotMatch(ring, /(?:title|aria-label)="[^"]*\d+%/);
  // First paint is "still checking", never a verdict on the engine: nothing
  // has answered yet, so nothing may be asserted about what it reports.
  assert.match(ring, /title="(?:Usage: Checking usage…|usage\.ringUnknown)"/);
  assert.doesNotMatch(ring, /Not reported by this engine/);
  assert.doesNotMatch(ring, /does not report plan limits/);
});


test("the ring's tooltip names the model it is answering for", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      model: { provider: "anthropic", modelId: "vendor-b-2" },
      modelList: [{ provider: "anthropic", modelId: "vendor-b-2", id: "vendor-b-2", name: "Vendor B2" }],
      modelNames: {},
      engine: ompEngine,
    }),
  );

  const ring = html.match(/<button type="button" title="[^"]*"[^>]*aria-haspopup="dialog"[^>]*>.*?<\/svg>/s)?.[0];
  assert.ok(ring, "expected the quota ring button in the composer");
  // Whatever it says, it says which model it is about — a ring read at a glance
  // must never be attributed to the wrong conversation.
  assert.match(ring, /title="[^"]*Vendor B2[^"]*"/);
  assert.match(ring, /aria-label="[^"]*Vendor B2[^"]*"/);
  // Still an absence before the first read lands: no reported-value arc or percentage.
  assert.doesNotMatch(ring, /stroke-dashoffset/);
  assert.doesNotMatch(ring, /(?:title|aria-label)="[^"]*\d+%/);
});
/**
 * The attach path, pinned at the seam.
 *
 * Compression itself is a canvas operation (lib/image-compress.ts, decision half
 * unit-tested in lib/image-compress.test.mjs) and cannot run here; what CAN be
 * pinned without a browser is the wiring — that every attached image goes
 * through the compressor, that a file the browser cannot decode is reported per
 * file instead of vanishing, and that nothing can be sent while an attachment is
 * still being prepared or once it would overflow one RPC frame.
 */
const composerSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("every attached image goes through the compressor, and failures are named", () => {
  const attach = composerSource.slice(
    composerSource.indexOf("const processImageFiles = useCallback"),
    composerSource.indexOf("const processTextFiles = useCallback"),
  );
  assert.match(attach, /prepareImageForAttachment\(file,/);
  // Per file, never a silent drop: an undecodable photo says which one and what
  // the browser can read.
  assert.match(attach, /error instanceof UnsupportedImageError/);
  assert.match(attach, /chatInput\.imageUndecodable/);
  assert.match(attach, /chatInput\.imageReadFailed/);
  assert.match(attach, /setAttachError\(failures\.length \? failures\.join\("\\n"\) : null\)/);
  // The composer shows it is busy, and stops showing it whatever happens.
  assert.match(attach, /setPreparingImageCount\(\(count\) => count \+ imageFiles\.length\)/);
  assert.match(attach, /finally \{[\s\S]*setPreparingImageCount/);
});


test("the over-budget message names the attachment to remove", () => {
  const budget = composerSource.slice(
    composerSource.indexOf("const budgetError = useCallback"),
    composerSource.indexOf("const handleSend = useCallback"),
  );
  assert.match(budget, /checkPromptFrameBudget\(\{ message: composedMessage, images \}\)/);
  assert.match(budget, /chatInput\.attachmentsTooLargeNamed/);
  assert.match(budget, /chatInput\.attachmentsTooLarge/);
  // A text-only overflow has no attachment to blame and must not claim one.
  assert.match(budget, /if \(!verdict\.largest\) return t\("chatInput\.messageTooLarge"/);
});



test("the quota ring is absent on an engine that reports no plan quota", () => {
  // `omp usage --json` is the only reader Cody has, and /api/usage answers
  // {available:false, reason} for every other engine — a value, not an error.
  // A ring that can only ever be an empty dashed circle is dead chrome.
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
 engine: { id: "codex", displayName: "Codex", shortName: "Codex", experimental: true },
    }),
  );

  assert.doesNotMatch(html, /aria-haspopup="dialog"/);
});

test("engine-specific composer copy names the active engine while Smart remains neutral", () => {
  const engineNamed = [
    "chatInput.smartModelHint",
    "chatInput.smartModelUnavailable",
    "chatInput.thinkingAuto",
    "chatInput.toolPresetCoreWarning",
    "chatInput.toolPresetCoreWarningNoSubagents",
    "chatInput.groupEngineBuiltin",
    "agentSession.startingAgent",
  ];
  for (const [name, dict] of Object.entries(locales)) {
    assert.equal(dict["chatInput.smartModel"], "Smart", name + ".json must keep Smart neutral");
    for (const key of engineNamed) {
      assert.ok(key in dict, name + ".json is missing " + key);
      assert.ok(dict[key].includes("{name}"), name + ".json " + key + " must name the active engine");
      assert.doesNotMatch(dict[key], /\bomp\b/i, name + ".json " + key + " still hardcodes omp");
    }
    assert.doesNotMatch(dict["errors.session_file_too_large"], /omp/i);
  }
});

test("the rpc-dialect slash builtins are offered only where the engine answers them", () => {
  // compact / reload / name / session / copy are rpc-dialect commands wearing
  // a slash; an ACP engine answers all five "unsupported". The web-native
  // prompt-composing commands need nothing from the engine and stay.
  assert.match(composerSource, /\[\.\.\.WEB_SLASH_COMMAND_DEFS, \.\.\.\(chatExtras \? RPC_SLASH_COMMAND_DEFS : \[\]\)\]/);
  // The interception set stays complete whatever the engine: a hand-typed
  // /compact must still reach the dispatcher, which answers with the engine's
  // own honest "unsupported" rather than sending prose to the model.
  assert.match(
    composerSource,
    /const CLIENT_BUILTIN_COMMAND_NAMES = new Set\(\s*\[\.\.\.WEB_SLASH_COMMAND_DEFS, \.\.\.RPC_SLASH_COMMAND_DEFS\]/,
  );
  // Smart resolves omp's model ROLES; the row follows the models capability,
  // not chatExtras, which pi has and roles it does not.
  assert.match(composerSource, /\{capabilities\.models && \(\s*<button/);
});

test("renders distinct Fast status semantics without conflating metadata and engine state", async () => {
  // The control moved into the model dropdown (a click away from SSR), so the
  // semantics are pinned where they now live: the shared derivation. The one
  // rule worth a test beyond the state table is that an unavailable Fast is
  // rendered as NOTHING rather than as a disabled control that explains itself.
  const { deriveFastModeState } = await import("../lib/fast-mode-state.ts");
  const fast = (input) => deriveFastModeState({ capable: true, ...input });

  assert.equal(fast({ supported: true }), "off");
  assert.equal(fast({ enabled: true, active: true, supported: false, unavailable: true }), "unavailable");
  assert.equal(fast({ enabled: true, active: false, supported: true }), "inactive");
  assert.equal(fast({ supported: false }), "unavailable");
  assert.equal(fast({ enabled: true }), "unverified");
  assert.equal(fast({ pending: true }), "checking");
  assert.equal(deriveFastModeState({ capable: false, supported: true }), "unavailable");

  // The composer row no longer carries it.
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, fastModeCapable: true, fastModeSupported: true, onFastModeChange() {} }),
  );
  assert.doesNotMatch(html, /data-testid="fast-mode-toggle"/);
});

test("keeps Smart model selection free of engine and model suffixes", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      capabilities: { chatExtras: true, models: true, fastMode: false, subagents: false, skills: false },
      model: { provider: "openai", modelId: "gpt-5" },
      modelNames: { "openai/gpt-5": "GPT-5" },
      isAutoModelSelection: true,
      onModelChange() {},
    }),
  );

  assert.match(html, />Smart</);
  assert.doesNotMatch(html, /Smart[^<]*[·—]/);
});
test("the Smart trigger names the chat's bound preset", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      capabilities: { chatExtras: true, models: true, fastMode: false, subagents: false, skills: false },
      model: { provider: "openai", modelId: "gpt-5" },
      modelNames: { "openai/gpt-5": "GPT-5" },
      isAutoModelSelection: true,
      onModelChange() {},
      presets: [{ id: "high", name: "High", defaultModel: null }],
      activePresetId: "high",
    }),
  );

  assert.match(html, />Smart · High</);
});

test("the Smart trigger stays plain Smart on an explicit Base settings pick, even with presets configured", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      capabilities: { chatExtras: true, models: true, fastMode: false, subagents: false, skills: false },
      model: { provider: "openai", modelId: "gpt-5" },
      modelNames: { "openai/gpt-5": "GPT-5" },
      isAutoModelSelection: true,
      onModelChange() {},
      presets: [{ id: "high", name: "High", defaultModel: null }],
      activePresetId: null,
    }),
  );

  assert.match(html, />Smart</);
  assert.doesNotMatch(html, /Smart[^<]*[·—]/);
});

test("Smart's live resolution reads the chat's own bound preset, not the global model-roles route", () => {
  // /api/model-roles answered the SAME "default" role for every chat on the
  // engine; a preset overlay is per-conversation, so the model-roles route
  // can no longer be the source of truth for what a live Smart click resolves to.
  const handler = composerSource.slice(
    composerSource.indexOf("const handleSmartModelForLiveSession = useCallback"),
    composerSource.indexOf("const turnWaiting ="),
  );
  assert.doesNotMatch(handler, /\/api\/model-roles/);
  assert.match(handler, /`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/preset`/);
  assert.match(handler, /fetchSettingsRoute/);
  // The resolved level applies through the SAME preset-sourced path used
  // after a preset switch — never counted as the user's own manual pick.
  assert.match(handler, /onThinkingLevelChange\(smartDefault\.thinkingLevel, "preset"\)/);
});

test("a preset switch pins the chat's model and reasoning through the existing Smart path, never as a manual pick", async () => {
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const apply = chatWindowSource.slice(
    chatWindowSource.indexOf("applyPresetSmartDefaultRef.current = (smartDefault)"),
    chatWindowSource.indexOf("// The pending re-send of a preset pick"),
  );
  // Gated on Smart actually being on — a race that lands after the user
  // left Smart must not pin a model out from under a manual pick.
  assert.match(apply, /if \(!isAutoModelSelection\) return;/);
  assert.match(apply, /handleModelChange\(smartDefault\.provider, smartDefault\.modelId, "smart"\)/);
  assert.match(apply, /handleThinkingLevelChange\(smartDefault\.thinkingLevel, "preset"\)/);
});
test("keeps rpc model switches available at a turn boundary and marks session-scoped pickers unavailable", () => {
  const renderStreamingPicker = (modelChangeWhileStreaming) => renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: true,
      modelChangeWhileStreaming,
      model: { provider: "test", modelId: "test-model" },
      modelList: [{ provider: "test", id: "test-model", modelId: "test-model", name: "Test model" }],
    }),
  );
  const picker = (html) => html.match(/<button(?=[^>]*title="Change model")[^>]*>/)?.[0];

  const rpcPicker = picker(renderStreamingPicker(true));
  assert.ok(rpcPicker, "expected rpc-dialect model picker");
  assert.doesNotMatch(rpcPicker, /\sdisabled(?:=|\s|>)/);

  const sessionScopedPicker = picker(renderStreamingPicker(false));
  assert.ok(sessionScopedPicker, "expected session-scoped model picker");
  assert.match(sessionScopedPicker, /\sdisabled(?:=|\s|>)/);
});

test("an idle composer sends through the Send pill with its menu zone; a running one shows Stop alone", () => {
  const render = (isStreaming) => renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming,
      model: { provider: "test", modelId: "test-model" },
      modelList: [{ provider: "test", id: "test-model", modelId: "test-model", name: "Test model" }],
    }),
  );
  const idle = render(false);
  assert.match(idle, /data-testid="send-pill"/);
  assert.match(idle, /data-testid="send-menu-button"[^>]*aria-haspopup="menu"|aria-haspopup="menu"[^>]*data-testid="send-menu-button"/);
  const running = render(true);
  assert.doesNotMatch(running, /data-testid="send-pill"/);
  assert.match(running, />Stop</);
});

;