import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (file) => readFile(new URL(`./${file}`, import.meta.url), "utf8");

test("desktop activity stays wired to the titlebar and native shell", async () => {
  const [titleBar, appShell, chatWindow, sidebar, desktopShell] = await Promise.all([
    readSource("TitleBar.tsx"),
    readSource("AppShell.tsx"),
    readSource("ChatWindow.tsx"),
    readSource("SessionSidebar.tsx"),
    readSource("../hooks/useDesktopShell.ts"),
  ]);

  assert.match(titleBar, /function ActivitySummary/);
  assert.match(titleBar, /activeSessions/);
  assert.match(titleBar, /activeSubagents/);
  assert.match(titleBar, /role="status"/);
  assert.match(titleBar, /title=\{label\}/);
  assert.match(titleBar, /<ActivitySummary activeSessions=\{activeSessions\} activeSubagents=\{activeSubagents\} \/>/);
  assert.match(appShell, /activeSessions=\{activeSessionCount\} activeSubagents=\{activeSubagentCount\}/);
  assert.match(appShell, /onDesktopActivityChange=\{handleDesktopActivityChange\}/);
  assert.match(appShell, /onActiveSubagentCountChange=\{handleActiveSubagentCountChange\}/);
  assert.match(chatWindow, /onActiveSubagentCountChange\?\.\(activeSubagentCount\)/);
  assert.match(sidebar, /onDesktopActivityChange\?\.\(\{/);
  assert.match(sidebar, /ready: runningStateReady/);
  assert.match(sidebar, /const completedSessionIds = \[\.\.\.previous\]\.filter\(\(id\) => !runningSessionIds\.has\(id\)\)/);
  assert.match(sidebar, /completedSessionIds\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(sidebar, /completionId = `session:\$\{sessionId\}`/);
  assert.match(sidebar, /completions: runningStateReady \? desktopCompletions : \[\]/);
  assert.doesNotMatch(sidebar, /completedInBackground/);
  assert.match(appShell, /completed: true/);
  assert.match(appShell, /completionKind: completion\.completionKind/);
  assert.match(desktopShell, /desktop_status_update/);
  assert.match(desktopShell, /updateDesktopStatus/);
});
