import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  ACTIONABLE_NOTICE_VISIBLE_MS,
  autoRedeemSettingKeys,
  credentialProviderName,
  missingApiKeyProvider,
  missingCredentialProvider,
  noticeCtaForDedupeKey,
  pickRedeemableResetCredit,
  savedResetDedupeKey,
  savedResetEligibleProvider,
  signedOutDedupeKey,
} = await jiti.import("./credential-notices.ts");

// Exact strings from the engines' sources:
//   18.19.0 src/session/turn-recovery.ts applyMissingCredentialFallback: `no credential for ${provider}`
//   18.19.0 src/session/agent-session.ts (PromptPreflightError) and 18.8.3 src/session/agent-session.ts (plain Error):
//     "No API key found for ${provider}.\n\nUse /login, set an API key environment variable, or create <agent.db>"
//   src/config/model-registry.ts: `No API key found for "${provider}"`
//   both engines' saved-reset headless notice (source claude-auto-reset | codex-auto-reset):
const PREFLIGHT = "No API key found for anthropic.\n\nUse /login, set an API key environment variable, or create /data/agent/agent.db";
const ELIGIBLE_NEW = "Saved Claude resets are eligible to spend, but auto-redeem is unset and no prompt UI is available. Run `/usage reset` or set claudeResets.autoRedeem5h, claudeResets.autoRedeemWeekly, claudeResets.autoRedeemFable.";
const ELIGIBLE_OLD = "Saved Codex resets are eligible to spend, but auto-redeem is unset and no prompt UI is available. Run `/usage reset` or set codexResets.autoRedeem.";

test("the signed-out hop reason names the provider", () => {
  assert.equal(missingCredentialProvider("no credential for anthropic"), "anthropic");
  assert.equal(missingCredentialProvider("no credential for openai-codex"), "openai-codex");
  assert.equal(missingCredentialProvider("  no credential for google.vertex \n"), "google.vertex");
});

test("every other hop reason is not a sign-out", () => {
  assert.equal(missingCredentialProvider("429 rate limit"), null);
  assert.equal(missingCredentialProvider("usage limit reached"), null);
  assert.equal(missingCredentialProvider("no credential for"), null);
  assert.equal(missingCredentialProvider(""), null);
  assert.equal(missingCredentialProvider(undefined), null);
  assert.equal(missingCredentialProvider({ reason: "no credential for x" }), null);
});

test("the prompt refusal text of both engines names the provider", () => {
  assert.equal(missingApiKeyProvider(PREFLIGHT), "anthropic");
  // Cody's own describeEngineError flattens the blank line into a space.
  assert.equal(missingApiKeyProvider("No API key found for anthropic. Use /login, set an API key environment variable, or create /x/agent.db"), "anthropic");
  assert.equal(missingApiKeyProvider("Error: No API key found for openai-codex.\n\nUse /login"), "openai-codex");
  assert.equal(missingApiKeyProvider("No API key found for google.vertex.\n\nUse /login"), "google.vertex");
  assert.equal(missingApiKeyProvider("No API key found for anthropic."), "anthropic");
});

test("the model registry's quoted refusal names the provider", () => {
  assert.equal(missingApiKeyProvider('No API key found for "anthropic"'), "anthropic");
  assert.equal(missingApiKeyProvider('Error: No API key found for "openrouter"'), "openrouter");
});

test("other errors are not read as a missing key", () => {
  assert.equal(missingApiKeyProvider("401 invalid x-api-key"), null);
  assert.equal(missingApiKeyProvider("No API key found"), null);
  assert.equal(missingApiKeyProvider(""), null);
  assert.equal(missingApiKeyProvider(undefined), null);
  assert.equal(missingApiKeyProvider(42), null);
});

test("a provider id reads as a plain name", () => {
  assert.equal(credentialProviderName("anthropic"), "Claude");
  assert.equal(credentialProviderName("my-custom_provider"), "My Custom Provider");
});

test("the saved-reset headless notice maps for both providers and both engines", () => {
  assert.equal(savedResetEligibleProvider("claude-auto-reset", ELIGIBLE_NEW), "anthropic");
  assert.equal(savedResetEligibleProvider("codex-auto-reset", ELIGIBLE_OLD), "openai-codex");
});

test("other saved-reset notices keep their own words", () => {
  for (const message of [
    "Auto-redeemed a saved Claude rate-limit reset for work (2 left); continuing.",
    "A saved Claude reset for work was already redeemed elsewhere.",
    "Claude reset for work reported nothing to reset; will retry later.",
    "Claude auto-redeem for work failed (429); will retry later.",
  ]) {
    assert.equal(savedResetEligibleProvider("claude-auto-reset", message), null);
  }
  // The same words from another source are not this notice.
  assert.equal(savedResetEligibleProvider("xdev", ELIGIBLE_NEW), null);
  assert.equal(savedResetEligibleProvider(undefined, ELIGIBLE_NEW), null);
  assert.equal(savedResetEligibleProvider("claude-auto-reset", undefined), null);
});

test("the shelf finds its buttons from the notice key", () => {
  assert.deepEqual(noticeCtaForDedupeKey(signedOutDedupeKey("anthropic")), { kind: "sign_in", provider: "anthropic" });
  assert.deepEqual(noticeCtaForDedupeKey(signedOutDedupeKey("google.vertex")), { kind: "sign_in", provider: "google.vertex" });
  assert.deepEqual(noticeCtaForDedupeKey(savedResetDedupeKey("anthropic")), { kind: "saved_reset", provider: "anthropic" });
  assert.deepEqual(noticeCtaForDedupeKey(savedResetDedupeKey("openai-codex")), { kind: "saved_reset", provider: "openai-codex" });
  assert.equal(noticeCtaForDedupeKey("saved-reset:something-else"), undefined);
  assert.equal(noticeCtaForDedupeKey("signed-out:"), undefined);
  assert.equal(noticeCtaForDedupeKey("error:429"), undefined);
  assert.equal(noticeCtaForDedupeKey(undefined), undefined);
  assert.ok(ACTIONABLE_NOTICE_VISIBLE_MS > 5000);
});

test("auto-redeem settings list the newest spelling first and the 18.8.3 one last", () => {
  assert.deepEqual(autoRedeemSettingKeys("anthropic"), ["claudeResets.autoRedeem5h", "claudeResets.autoRedeemWeekly", "claudeResets.autoRedeem"]);
  assert.deepEqual(autoRedeemSettingKeys("openai-codex"), ["codexResets.autoRedeem5h", "codexResets.autoRedeemWeekly", "codexResets.autoRedeem"]);
});

const account = (over) => ({ id: "a1", provider: "anthropic", canRedeem: true, credits: [{ id: "c1" }, { id: "c2" }], ...over });

test("the button spends the first spendable credit of the matching provider", () => {
  const snapshot = {
    available: true,
    accounts: [
      account({ id: "codex", provider: "openai-codex", credits: [{ id: "x" }] }),
      account({ id: "locked", canRedeem: false }),
      account({ id: "busy", retrying: true }),
      account({ id: "empty", credits: [] }),
      account({ id: "ok" }),
    ],
  };
  assert.deepEqual(pickRedeemableResetCredit(snapshot, "anthropic"), { accountId: "ok", creditId: "c1" });
  assert.deepEqual(pickRedeemableResetCredit(snapshot, "openai-codex"), { accountId: "codex", creditId: "x" });
});

test("no spendable credit means no button", () => {
  assert.equal(pickRedeemableResetCredit(null, "anthropic"), null);
  assert.equal(pickRedeemableResetCredit({ available: false, accounts: [account()] }, "anthropic"), null);
  assert.equal(pickRedeemableResetCredit({ available: true, accounts: [account({ canRedeem: false })] }, "anthropic"), null);
  assert.equal(pickRedeemableResetCredit({ available: true, accounts: [account({ provider: "openai-codex" })] }, "anthropic"), null);
});
