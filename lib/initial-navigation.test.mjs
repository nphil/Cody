import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./initial-navigation.ts");
}

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    cwd: " /work/project ",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    requestedCwd: "/work/project",
    sessionId: null,
  });
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session" },
  );
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "  ", session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session" },
  );
});

test("preserves a URL-encoded Windows path", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams("cwd=C%3A%5CProjects%5Cpi-web")),
    { requestedCwd: "C:\\Projects\\pi-web", sessionId: null },
  );
});

test("opens only a real Settings hub from the settings parameter", async () => {
  const { getInitialSettingsTab } = await loadSubject();

  assert.equal(getInitialSettingsTab(new URLSearchParams({ settings: "providers" })), "providers");
  assert.equal(getInitialSettingsTab(new URLSearchParams({ settings: "notifications", session: "saved-session" })), "notifications");
  assert.equal(getInitialSettingsTab(new URLSearchParams()), null);
  assert.equal(getInitialSettingsTab(new URLSearchParams({ settings: "nope" })), null);
  // Inherited object keys are not hubs.
  assert.equal(getInitialSettingsTab(new URLSearchParams({ settings: "constructor" })), null);
  assert.equal(getInitialSettingsTab(new URLSearchParams({ settings: "__proto__" })), null);
});
