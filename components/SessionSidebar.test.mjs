import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The sidebar's remembered view and its reaction to a page that slept, pinned
 * at the seam. The decisions are tested without a DOM elsewhere
 * (lib/sidebar-prefs.test.mjs, lib/live-stream.test.mjs, lib/page-wake.test.mjs);
 * what only a source contract can pin is that this component actually uses them.
 */

const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const runningRoute = await readFile(new URL("../app/api/agent/running/events/route.ts", import.meta.url), "utf8");

test("the view choices of this browser are stored and restored, each under its own key", () => {
  assert.match(sidebar, /useStoredFlag\(STORAGE_KEYS\.sidebarRunningOnly, false\)/);
  assert.match(sidebar, /useStoredFlag\(STORAGE_KEYS\.sidebarShowAllRecent, false\)/);
  assert.match(sidebar, /useStoredFlag\(STORAGE_KEYS\.sidebarExplorerOpen, true\)/);
  assert.match(sidebar, /useStoredIdSet\(STORAGE_KEYS\.sidebarFullProjectLists\)/);
  // Chat ids belong to the engine that minted them, so collapsed forks are per engine.
  assert.match(sidebar, /useStoredIdSet\(engineScopedKey\(STORAGE_KEYS\.sidebarCollapsedForks, engineId\)\)/);
  // The sidebar itself, open or shut, lives in the shell.
  assert.match(shell, /useStoredFlag\(STORAGE_KEYS\.sidebarOpen, true\)/);
  // Recent / Projects is picked once and kept.
  assert.match(sidebar, /window\.localStorage\.setItem\(STORAGE_KEYS\.sidebarView, view\)/);
  assert.match(sidebar, /useEffect\(\(\) => \{ setSidebarView\(loadSidebarView\(\)\); \}, \[\]\)/);
});

test("the search box is deliberately not remembered: a typed query is a moment's question", () => {
  assert.match(sidebar, /const \[searchOpen, setSearchOpen\] = useState\(false\);/);
  assert.match(sidebar, /const \[searchQuery, setSearchQuery\] = useState\(""\);/);
  assert.doesNotMatch(sidebar, /STORAGE_KEYS\.sidebarSearch/);
});

test("a restored running-only filter that matches nothing says so instead of looking broken", () => {
  assert.match(sidebar, /runningOnly && searchQuery\.trim\(\)\.length === 0 \? t\("sessionSidebar\.noRunning"\)/);
});

test("the running stream is opened by openLiveStream, never by a bare EventSource", () => {
  assert.match(sidebar, /openLiveStream\(\{\s*\n\s*url: "\/api\/agent\/running\/events",\s*\n\s*silenceLimitMs: RUNNING_STREAM_SILENCE_MS,/);
  assert.doesNotMatch(sidebar, /new EventSource\(/);
  // The page keeps the handle so a wake can ask for a fresh connection.
  assert.match(sidebar, /runningStreamRef\.current = stream;/);
  assert.match(sidebar, /stream\.close\(\);/);
});

test("the silence limit is longer than two of the server's heartbeats, so a healthy quiet stream is never cut", () => {
  const limit = Number(sidebar.match(/const RUNNING_STREAM_SILENCE_MS = ([\d_]+);/)?.[1].replaceAll("_", ""));
  const beat = Number(runningRoute.match(/\}, ([\d_]+)\);\s*\n\s*\n?\s*const cleanup/)?.[1].replaceAll("_", ""));
  assert.ok(limit > 0 && beat > 0, "both numbers are found in the source");
  assert.ok(limit > 2 * beat, `${limit} ms must exceed two ${beat} ms heartbeats`);
  // The heartbeat is a data frame (an SSE comment is invisible to EventSource).
  assert.match(runningRoute, /encode\(\{ type: "heartbeat"/);
});

test("a page wake re-opens the running stream and reads the session list, projects and worktrees once", () => {
  assert.match(sidebar, /import \{ usePageWake \} from "@\/hooks\/usePageWake";/);
  const wake = sidebar.slice(sidebar.indexOf("usePageWake(() => {"), sidebar.indexOf("// Keep every just-created session"));
  assert.ok(wake.length > 0, "the wake handler exists");
  assert.match(wake, /runningStreamRef\.current\?\.reopen\(\);/);
  assert.match(wake, /void loadSessions\(false\);/);
  assert.match(wake, /void loadProjects\(\);/);
  assert.match(wake, /setWtRefreshKey\(\(k\) => k \+ 1\);/);
  // One round: the handler must not add its own timers or listeners.
  assert.doesNotMatch(wake, /setTimeout|setInterval|addEventListener/);
});
