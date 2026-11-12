import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { splitExtensionTitle } = await jiti.import("./extension-title.ts");

test("single-line titles stay whole", () => {
  assert.deepEqual(splitExtensionTitle("Pick one"), { headline: "Pick one", details: "" });
});

test("omp's saved-reset consent keeps its question as the headline and the account lines as details", () => {
  const title = "Spend 2 saved Claude rate-limit resets?\nwork: 5h session-only reset covers 5h with about 2h left.\nhome: weekly reset expires in 3d; 7d is 80% used.";
  assert.deepEqual(splitExtensionTitle(title), {
    headline: "Spend 2 saved Claude rate-limit resets?",
    details: "work: 5h session-only reset covers 5h with about 2h left.\nhome: weekly reset expires in 3d; 7d is 80% used.",
  });
});

test("CRLF and surrounding blank lines are normalised", () => {
  assert.deepEqual(splitExtensionTitle("\r\nQ?\r\nmore\r\n"), { headline: "Q?", details: "more" });
});
