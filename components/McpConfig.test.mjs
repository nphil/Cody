import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { McpConfig, mcpRoute, mcpInventoryOf, serverSummary } = await jiti.import("./McpConfig.tsx");
const { resetSettingsRouteCache } = await jiti.import("../hooks/useSettingsData.ts");

// The panel writes servers to the PROJECT file, but the engine also loads a
// user-level file (`<agent dir>/mcp.json`) that applies to every project. That
// path is not guessable: a containerised install relocates the agent dir, so
// the obvious `~/.omp/mcp.json` is read by nothing. Disclosing it in the header
// is the only thing that tells someone where a hand-written, all-projects
// server belongs.
test("header discloses the user-level MCP config path", () => {
  resetSettingsRouteCache();
  const html = renderToStaticMarkup(React.createElement(McpConfig, { cwd: null }));

  assert.match(html, /Configured MCP Servers/);
  // The header is the SINGLE place the path is disclosed. The fallback section
  // below it is a bare "User level" group label, matching the inventory's
  // source labels, so the path is never printed twice on one screen.
  assert.match(html, /User level:/);
  assert.equal(html.split("User level:").length - 1, 1);
  assert.doesNotMatch(html, /User level \(/);
});

test("renders with no workspace selected", () => {
  resetSettingsRouteCache();
  const html = renderToStaticMarkup(React.createElement(McpConfig, { cwd: null }));

  // The project editor is workspace-gated, so without a cwd only the summary
  // section exists. The user-level disclosure must survive that gating, since a
  // user-level server is exactly what is configurable without a project.
  assert.doesNotMatch(html, /Project MCP Servers/);
  assert.match(html, /User level:/);
});

// Static markup reads the route cache's SERVER snapshot (always empty), so
// the fixture arrives through `initial`, the same seam a caller holding a
// prefetch uses.
test("lists the inventory on Directory rows and the project file behind openable rows, with no dialog mounted", () => {
  resetSettingsRouteCache();
  const cwd = "/work/app";
  const html = renderToStaticMarkup(React.createElement(McpConfig, { cwd, initial: {
    path: "/work/app/.omp/mcp.json",
    servers: [
      { name: "filesystem", config: { type: "stdio", command: "npx", args: ["-y", "fs-server"] } },
      { name: "broken", config: { type: "http" } },
    ],
    user: { path: "/data/agent/mcp.json", servers: [{ name: "github", status: "configured", type: "http", enabled: true, valid: true }], disabledServers: [] },
    inventory: [
      { name: "github", source: "User level", status: "configured", type: "http" },
      { name: "filesystem", source: "Project level", status: "configured", type: "stdio" },
    ],
  } }));

  assert.match(html, /Configured MCP Servers/);
  assert.match(html, /Project MCP Servers/);
  assert.match(html, /role="list"/, "servers render on the Directory primitive");
  assert.match(html, /data-search-id="mcp-github"/, "every server is a search target");
  assert.match(html, /data-search-id="mcp-filesystem"/);
  assert.match(html, /1\/2 enabled · 1 invalid/, "the project header counts valid and invalid servers");
  // A project server row is a real <button> inside its `role="listitem"`
  // wrapper (Directory.tsx), not a clickable div wearing tabindex="0".
  assert.match(html, /<button[^>]*type="button"[^>]*class="settings-directory-row ui-focus-ring"/, "a project server row opens its form");
  assert.match(html, /Add server/);
  // The form and the remove confirmation are closed: no second dialog, no
  // drawer, until a row is opened.
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /Server configuration \(JSON\)/);
  resetSettingsRouteCache();
});

test("route keys and inventory helpers are stable", () => {
  assert.equal(mcpRoute(null), "/api/mcp");
  assert.equal(mcpRoute("/w s"), "/api/mcp?cwd=%2Fw+s");
  assert.equal(mcpRoute("/w", "abc"), "/api/mcp?cwd=%2Fw&sessionId=abc");
  assert.deepEqual(mcpInventoryOf(null), []);
  assert.deepEqual(mcpInventoryOf({ inventory: [{ name: "a", source: "s", status: "configured" }] }).map((server) => server.name), ["a"]);
  // Live status wins over the static inventory when a session answered.
  assert.deepEqual(mcpInventoryOf({ inventory: [{ name: "a", source: "s", status: "configured" }], liveServers: [{ name: "b", source: "s", status: "connected" }] }).map((server) => server.name), ["b"]);
  assert.equal(serverSummary({ type: "http", url: "http://x" }).valid, true);
  assert.equal(serverSummary({ type: "http" }).valid, false);
  assert.equal(serverSummary({ command: "npx", url: "http://x" }).valid, false, "a server cannot be both stdio and http");
});
