import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { buildProviderUsageGroups, providerUsageAccountTitle, selectProviderUsageWindows } = await jiti.import("./ProviderUsagePopover.tsx");

function window(id, utilization, state = "ok", windowMs = 18_000_000) {
  return { id, label: id, utilization, state, windowMs, resetsAt: null };
}

function account(overrides = {}) {
  return {
    provider: "devin",
    id: "account-1",
    credentialId: 1,
    identity: "person@example.com",
    label: "Devin",
    planType: null,
    unlimited: false,
    windows: [window("five-hour", 15)],
    ...overrides,
  };
}

test("groups by provider and stable credential order while displaying a saved name", () => {
  const groups = buildProviderUsageGroups([
    account({ id: "second", credentialId: 8, customName: "Work" }),
    account({ id: "first", credentialId: 3, customName: "Personal" }),
    account({ id: "codex", provider: "openai-codex", credentialId: 1 }),
  ]);
  assert.deepEqual(groups.map((group) => group.provider), ["devin", "openai-codex"]);
  assert.deepEqual(groups[0].accounts.map((row) => row.title), ["Personal", "Work"]);
  assert.deepEqual(groups[0].accounts.map((row) => row.account.credentialId), [3, 8]);
});

test("unnamed account gets its position; disabled and unreported quota are omitted", () => {
  const groups = buildProviderUsageGroups([
    account({ id: "first" }),
    account({ id: "second", credentialId: 2, identity: "another@example.com" }),
    account({ id: "disabled", credentialId: 3, disabled: { cause: "auth" } }),
    account({ id: "empty", credentialId: 4, windows: [] }),
  ]);
  assert.deepEqual(groups[0].accounts.map((row) => row.title), ["Primary", "Secondary"]);
  assert.equal(providerUsageAccountTitle(account({ customName: "  Team  " }), 0, 2), "Team");
});

test("binding window leads, next constraint remains visible, rest are disclosed", () => {
  const selected = selectProviderUsageWindows(account({
    windows: [
      window("weekly", 95, "warning", 604_800_000),
      window("five-hour", 20, "ok", 18_000_000),
      window("monthly", 12, "ok", 2_592_000_000),
    ],
  }));
  assert.deepEqual(selected.windows.map((item) => item.id), ["five-hour", "weekly"]);
  assert.deepEqual(selected.moreWindows.map((item) => item.id), ["monthly"]);
});
