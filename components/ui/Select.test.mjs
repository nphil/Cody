import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { Select, matchesSearch } = await jiti.import("./Select.tsx");

test("typing nothing keeps every option", () => {
  assert.equal(matchesSearch("America/New_York", ""), true);
  assert.equal(matchesSearch("America/New_York", "   "), true);
});

test("a name is found the way a person says it, not the way it is spelled", () => {
  // The separators identifiers use ("_", "/", "-") count as spaces.
  assert.equal(matchesSearch("America/New_York", "new york"), true);
  assert.equal(matchesSearch("America/New_York", "New_York"), true);
  assert.equal(matchesSearch("America/Port-au-Prince", "port au prince"), true);
  // Case is ignored, and a half-typed word already matches.
  assert.equal(matchesSearch("America/New_York", "NEW yo"), true);
});

test("every word typed has to be there, in any order", () => {
  assert.equal(matchesSearch("America/New_York", "york new"), true);
  assert.equal(matchesSearch("America/New_York", "new paris"), false);
  assert.equal(matchesSearch("Asia/Tokyo", "kyoto"), false);
});

test("a searchable select shows the chosen option's label, including a chosen empty value", () => {
  const search = { placeholder: "Search", empty: "No match" };
  const options = [{ value: "", label: "Automatic" }, { value: "Asia/Tokyo", label: "Asia/Tokyo" }];
  const automatic = renderToStaticMarkup(React.createElement(Select, { value: "", onChange() {}, options, search, "aria-label": "Zone" }));
  assert.match(automatic, /role="combobox"/);
  assert.match(automatic, />Automatic<\/span>/);
  const pinned = renderToStaticMarkup(React.createElement(Select, { value: "Asia/Tokyo", onChange() {}, options, search, "aria-label": "Zone" }));
  assert.match(pinned, />Asia\/Tokyo<\/span>/);
  assert.doesNotMatch(pinned, /Automatic/);
});
