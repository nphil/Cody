import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { describeEngineError, sameError, errorDedupeKey } = await jiti.import("./error-text.ts");

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
