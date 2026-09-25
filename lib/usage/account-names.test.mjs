import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { providerAccountNameKey } = await jiti.import("../provider-account-names.ts");
const { withUsageAccountNames } = await jiti.import("./account-names.ts");

function usageAccount(provider, credentialId, identity = null) {
  return {
    provider, credentialId, identity, id: `${provider}:${credentialId ?? "unknown"}`,
    label: "Engine label", planType: null, unlimited: false, windows: [],
  };
}

test("usage display names match the provider and exact credential without changing quota data", () => {
  const named = usageAccount("devin", 7, "work@example.com");
  const other = usageAccount("devin", 8, "other@example.com");
  const unlinked = usageAccount("devin", null, "work@example.com");
  const differentProvider = usageAccount("anthropic", 7, "work@example.com");
  const snapshot = { available: true, accounts: [named, other, unlinked, differentProvider], fetchedAt: "2026-09-25T00:00:00Z", stale: false };
  const names = {
    [providerAccountNameKey("devin", "7", "work@example.com")]: {
      provider: "devin", accountId: "7", identity: "work@example.com", name: "Work",
    },
  };

  const result = withUsageAccountNames(snapshot, names);
  assert.equal(result.accounts[0].customName, "Work");
  assert.equal(result.accounts[0].credentialId, 7);
  assert.equal(result.accounts[0].label, "Engine label");
  assert.equal(snapshot.accounts[0].customName, undefined);
  assert.strictEqual(result.accounts[1], other);
  assert.strictEqual(result.accounts[2], unlinked);
  assert.strictEqual(result.accounts[3], differentProvider);
});

test("clearing a stored name removes it from a later response", () => {
  const account = { ...usageAccount("devin", 7), customName: "Old name" };
  const snapshot = { available: true, accounts: [account], fetchedAt: "2026-09-25T00:00:00Z", stale: false };
  const result = withUsageAccountNames(snapshot, {});
  assert.equal(result.accounts[0].customName, undefined);
  assert.equal(account.customName, "Old name");
});
