import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { addUsageTotals, aggregateMessageUsage, usageModelId, usageTokenTotal } =
  await jiti.import("./session-usage.ts");
const { extractSubagentHistory, siblingDirForSession, sumSubagentTranscriptUsage } =
  await jiti.import("./subagent-history.ts");

const STAMP = "2026-08-18T00:00:00.000Z";

/** omp's on-disk usage shape: token counts plus a priced-out cost breakdown. */
function usage(input, output, total, extra = {}) {
  return {
    input,
    output,
    cacheRead: extra.cacheRead ?? 0,
    cacheWrite: extra.cacheWrite ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function assistantMessage(model, provider, messageUsage) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model,
    provider,
    ...(messageUsage ? { usage: messageUsage } : {}),
  };
}

function assistantLine(id, model, provider, messageUsage) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: STAMP,
    message: assistantMessage(model, provider, messageUsage),
  });
}

/** A parent session file whose task toolResult carries the DISPLAY rollup for a
 *  child, plus that child's own transcript in the sibling artifacts dir. The
 *  two describe the same work with different numbers on purpose, so a test can
 *  tell which one the accounting used. */
function makeOrchestratedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "cody-session-usage-"));
  const sessionFile = join(dir, "2026-08-18T00-00-00_parent.jsonl");
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: STAMP, cwd: dir }),
    assistantLine("p1", "orchestrator", "acme", usage(100, 10, 0.5)),
    JSON.stringify({
      type: "message",
      id: "p2",
      parentId: null,
      timestamp: STAMP,
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "task",
        content: [],
        details: {
          progress: [{ index: 0, id: "Scout", agent: "scout", status: "completed", tokens: 9000, cost: 9 }],
          results: [{ index: 0, id: "Scout", agent: "scout", exitCode: 0, tokens: 9000, usage: { cost: { total: 9 } } }],
        },
      },
    }),
  ].join("\n") + "\n");

  const artifacts = siblingDirForSession(sessionFile);
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "Scout.jsonl"), [
    JSON.stringify({ type: "session", version: 3, id: "Scout", timestamp: STAMP, cwd: dir }),
    assistantLine("s1", "worker", "acme", usage(2000, 300, 1.25, { cacheRead: 40 })),
  ].join("\n") + "\n");

  return { dir, sessionFile, artifacts };
}

test("an orchestrated session counts each transcript once and the parent's task rollup never", () => {
  const { dir, sessionFile } = makeOrchestratedFixture();
  try {
    const subagentUsage = sumSubagentTranscriptUsage(sessionFile);
    // The child's own transcript is the only source for its tokens.
    assert.deepEqual(
      {
        input: subagentUsage.input,
        output: subagentUsage.output,
        cacheRead: subagentUsage.cacheRead,
        cost: subagentUsage.cost,
        transcripts: subagentUsage.transcripts,
      },
      { input: 2000, output: 300, cacheRead: 40, cost: 1.25, transcripts: 1 },
    );

    // The parent's toolResult still carries its own rollup for the roster UI —
    // different numbers for the same work, and deliberately not in the sum.
    const roster = extractSubagentHistory(sessionFile);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].tokens, 9000);
    assert.equal(roster[0].cost, 9);

    const parentMessages = [
      { role: "user", content: "go" },
      assistantMessage("orchestrator", "acme", usage(100, 10, 0.5)),
    ];
    const headline = addUsageTotals(aggregateMessageUsage(parentMessages), subagentUsage);

    assert.equal(usageTokenTotal(headline), 100 + 10 + 2000 + 300 + 40);
    assert.equal(headline.cost, 0.5 + 1.25);
    // The two failure modes, named: the child missing entirely...
    assert.notEqual(usageTokenTotal(headline), 110);
    // ...and the parent's display rollup added on top of the child's transcript.
    assert.notEqual(usageTokenTotal(headline), 110 + 2340 + 9000);
    assert.notEqual(headline.cost, 0.5 + 1.25 + 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nested subagent transcripts are counted, one generation down", () => {
  const { dir, sessionFile, artifacts } = makeOrchestratedFixture();
  try {
    // A subagent that orchestrates in turn: its children land in the dir named
    // after it, because its own transcript is a session file like any other.
    const nested = join(artifacts, "Scout");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "Grandchild.jsonl"), assistantLine("g1", "worker", "acme", usage(7, 3, 0.05)) + "\n");

    const totals = sumSubagentTranscriptUsage(sessionFile);
    assert.equal(totals.transcripts, 2);
    assert.equal(totals.input, 2007);
    assert.equal(totals.output, 303);
    assert.equal(totals.cost, 1.3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a growing transcript adds only what was appended", () => {
  const { dir, sessionFile, artifacts } = makeOrchestratedFixture();
  try {
    const first = sumSubagentTranscriptUsage(sessionFile);
    assert.equal(first.input, 2000);

    // Same call again, nothing appended: the incremental scan must not re-count
    // what it already accounted for.
    assert.equal(sumSubagentTranscriptUsage(sessionFile).input, 2000);

    appendFileSync(join(artifacts, "Scout.jsonl"), assistantLine("s2", "worker", "acme", usage(11, 5, 0.02)) + "\n");
    const grown = sumSubagentTranscriptUsage(sessionFile);
    assert.equal(grown.input, 2011);
    assert.equal(grown.output, 305);
    assert.equal(grown.cost, 1.27);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a half-written line is counted once, when it is complete", () => {
  const { dir, sessionFile, artifacts } = makeOrchestratedFixture();
  try {
    const transcript = join(artifacts, "Scout.jsonl");
    const line = assistantLine("s2", "worker", "acme", usage(500, 60, 0.4));
    // omp is mid-append: the line has no terminating newline yet.
    appendFileSync(transcript, line.slice(0, 40));
    assert.equal(sumSubagentTranscriptUsage(sessionFile).input, 2000);

    appendFileSync(transcript, line.slice(40) + "\n");
    assert.equal(sumSubagentTranscriptUsage(sessionFile).input, 2500);
    // And still exactly once on the next pass.
    assert.equal(sumSubagentTranscriptUsage(sessionFile).input, 2500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transcript rewritten shorter is re-read instead of keeping vanished tokens", () => {
  const { dir, sessionFile, artifacts } = makeOrchestratedFixture();
  try {
    const transcript = join(artifacts, "Scout.jsonl");
    assert.equal(sumSubagentTranscriptUsage(sessionFile).input, 2000);
    writeFileSync(transcript, assistantLine("s9", "worker", "acme", usage(1, 1, 0.01)) + "\n");
    assert.equal(sumSubagentTranscriptUsage(sessionFile).input, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model whose whole contribution priced at zero is named, not billed as $0", () => {
  const totals = aggregateMessageUsage([
    assistantMessage("priced-model", "acme", usage(100, 20, 0.75)),
    assistantMessage("mystery-model", "acme", usage(4000, 500, 0)),
    assistantMessage("mystery-model", "acme", usage(1000, 100, 0)),
  ]);
  assert.equal(usageTokenTotal(totals), 5720);
  assert.equal(totals.cost, 0.75);
  assert.deepEqual(totals.unpricedModels, ["acme/mystery-model"]);
});

test("a genuinely free provider reports not-priced rather than an empty warning", () => {
  const totals = aggregateMessageUsage([
    assistantMessage("llama-local", "ollama", usage(900, 120, 0)),
  ]);
  // Real tokens, zero cost, and the reason named: the UI reads this as "not
  // priced" (cost <= 0 with usage) rather than printing "$0.00+".
  assert.equal(usageTokenTotal(totals), 1020);
  assert.equal(totals.cost, 0);
  assert.deepEqual(totals.unpricedModels, ["ollama/llama-local"]);
});

test("a cache-only turn does not slander its model as unpriced", () => {
  const totals = aggregateMessageUsage([
    assistantMessage("priced-model", "acme", usage(100, 20, 0.5)),
    // A follow-up served from cache that priced out at ~nothing.
    assistantMessage("priced-model", "acme", usage(0, 0, 0, { cacheRead: 8000 })),
  ]);
  assert.equal(usageTokenTotal(totals), 8120);
  assert.deepEqual(totals.unpricedModels, []);
});

test("malformed usage contributes nothing instead of poisoning the total", () => {
  const totals = aggregateMessageUsage([
    assistantMessage("priced-model", "acme", usage(50, 5, 0.25)),
    assistantMessage("broken-model", "acme", { input: "12", output: Number.NaN, cacheRead: -900, cacheWrite: null, cost: { total: "free" } }),
    assistantMessage("no-usage-model", "acme", undefined),
    { role: "toolResult", toolCallId: "tc", content: [], usage: usage(999, 999, 999) },
  ]);
  assert.equal(usageTokenTotal(totals), 55);
  assert.equal(totals.cost, 0.25);
  assert.deepEqual(totals.unpricedModels, []);
});

test("model ids keep one provider prefix and merge as a set", () => {
  assert.equal(usageModelId("acme", "acme/thing"), "acme/thing");
  assert.equal(usageModelId("acme", "thing"), "acme/thing");
  assert.equal(usageModelId(undefined, "thing"), "thing");
  assert.equal(usageModelId("acme", undefined), "acme");
  assert.equal(usageModelId(undefined, undefined), "");

  const merged = addUsageTotals(
    { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, unpricedModels: ["b", "a"] },
    { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, unpricedModels: ["a"] },
  );
  assert.deepEqual(merged.unpricedModels, ["a", "b"]);
  assert.equal(usageTokenTotal(merged), 4);
});

test("a session with no subagents reports absence, not zeros to add", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-session-usage-bare-"));
  try {
    const sessionFile = join(dir, "2026-08-18T00-00-00_bare.jsonl");
    writeFileSync(sessionFile, assistantLine("p1", "orchestrator", "acme", usage(10, 2, 0.1)) + "\n");
    const totals = sumSubagentTranscriptUsage(sessionFile);
    assert.equal(totals.transcripts, 0);
    assert.equal(usageTokenTotal(totals), 0);
    assert.equal(totals.cost, 0);
    assert.deepEqual(totals.unpricedModels, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transcript larger than the display cap still contributes its tokens", () => {
  const { dir, sessionFile, artifacts } = makeOrchestratedFixture();
  try {
    // Bigger than the 4 MiB accounting window AND the 16 MiB a transcript can be
    // and still be materialized for the dialog. Skipping it would silently drop
    // a heavy child's whole account — the exact under-count this module removes.
    const filler = assistantLine("pad", "worker", "acme", usage(1, 0, 0));
    const rows = Math.ceil((17 * 1024 * 1024) / (filler.length + 1));
    writeFileSync(join(artifacts, "Heavy.jsonl"), `${Array.from({ length: rows }, () => filler).join("\n")}\n`);

    const totals = sumSubagentTranscriptUsage(sessionFile);
    assert.equal(totals.transcripts, 2);
    // Scout's 2000 input tokens plus one per padded row.
    assert.equal(totals.input, 2000 + rows);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
