import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { McpConfig } = await jiti.import("./McpConfig.tsx");

// The panel writes servers to the PROJECT file, but OMP also loads a user-level
// file (`<agent dir>/mcp.json`) that applies to every project. That path is not
// guessable: a containerised install relocates the agent dir, so the obvious
// `~/.omp/mcp.json` is read by nothing. Disclosing it in the header is the only
// thing that tells someone where a hand-written, all-projects server belongs.
test("header discloses the user-level MCP config path", () => {
  const html = renderToStaticMarkup(React.createElement(McpConfig, { cwd: null }));

  assert.match(html, /Configured MCP Servers/);
  // The header is the SINGLE place the path is disclosed. The live-status fallback
  // below it is a bare "User level" group label, matching the grouped list's source
  // labels, so the path is never printed twice on one screen.
  assert.match(html, /User level:/);
  assert.equal(html.split("User level:").length - 1, 1);
  assert.doesNotMatch(html, /User level \(/);
});

test("renders with no workspace selected", () => {
  const html = renderToStaticMarkup(React.createElement(McpConfig, { cwd: null }));

  // The project editor is workspace-gated, so without a cwd only the summary
  // section exists. The user-level disclosure must survive that gating, since a
  // user-level server is exactly what is configurable without a project.
  assert.doesNotMatch(html, /Project MCP Servers/);
  assert.match(html, /User level:/);
});
