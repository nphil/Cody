import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { describeEngineError, sameError, errorDedupeKey } = await jiti.import("./error-text.ts");
const { describeDiskError } = await jiti.import("./disk-space.ts");
const { checkDiskForNewTurn, configureDiskGateForTests } = await jiti.import("./disk/gate.ts");

function assertClean(detail) {
  assert.ok(!/[{}]/.test(detail), `should have no JSON braces: ${detail}`);
  assert.ok(!/req_[\w-]+/i.test(detail), `should have no request id: ${detail}`);
  assert.ok(!/raw-http-request=/i.test(detail), `should have no raw-http-request line: ${detail}`);
  assert.ok(!/https?:\/\//i.test(detail), `should have no URL: ${detail}`);
  assert.ok(detail.length <= 181, `should be capped: ${detail.length} chars: ${detail}`);
  assert.ok(detail.trim().length > 0, "should never be empty");
}

test("reasoning-extraction code is classified as a refusal", () => {
  const raw = "Refusal (reasoning_extraction): Request blocked by safety policy. See https://example.invalid/policy";
  const result = describeEngineError(raw);
  assert.equal(result.kind, "refusal");
  assert.equal(result.provider, undefined);
  assertClean(result.detail);
  assert.ok(!/^refusal/i.test(result.detail));
  assert.match(result.detail, /blocked/i);
});

test("content safety stop codes classify as refusal notices", () => {
  for (const raw of ["content_filter", "content-blocked", "content blocked"]) {
    assert.equal(describeEngineError(raw).kind, "refusal", raw);
  }
});

test("Claude Code version-too-old 400 body", () => {
  const raw =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.257 does not support this model; version 2.1.280 or newer is required. Run \'claude update\', or update the Claude desktop app, then try again.","details":{"error_code":"claude_code_version_too_old"}},"request_id":"req_011CfKDc4d6S7G2EboGzyw6e"}\nraw-http-request=/data/home/.omp/logs/http-400-requests/1790113884865-25v1s84igbb2s.json';
  const result = describeEngineError(raw);
  assert.equal(result.kind, "outdated");
  assert.equal(result.provider, "Claude Code");
  assertClean(result.detail);
  assert.match(result.detail, /does not support this model/i);
});

test("OpenRouter 402 needs more credits", () => {
  const raw =
    "402 This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 11782. To increase, visit https://openrouter.ai/settings/credits and add more credits";
  const result = describeEngineError(raw);
  assert.equal(result.kind, "credits");
  assert.equal(result.provider, "OpenRouter");
  assertClean(result.detail);
  assert.match(result.detail, /more credits/i);
});

test("Anthropic overloaded stream error", () => {
  const raw = "Anthropic stream error (overloaded_error): Overloaded";
  const result = describeEngineError(raw);
  assert.equal(result.kind, "overloaded");
  assert.equal(result.provider, "Anthropic");
  assertClean(result.detail);
  assert.equal(result.detail, "Overloaded");
});

test("usage limit / rate limit / quota texts classify as usage", () => {
  for (const raw of [
    "GoUsageLimitError: weekly usage limit reached",
    "429 Too Many Requests",
    "provider returned rate-limit; retry after 900s",
    "OpenRouter: out of credits ($0.11 left)",
  ]) {
    const result = describeEngineError(raw);
    assert.equal(result.kind, "usage", raw);
    assertClean(result.detail);
  }
});

test("401/403 auth texts classify as auth", () => {
  for (const raw of [
    "401 Unauthorized: invalid api key",
    "403 Forbidden: no provider key configured",
  ]) {
    const result = describeEngineError(raw);
    assert.equal(result.kind, "auth", raw);
    assertClean(result.detail);
  }
});

test("transport failures classify as transport", () => {
  const result = describeEngineError("ECONNRESET while reading the response stream");
  assert.equal(result.kind, "transport");
  assertClean(result.detail);
});

test("user-initiated interruption/abort is quiet-kind 'aborted'", () => {
  assert.equal(describeEngineError("Interrupted by user").kind, "aborted");
  assert.equal(describeEngineError("Request was aborted").kind, "aborted");
});

test("unrecognized text still returns a clean, non-empty detail", () => {
  const result = describeEngineError("something odd happened deep in a provider");
  assert.equal(result.kind, "other");
  assertClean(result.detail);
});

test("never returns an empty detail even for empty/whitespace input", () => {
  assert.ok(describeEngineError("").detail.length > 0);
  assert.ok(describeEngineError("   ").detail.length > 0);
});

test("long text is capped at a word boundary with an ellipsis", () => {
  const raw = "a".repeat(50) + " " + "b".repeat(200);
  const result = describeEngineError(raw);
  assert.ok(result.detail.length <= 181);
  assert.ok(result.detail.endsWith("…"));
});

test("stack frames are stripped", () => {
  const raw = "TypeError: cannot read x\n    at Object.<anonymous> (/app/lib/foo.ts:42:11)\n    at processTicksAndRejections (/app/node.js:10:5)";
  const result = describeEngineError(raw);
  assert.ok(!/at\s+\S+:\d+:\d+/.test(result.detail));
  assert.ok(!/\(\/app/.test(result.detail));
});

test("errorDedupeKey collapses digits so a retry counter doesn't defeat dedup", () => {
  const a = "GoUsageLimitError: weekly usage limit reached (attempt 1 of 5)";
  const b = "GoUsageLimitError: weekly usage limit reached (attempt 2 of 5)";
  assert.equal(errorDedupeKey(a), errorDedupeKey(b));
  assert.ok(sameError(a, b));
});

test("sameError is false across different kinds", () => {
  assert.equal(sameError("401 Unauthorized", "429 Too Many Requests"), false);
});

// ACP engines (lib/harness/acp-session.ts) wrap their raw failure in
// "{engine name}: {error}" before it ever reaches a notice event — the same
// describeEngineError call site has to make sense of that shape too, not just
// omp's own bare provider text.
test("ACP-wrapped Claude Code rate-limit error", () => {
  const raw = 'Claude Code: Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit","request_id":"req_01AbCdEfGhIjKlMnOpQrStUv"}}';
  const result = describeEngineError(raw);
  assert.equal(result.kind, "usage");
  assert.equal(result.provider, "Claude Code");
  assertClean(result.detail);
  assert.match(result.detail, /rate limit/i);
});

test("ACP-wrapped Codex transport disconnect", () => {
  const raw = "Codex: Error: stream disconnected before completion: connection error: Connection reset by peer (os error 104)";
  const result = describeEngineError(raw);
  assert.equal(result.kind, "transport");
  assert.equal(result.provider, "Codex");
  assertClean(result.detail);
  assert.match(result.detail, /stream disconnected/i);
});

// ---------------------------------------------------------------------------
// A full disk
// ---------------------------------------------------------------------------

test("a full disk says so in plain words, whatever shape the engine's error took", () => {
  for (const raw of [
    "ENOSPC: no space left on device, write",
    "Error: ENOSPC: no space left on device, open '/tmp/cs/ab12cd34ef56/target/debug/deps/libfoo.rlib'",
    "write /data/home/.cache/pip/http/x: No space left on device",
    "Codex: Error: ENOSPC while writing the rollout file",
  ]) {
    const result = describeEngineError(raw);
    assert.equal(result.kind, "disk", raw);
    assert.equal(result.provider, undefined, "a full disk is nobody's provider, whatever a path in the text is called");
    assert.match(result.detail, /^The server's disk is full/);
    assert.match(result.detail, /Free some space/);
    assert.match(result.detail, /scratch/, "and says how an agent can help");
    assert.doesNotMatch(result.detail, /ENOSPC|errno|\/tmp/, "none of the jargon survives");
    assertClean(result.detail);
  }
});

test("a quota says so too, including the unnamed errno npm prints", () => {
  for (const raw of [
    "EDQUOT: disk quota exceeded, write",
    "npm error code Unknown system error -122\nnpm error syscall open\nnpm error errno Unknown system error -122",
    "Unknown system error -69",
    "Disk quota exceeded",
    "Disc quota exceeded",
  ]) {
    const result = describeEngineError(raw);
    assert.equal(result.kind, "disk", raw);
    assert.match(result.detail, /^The server's disk quota is used up/, raw);
    assertClean(result.detail);
  }
});

test("a disk problem is not mistaken for the words that happen to sit in its file path", () => {
  for (const raw of [
    "ENOSPC: no space left on device, write '/data/home/.omp/agent/credentials.json'",
    "EDQUOT: disk quota exceeded, open '/home/u/.config/openai/api_key.txt'",
    "Anthropic: ENOSPC while saving the transcript (rate-limit-notes.txt)",
  ]) {
    const result = describeEngineError(raw);
    assert.equal(result.kind, "disk", raw);
    assert.equal(result.provider, undefined, raw);
  }
});

test("a provider's own quota text is still a usage limit, and a refusal is still a refusal", () => {
  for (const raw of [
    "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent request limit per minute for a region'",
    "You exceeded your current quota, please check your plan and billing details",
    "weekly usage limit reached",
  ]) {
    assert.equal(describeEngineError(raw).kind, "usage", raw);
  }
  // Refusal is checked first, as ever: a refusal that also names a disk error is the model declining.
  assert.equal(describeEngineError("Refusal (reasoning_extraction): blocked by safety policy; the log could not be written: ENOSPC").kind, "refusal");
});

test("the same disk error over and over collapses into one notice, however its paths differ", () => {
  assert.ok(sameError("ENOSPC: no space left on device, write '/tmp/a/1.o'", "ENOSPC: no space left on device, open '/tmp/b/2.o'"));
  assert.equal(sameError("ENOSPC: no space left on device, write", "EDQUOT: disk quota exceeded, write"), false, "a quota and a full disk are told apart");
});

test("this module's disk patterns answer like describeDiskError, the one place that knows the errno shapes", () => {
  const inputs = [
    "npm error code Unknown system error -122\nnpm error syscall open\nnpm error errno Unknown system error -122\nUnknown system error -122: Unknown system error -122, open '/data/home/.npm/_cacache/tmp/ce185227'",
    "EDQUOT: disk quota exceeded, write",
    "Unknown system error -69",
    "ENOSPC: no space left on device, write",
    "npm error code E404\nnpm error 404 Not Found",
    "exited with code 1",
    "installed pi-coding-agent@1.122.0",
    "",
  ];
  for (const raw of inputs) {
    const shared = describeDiskError(raw);
    const described = describeEngineError(raw);
    assert.equal(described.kind === "disk", shared !== null, raw);
    if (shared) assert.match(described.detail, shared === "quota" ? /quota is used up/ : /disk is full/, raw);
  }
  // The one difference, on purpose: a bare "quota exceeded" is a provider's usage limit.
  assert.equal(describeDiskError("Quota exceeded for quota metric 'x'"), "quota");
  assert.equal(describeEngineError("Quota exceeded for quota metric 'x'").kind, "usage");
});

test("Cody's own refusal to start work keeps all its words, and a bare HTTP 507 still reads plainly", () => {
  configureDiskGateForTests({ probe: () => ({ totalBytes: 150 * 1024 ** 3, availableBytes: 4.5 * 1024 ** 3 }) });
  try {
    const refusal = checkDiskForNewTurn();
    assert.ok(refusal, "the fake disk is 3% free");
    assert.ok(refusal.message.length > 180, "longer than the cap a provider's one-liner gets");
    const described = describeEngineError(refusal.message);
    assert.equal(described.kind, "disk");
    assert.equal(described.detail, refusal.message, "the half that says what to do is not cut off");
  } finally {
    configureDiskGateForTests(null);
  }

  // What a client that could not read the body is left with.
  const bare = describeEngineError("HTTP 507");
  assert.equal(bare.kind, "disk");
  assert.match(bare.detail, /almost full/);
  assert.equal(describeEngineError("provider gateway answered HTTP 507 for this model").kind, "other", "only the bare status Cody's own client writes counts; a provider's text that merely mentions one does not");
  assert.match(bare.detail, /Settings → System → Disk space/);
  assertClean(bare.detail);
});
