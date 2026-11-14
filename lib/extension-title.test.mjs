import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { extensionPrompt, splitExtensionTitle } = await jiti.import("./extension-title.ts");

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

test("an ordinary prompt keeps its question on line 1 and the body never repeats it", () => {
  const prompt = extensionPrompt({ title: "Spend 2 saved resets?\nwork: 5h left." }, false);
  assert.deepEqual(prompt, { headline: "Spend 2 saved resets?", details: "work: 5h left.", ask: false, inBody: false });
});

test("the model's ask puts its question last, under the text around the field", () => {
  const title = "Database plan\n\n- Step 1: users.\n- Step 2: orders.\n\nWhich steps should run?";
  assert.deepEqual(extensionPrompt({ title }, true), {
    headline: "Which steps should run?",
    details: "Database plan\n\n- Step 1: users.\n- Step 2: orders.",
    ask: true,
    inBody: true,
  });
  // Read as any other engine prompt, line 1 would be taken for the question.
  assert.equal(extensionPrompt({ title }, false).headline, "Database plan");
  assert.deepEqual(extensionPrompt({ title: "Notes\r\n\r\nWhich?\r\n" }, true), { headline: "Which?", details: "Notes", ask: true, inBody: true });
});

test("a step of the ask walk is already split: its count and its context are not read twice", () => {
  const request = { title: "ignored\n\n(1 selected) Which?", walk: { question: "Which?", context: "Notes above." } };
  assert.deepEqual(extensionPrompt(request, false), { headline: "Which?", details: "Notes above.", ask: true, inBody: true });
});

test("the body repeats the question only when the header cannot show it", () => {
  assert.deepEqual(extensionPrompt({ title: "Which plan?" }, true), { headline: "Which plan?", details: "", ask: true, inBody: false });
  assert.equal(extensionPrompt({ title: "x".repeat(34) }, true).inBody, false, "one header line holds about 34 Latin characters");
  assert.equal(extensionPrompt({ title: "x".repeat(35) }, true).inBody, true);
  assert.equal(extensionPrompt({ title: "你".repeat(17) }, true).inBody, false, "a CJK character counts twice");
  assert.equal(extensionPrompt({ title: "你".repeat(18) }, true).inBody, true);
  assert.deepEqual(extensionPrompt({ title: "\n\n" }, true), { headline: "", details: "", ask: true, inBody: false });
});
