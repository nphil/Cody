import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Persistence touches the agent dir (cody-model-research.json); point it at a
// throwaway directory before anything is imported, per project convention.
const agentDir = mkdtempSync(join(tmpdir(), "cody-research-agentdir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const research = await jiti.import("./research.ts");

function model(selector, overrides = {}) {
  const slash = selector.indexOf("/");
  const id = selector.slice(slash + 1);
  return {
    selector,
    provider: selector.slice(0, slash),
    id,
    name: id,
    contextWindow: 200_000,
    maxTokens: 8_192,
    reasoning: true,
    thinkingEfforts: ["low", "medium", "high"],
    vision: false,
    local: false,
    relativeCost: 10,
    ...overrides,
  };
}

function roster(models) {
  return { models, providers: [] };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Answer parsing / validation
// ---------------------------------------------------------------------------

test("malformed answers fail cleanly instead of throwing", () => {
  const empty = roster([]);
  for (const text of ["I refuse to answer in JSON.", '{"summary": "s", "proposals": {', "[1,2,3]", ""]) {
    const outcome = research.parseResearchAnswer(text, { presetIds: ["max"], roster: empty });
    assert.equal(outcome.ok, false, `expected failure for ${JSON.stringify(text)}`);
    assert.ok(outcome.reason);
  }
});

test("keeps only selectors present in the roster, dropping a hallucinated model with a clear warning", () => {
  const raw = JSON.stringify({ proposals: { max: { roles: { default: "openai-codex/does-not-exist" } } } });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max"], roster: roster([model("anthropic/opus")]) });
  assert.ok(outcome.ok);
  const proposal = outcome.result.proposals.max;
  assert.deepEqual(proposal.roles, {});
  assert.ok(proposal.warnings.some((w) => w.includes("not an available model")));
});

test("curation excludes a provider's disabled model from research evidence and proposals", () => {
  const raw = JSON.stringify({
    models: [{ selector: "anthropic/opus", verdict: "fast", sources: [{ url: "https://example.com/opus" }] }],
    proposals: { max: { roles: { default: "anthropic/opus", task: "anthropic/sonnet" } } },
  });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max"], roster: roster([model("anthropic/sonnet")]) });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result.models, []);
  assert.deepEqual(outcome.result.proposals.max.roles, { task: "anthropic/sonnet" });
  assert.ok(outcome.result.proposals.max.warnings.some((warning) => warning.includes("anthropic/opus")));
  assert.ok(Object.values(outcome.result.proposals.max.chains).flat().every((selector) => selector !== "anthropic/opus"));
});

test("drops a role name this preset cannot assign (not a live chat role)", () => {
  const raw = JSON.stringify({
    proposals: { max: { roles: { default: "anthropic/opus", "made-up-role": "anthropic/opus" } } },
  });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max"], roster: roster([model("anthropic/opus")]) });
  const proposal = outcome.result.proposals.max;
  assert.deepEqual(Object.keys(proposal.roles), ["default"]);
  assert.ok(proposal.warnings.some((w) => w.includes('"made-up-role"')));
});

test("memory is accepted when the live OMP role list includes it, even though the fixed planner list does not", () => {
  const raw = JSON.stringify({ proposals: { max: { roles: { memory: "anthropic/opus" } } } });
  const outcome = research.parseResearchAnswer(raw, {
    presetIds: ["max"], roster: roster([model("anthropic/opus")]), roleNames: ["default", "memory"],
  });
  assert.equal(outcome.result.proposals.max.roles.memory, "anthropic/opus");
});

test("memory is dropped when the current OMP role list no longer exposes it", () => {
  const raw = JSON.stringify({ proposals: { max: { roles: { default: "anthropic/opus", memory: "anthropic/opus" } } } });
  const outcome = research.parseResearchAnswer(raw, {
    presetIds: ["max"], roster: roster([model("anthropic/opus")]), roleNames: ["default"],
  });
  assert.deepEqual(outcome.result.proposals.max.roles, { default: "anthropic/opus" });
  assert.ok(outcome.result.proposals.max.warnings.some((warning) => warning.includes('"memory"')));
});

test("strips a thinking level the specific model does not support, keeping the bare selector", () => {
  const raw = JSON.stringify({ proposals: { max: { roles: { default: "anthropic/opus:xhigh" } } } });
  const outcome = research.parseResearchAnswer(raw, {
    presetIds: ["max"],
    roster: roster([model("anthropic/opus", { thinkingEfforts: ["low", "medium"] })]),
  });
  const proposal = outcome.result.proposals.max;
  assert.equal(proposal.roles.default, "anthropic/opus");
  assert.ok(proposal.warnings.some((w) => w.includes("xhigh")));
});

test("keeps a thinking level the model's roster entry actually lists", () => {
  const raw = JSON.stringify({ proposals: { max: { roles: { default: "anthropic/opus:high" } } } });
  const outcome = research.parseResearchAnswer(raw, {
    presetIds: ["max"],
    roster: roster([model("anthropic/opus", { thinkingEfforts: ["low", "medium", "high"] })]),
  });
  assert.equal(outcome.result.proposals.max.roles.default, "anthropic/opus:high");
});

test("auto is always accepted on a reasoning model regardless of its listed efforts", () => {
  const raw = JSON.stringify({ proposals: { max: { roles: { default: "anthropic/opus:auto" } } } });
  const outcome = research.parseResearchAnswer(raw, {
    presetIds: ["max"],
    roster: roster([model("anthropic/opus", { thinkingEfforts: ["low"] })]),
  });
  assert.equal(outcome.result.proposals.max.roles.default, "anthropic/opus:auto");
});

test("off is valid on a non-reasoning model; any other level is stripped", () => {
  const nonReasoning = model("openai-codex/mini", { reasoning: false, thinkingEfforts: [] });

  const off = research.parseResearchAnswer(
    JSON.stringify({ proposals: { low: { roles: { smol: "openai-codex/mini:off" } } } }),
    { presetIds: ["low"], roster: roster([nonReasoning]) },
  );
  assert.equal(off.result.proposals.low.roles.smol, "openai-codex/mini:off");

  const high = research.parseResearchAnswer(
    JSON.stringify({ proposals: { low: { roles: { smol: "openai-codex/mini:high" } } } }),
    { presetIds: ["low"], roster: roster([nonReasoning]) },
  );
  assert.equal(high.result.proposals.low.roles.smol, "openai-codex/mini");
  assert.ok(high.result.proposals.low.warnings.some((w) => w.includes("high")));
});

test("vision must resolve to an image-capable model", () => {
  const noVision = research.parseResearchAnswer(
    JSON.stringify({ proposals: { max: { roles: { vision: "anthropic/opus" } } } }),
    { presetIds: ["max"], roster: roster([model("anthropic/opus", { vision: false })]) },
  );
  assert.deepEqual(noVision.result.proposals.max.roles, {});
  assert.ok(noVision.result.proposals.max.warnings.some((w) => /image/i.test(w)));

  const withVision = research.parseResearchAnswer(
    JSON.stringify({ proposals: { max: { roles: { vision: "anthropic/opus" } } } }),
    { presetIds: ["max"], roster: roster([model("anthropic/opus", { vision: true })]) },
  );
  assert.equal(withVision.result.proposals.max.roles.vision, "anthropic/opus");
});

test("fills fallback chains for every assigned role via deriveChains and flags usage-aware fallback", () => {
  const raw = JSON.stringify({ proposals: { max: { roles: { default: "anthropic/opus" } } } });
  // Equal cost so derive.ts's strongCandidates treats both as the same tier —
  // a cheaper sibling would be filtered into the "light" tier instead (see
  // lib/model-plan/derive.test.mjs's own "same-provider sibling routes" test).
  const outcome = research.parseResearchAnswer(raw, {
    presetIds: ["max"],
    roster: roster([model("anthropic/opus", { relativeCost: 20 }), model("anthropic/sonnet", { relativeCost: 20 })]),
  });
  const proposal = outcome.result.proposals.max;
  assert.deepEqual(proposal.chains["anthropic/opus"], ["anthropic/sonnet"]);
  assert.ok(proposal.usageAwareFallback);
});

test("a large synthetic roster's proposal fits under the chain caps and keeps its role chains, instead of losing them to deriveChains's one-exact-chain-per-roster-model output", () => {
  const providers = ["alpha", "beta", "gamma", "delta"];
  const models = [];
  for (const provider of providers) {
    for (let i = 0; i < 20; i += 1) {
      models.push(model(`${provider}/model-${i}`, { relativeCost: 10 + i }));
    }
  }
  const raw = JSON.stringify({
    proposals: {
      max: {
        roles: {
          default: "alpha/model-0",
          task: "beta/model-5",
          smol: "delta/model-19",
        },
      },
    },
  });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max"], roster: roster(models) });
  assert.ok(outcome.ok);
  const { roles, chains } = outcome.result.proposals.max;
  assert.deepEqual(Object.keys(roles).sort(), ["default", "smol", "task"]);

  // Every assigned role kept its own fallback chain — the review's own repro
  // showed a role chain is exactly what an unfiltered 64-key cap loses first.
  for (const role of Object.keys(roles)) {
    assert.ok(Array.isArray(chains[role]) && chains[role].length > 0, `chains.${role} must survive`);
  }
  // ...and so did the exact selector deriveChains keys "task" by, and its
  // provider wildcard.
  assert.ok(Array.isArray(chains["beta/model-5"]) && chains["beta/model-5"].length > 0, "the task model's exact chain must survive");
  assert.ok(Array.isArray(chains["beta/*"]) && chains["beta/*"].length > 0, "the task model's provider wildcard must survive");

  // An unfiltered proposal on this 80-model roster would carry one exact key
  // per roster model (deriveChains's own "protect every enabled model"
  // behavior) — asserting a small key count proves the filter actually ran.
  assert.ok(Object.keys(chains).length <= 12, `only role/selector/wildcard keys are kept, got ${Object.keys(chains).length}: ${Object.keys(chains).join(", ")}`);
  assert.ok(!("gamma/*" in chains), "gamma was never assigned to any role, so its wildcard must not be kept");
});

test("a preset left with no usable role is a per-preset failure, not a thrown exception", () => {
  const raw = JSON.stringify({ proposals: { max: { roles: { default: "nonexistent/model" } } } });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max"], roster: roster([model("anthropic/opus")]) });
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.result.proposals.max.roles, {});
  assert.equal(outcome.result.proposals.max.chains && Object.keys(outcome.result.proposals.max.chains).length, 0);
  assert.ok(outcome.result.proposals.max.warnings.length > 0);
});

test("every requested preset gets an entry even when the planner never mentioned it", () => {
  const raw = JSON.stringify({ proposals: {} });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max", "low"], roster: roster([model("anthropic/opus")]) });
  assert.deepEqual(Object.keys(outcome.result.proposals).sort(), ["low", "max"]);
  assert.ok(outcome.result.proposals.max.warnings.length > 0);
  assert.ok(outcome.result.proposals.low.warnings.length > 0);
});

test("drops sources that are not http(s) URLs, from both model evidence and rationale", () => {
  const raw = JSON.stringify({
    models: [{
      selector: "anthropic/opus",
      sources: [
        { url: "https://example.com/bench", title: "Bench", kind: "benchmark" },
        { url: "ftp://example.com/x", title: "bad" },
        { url: "javascript:alert(1)", title: "bad2" },
        { title: "no url at all" },
      ],
    }],
    proposals: {
      max: {
        roles: { default: "anthropic/opus" },
        rationale: [{ role: "overall", text: "t", sources: ["https://good.example/x", "not-a-url", "file:///etc/passwd"] }],
      },
    },
  });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max"], roster: roster([model("anthropic/opus")]) });
  assert.equal(outcome.result.models.length, 1);
  assert.deepEqual(outcome.result.models[0].sources.map((s) => s.url), ["https://example.com/bench"]);
  assert.deepEqual(outcome.result.proposals.max.rationale[0].sources, ["https://good.example/x"]);
});

test("model evidence for a model outside the roster is dropped", () => {
  const raw = JSON.stringify({ models: [{ selector: "nonexistent/model", verdict: "great" }] });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max"], roster: roster([model("anthropic/opus")]) });
  assert.deepEqual(outcome.result.models, []);
});

test("an unrecognized source kind falls back to other instead of being dropped", () => {
  const raw = JSON.stringify({
    models: [{ selector: "anthropic/opus", sources: [{ url: "https://example.com/x", kind: "tweet-thread" }] }],
  });
  const outcome = research.parseResearchAnswer(raw, { presetIds: ["max"], roster: roster([model("anthropic/opus")]) });
  assert.equal(outcome.result.models[0].sources[0].kind, "other");
});

test("buildResearchPrompt carries every preset brief, the live role list, and the JSON answer shape", () => {
  const prompt = research.buildResearchPrompt(roster([model("anthropic/opus")]), [
    { id: "max", name: "Max", intent: "hard logic and bug fixing" },
  ], ["default", "memory"]);
  assert.match(prompt, /"max"/);
  assert.match(prompt, /hard logic and bug fixing/);
  assert.match(prompt, /\bmemory\b/);
  assert.match(prompt, /"proposals"/);

  const olderOmpPrompt = research.buildResearchPrompt(roster([model("anthropic/opus")]), [
    { id: "max", name: "Max", intent: "hard logic and bug fixing" },
  ], ["default"]);
  assert.doesNotMatch(olderOmpPrompt, /memory - background/);
});

test("the research child's tool allow-list is web_search only", () => {
  assert.deepEqual([...research.RESEARCH_TOOLS], ["web_search"]);
});

// ---------------------------------------------------------------------------
// Progress reducer
// ---------------------------------------------------------------------------

test("progressFromToolStart turns a web_search call into a search item carrying the query", () => {
  const item = research.progressFromToolStart({ toolCallId: "1", toolName: "web_search", args: { query: "home assistant release" } });
  assert.equal(item.kind, "search");
  assert.equal(item.text, "home assistant release");
});

test("progressFromToolStart flags any non-web_search tool as an error — an isolation regression must be visible", () => {
  const item = research.progressFromToolStart({ toolCallId: "1", toolName: "mcp__ha_mcp_ha_read_file", args: {} });
  assert.equal(item.kind, "error");
  assert.match(item.text, /mcp__ha_mcp_ha_read_file/);
});

test("progressFromToolEnd is silent on success and reports an error item on failure", () => {
  assert.equal(research.progressFromToolEnd({ toolCallId: "1", toolName: "web_search", isError: false, resultExcerpt: "ok" }), null);
  const item = research.progressFromToolEnd({ toolCallId: "1", toolName: "web_search", isError: true, resultExcerpt: "quota exceeded" });
  assert.equal(item.kind, "error");
  assert.match(item.text, /quota exceeded/);
});

test("appendProgress bounds the log, keeping only the newest entries", () => {
  let progress = [];
  const total = research.MAX_PROGRESS_ITEMS + 10;
  for (let i = 0; i < total; i += 1) {
    progress = research.appendProgress(progress, research.noteProgress(`item-${i}`));
  }
  assert.equal(progress.length, research.MAX_PROGRESS_ITEMS);
  assert.equal(progress[0].text, "item-10");
  assert.equal(progress.at(-1).text, `item-${total - 1}`);
});

// ---------------------------------------------------------------------------
// Run registry: single-flight, progress, cancel, persistence across a
// simulated restart. `runner` is injected — no process spawn, no network.
// ---------------------------------------------------------------------------

function presetInput(overrides = {}) {
  return {
    plannerModel: "anthropic/opus",
    presetIds: ["max"],
    presets: [{ id: "max", name: "Max", intent: "hard problems" }],
    roster: roster([model("anthropic/opus")]),
    ...overrides,
  };
}

test("startResearchRun rejects an empty plannerModel or empty presetIds up front", () => {
  research.resetResearchRegistryForTests();
  const runner = async () => ({ text: null, error: null });
  const a = research.startResearchRun(presetInput({ plannerModel: "  " }), runner);
  assert.equal(a.ok, false);
  assert.equal(a.code, "invalid_request");
  const b = research.startResearchRun(presetInput({ presetIds: [] }), runner);
  assert.equal(b.ok, false);
  assert.equal(b.code, "invalid_request");
});

test("startResearchRun cannot launch a planner removed by curation", () => {
  research.resetResearchRegistryForTests();
  let called = false;
  const outcome = research.startResearchRun(
    presetInput({ roster: roster([model("anthropic/sonnet")]) }),
    async () => { called = true; return { text: null, error: null }; },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "invalid_request");
  assert.equal(called, false);
  assert.equal(research.getCurrentRun(), null);
});

test("only one run at a time: a second start while running is refused with the running snapshot", async () => {
  research.resetResearchRegistryForTests();
  const gate = deferred();
  const runner = async () => {
    await gate.promise;
    return { text: null, error: "stopped for the test" };
  };

  const first = research.startResearchRun(presetInput(), runner);
  assert.ok(first.ok);
  assert.equal(first.run.status, "running");

  const second = research.startResearchRun(presetInput(), runner);
  assert.equal(second.ok, false);
  assert.equal(second.code, "research_running");
  assert.equal(second.run.id, first.run.id);

  gate.resolve();
  await first.done;
});

test("progress accrues from tool frames as the run proceeds, newest last", async () => {
  research.resetResearchRegistryForTests();
  const runner = async ({ onToolStart, onToolEnd }) => {
    onToolStart({ toolCallId: "1", toolName: "web_search", args: { query: "query one" } });
    onToolEnd({ toolCallId: "1", toolName: "web_search", isError: false, resultExcerpt: "ok" });
    onToolStart({ toolCallId: "2", toolName: "web_search", args: { query: "query two" } });
    return { text: JSON.stringify({ proposals: { max: { roles: { default: "anthropic/opus" } } } }), error: null };
  };

  const started = research.startResearchRun(presetInput(), runner);
  await started.done;

  const searches = started.run.progress.filter((item) => item.kind === "search").map((item) => item.text);
  assert.deepEqual(searches, ["query one", "query two"]);
  assert.equal(started.run.status, "succeeded");
});

test("a finished run persists to disk and survives a simulated restart (in-memory registry cleared)", async () => {
  research.resetResearchRegistryForTests();
  const answer = JSON.stringify({ summary: "s", proposals: { max: { roles: { default: "anthropic/opus" } } } });
  const runner = async () => ({ text: answer, error: null });

  const started = research.startResearchRun(presetInput(), runner);
  await started.done;
  assert.equal(research.getCurrentRun().status, "succeeded");

  const onDisk = JSON.parse(readFileSync(join(agentDir, "cody-model-research.json"), "utf8"));
  assert.equal(onDisk.run.id, started.run.id);

  research.resetResearchRegistryForTests(); // simulate a process restart
  const revived = research.getCurrentRun();
  assert.ok(revived, "expected the finished run to survive from disk");
  assert.equal(revived.id, started.run.id);
  assert.equal(revived.status, "succeeded");
  assert.equal(revived.result.proposals.max.roles.default, "anthropic/opus");

  assert.equal(research.getRun(started.run.id).id, started.run.id);
  assert.equal(research.getRun("no-such-id"), null);
});

test("a run still running when the process stops never resurfaces as running", async () => {
  research.resetResearchRegistryForTests();
  const gate = deferred();
  const runner = async () => {
    await gate.promise;
    return { text: null, error: "irrelevant" };
  };
  research.startResearchRun(presetInput(), runner);

  research.resetResearchRegistryForTests(); // simulate a hard restart mid-run
  const revived = research.getCurrentRun();
  assert.ok(revived === null || revived.status !== "running");

  gate.resolve();
});

test("cancelRun finalizes the run as cancelled immediately and aborts the child", async () => {
  research.resetResearchRegistryForTests();
  let aborted = false;
  const gate = deferred();
  const runner = async ({ signal }) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    await gate.promise;
    return { text: null, error: "should be superseded by the cancel" };
  };

  const started = research.startResearchRun(presetInput(), runner);
  const cancelled = research.cancelRun(started.run.id);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.finishedAt);
  assert.equal(research.getCurrentRun().status, "cancelled");
  assert.ok(aborted, "the runner's AbortSignal should have fired");

  gate.resolve();
  await started.done; // the runner's late resolution must not overwrite "cancelled"
  assert.equal(research.getCurrentRun().status, "cancelled");
});

test("cancelRun on an unknown or non-running id returns null", () => {
  research.resetResearchRegistryForTests();
  assert.equal(research.cancelRun("no-such-id"), null);
});

test("a run that fails without answering JSON is reported as failed with the runner's error", async () => {
  research.resetResearchRegistryForTests();
  const runner = async () => ({ text: null, error: "the model did not answer within 60s" });
  const started = research.startResearchRun(presetInput(), runner);
  await started.done;
  assert.equal(started.run.status, "failed");
  assert.match(started.run.error, /did not answer/);
});

test("a run whose runner throws is reported as failed, never an unhandled rejection", async () => {
  research.resetResearchRegistryForTests();
  const runner = async () => {
    throw new Error("spawn exploded");
  };
  const started = research.startResearchRun(presetInput(), runner);
  await started.done;
  assert.equal(started.run.status, "failed");
  assert.match(started.run.error, /spawn exploded/);
});
