import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { StatusTextCrossfade } = await jiti.import("./StatusTextCrossfade.tsx");

test("renders the label inside the crossfade stack", () => {
  const html = renderToStaticMarkup(React.createElement(StatusTextCrossfade, { text: "Waiting for model…" }));
  assert.match(html, /chat-status-swap/);
  assert.match(html, /chat-status-swap-in/);
  assert.match(html, /Waiting for model…/);
});

test("initial render carries no outgoing ghost", () => {
  const html = renderToStaticMarkup(React.createElement(StatusTextCrossfade, { text: "Thinking…" }));
  assert.doesNotMatch(html, /chat-status-swap-out/);
});
