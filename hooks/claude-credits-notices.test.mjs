import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  PLAN_LIMIT_NOTICE_HOLD_MS,
  PLAN_LIMIT_RETRY_BANNER_HOLD_MS,
  creditsNoticeKind,
  modelSelector,
  shouldHoldPlanLimitNotice,
  shouldHoldRetryBanner,
} = await jiti.import("./claude-credits-notices.ts");

// Shaped like the frame omp sends when a Claude plan is rate limited.
const PLAN_LIMIT = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}} retry-after-ms=3600000';

test("a Claude plan hitting its limit is held for the credits hand-off", () => {
  assert.equal(shouldHoldPlanLimitNotice({ provider: "anthropic", errorMessage: PLAN_LIMIT }), true);
  assert.equal(shouldHoldPlanLimitNotice({ provider: "anthropic", errorMessage: "  usage limit reached  " }), true);
});

test("other plan failures are never held", () => {
  assert.equal(shouldHoldPlanLimitNotice({ provider: "anthropic", errorMessage: "401 invalid x-api-key" }), false);
  assert.equal(shouldHoldPlanLimitNotice({ provider: "anthropic", errorMessage: "Overloaded" }), false);
  assert.equal(shouldHoldPlanLimitNotice({ provider: "anthropic", errorMessage: "" }), false);
  assert.equal(shouldHoldPlanLimitNotice({ provider: "anthropic" }), false);
});

test("limits on other providers, or on the credits themselves, are never held", () => {
  assert.equal(shouldHoldPlanLimitNotice({ provider: "openai-codex", errorMessage: PLAN_LIMIT }), false);
  assert.equal(shouldHoldPlanLimitNotice({ provider: "openrouter", errorMessage: PLAN_LIMIT }), false);
  assert.equal(shouldHoldPlanLimitNotice({ provider: "anthropic-api", errorMessage: PLAN_LIMIT }), false);
  assert.equal(shouldHoldPlanLimitNotice({ errorMessage: PLAN_LIMIT }), false);
  assert.equal(shouldHoldPlanLimitNotice(null), false);
  assert.equal(shouldHoldPlanLimitNotice(undefined), false);
});

test("the hold is short enough to read as prompt", () => {
  assert.ok(PLAN_LIMIT_NOTICE_HOLD_MS > 0 && PLAN_LIMIT_NOTICE_HOLD_MS <= 1_500);
});

test("plan -> credits is a switch, credits -> plan is a return", () => {
  assert.equal(creditsNoticeKind("anthropic/claude-opus-5-5:high", "anthropic-api/claude-opus-5-5"), "switch");
  assert.equal(creditsNoticeKind("anthropic-api/claude-opus-5-5", "anthropic/claude-opus-5-5"), "return");
});

test("every other model change is neither", () => {
  assert.equal(creditsNoticeKind("anthropic/claude-opus-5-5", "openai-codex/gpt-5"), null);
  assert.equal(creditsNoticeKind("openai-codex/gpt-5", "anthropic-api/claude-opus-5-5"), null);
  assert.equal(creditsNoticeKind("anthropic-api/claude-opus-5-5", "openrouter/x"), null);
  assert.equal(creditsNoticeKind("anthropic/a", "anthropic/b"), null);
  assert.equal(creditsNoticeKind("anthropic-api/a", "anthropic-api/b"), null);
  assert.equal(creditsNoticeKind("?", "?"), null);
  assert.equal(creditsNoticeKind(undefined, null), null);
});

test("an authoritative model becomes a provider/model selector", () => {
  const selector = modelSelector({ provider: "anthropic-api", modelId: "claude-opus-5-5" });
  assert.equal(selector, "anthropic-api/claude-opus-5-5");
  assert.equal(creditsNoticeKind(modelSelector({ provider: "anthropic-api", modelId: "m" }), modelSelector({ provider: "anthropic", modelId: "m" })), "return");
});

test("the retry banner for a Claude plan limit is held, only for the main chat", () => {
  assert.equal(shouldHoldRetryBanner({ job: "main", provider: "anthropic", errorMessage: PLAN_LIMIT }), true);
  assert.equal(shouldHoldRetryBanner({ job: "subagent", provider: "anthropic", errorMessage: PLAN_LIMIT }), false);
});

test("every other retry banner shows at once", () => {
  assert.equal(shouldHoldRetryBanner({ job: "main", provider: "openai-codex", errorMessage: PLAN_LIMIT }), false);
  assert.equal(shouldHoldRetryBanner({ job: "main", provider: "anthropic-api", errorMessage: PLAN_LIMIT }), false);
  assert.equal(shouldHoldRetryBanner({ job: "main", provider: "anthropic", errorMessage: "Overloaded" }), false);
  assert.equal(shouldHoldRetryBanner({ job: "main", provider: "anthropic", errorMessage: "401 invalid x-api-key" }), false);
  assert.equal(shouldHoldRetryBanner({ job: "main", errorMessage: PLAN_LIMIT }), false);
  assert.equal(shouldHoldRetryBanner({ job: "main", provider: "anthropic" }), false);
});

test("the banner hold outlasts the server's 1.2 s hold on the switch frame", () => {
  assert.ok(PLAN_LIMIT_RETRY_BANNER_HOLD_MS > 1_200 + 200);
});
