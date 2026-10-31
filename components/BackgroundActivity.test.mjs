import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { BackgroundActivity } = await jiti.import("./BackgroundActivity.tsx");

test("collapsed activity counts events without reading their payloads", () => {
  const messages = [{ get content() { throw new Error("collapsed content was read"); } }, { get details() { throw new Error("collapsed metadata was read"); } }];
  const html = renderToStaticMarkup(React.createElement(BackgroundActivity, { messages, indices: [0, 1] }));
  assert.match(html, /Background activity · 2 events/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.doesNotMatch(html, /background-activity__details/);
});

test("a review-needed group shows its attention label while collapsed", () => {
  const html = renderToStaticMarkup(React.createElement(BackgroundActivity, { messages: [{}], indices: [0], needsReview: true }));
  assert.match(html, /Review results/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /background-activity__details/);
});

test("separate disclosures have distinct accessibility targets", () => {
  const html = renderToStaticMarkup(React.createElement("div", null,
    React.createElement(BackgroundActivity, { messages: [{}], indices: [0] }),
    React.createElement(BackgroundActivity, { messages: [{}], indices: [0] }),
  ));
  const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});
