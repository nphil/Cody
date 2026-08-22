import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("value-derived conditions read the gating setting", async () => {
  const { isConditionSatisfied } = await jiti.import("./settings-conditions.ts");
  const values = { "memory.backend": "mnemopi" };
  const resolve = (key) => values[key];
  assert.equal(isConditionSatisfied("mnemopiActive", resolve), true);
  assert.equal(isConditionSatisfied("hindsightActive", resolve), false);
  assert.equal(isConditionSatisfied(undefined, resolve), true);
  // Unknown predicate: fail open — an inert row beats a silently hidden one.
  assert.equal(isConditionSatisfied("someFuturePredicate", resolve), true);
});

test("host conditions hide the same rows OMP hides, and fail open without host facts", async () => {
  const { isConditionSatisfied } = await jiti.import("./settings-conditions.ts");
  const resolve = () => undefined;
  // omp gates its macOS prompt-editor spelling settings on process.platform;
  // the omp binary runs on the Cody server's machine, so the server's
  // platform answers.
  assert.equal(isConditionSatisfied("macOS", resolve, { platform: "darwin" }), true);
  assert.equal(isConditionSatisfied("macOS", resolve, { platform: "linux" }), false);
  assert.equal(isConditionSatisfied("macOS", resolve), true);
  // Host facts must not swallow value-derived predicates.
  assert.equal(
    isConditionSatisfied("advisorEnabled", (key) => (key === "advisor.enabled" ? true : undefined), { platform: "linux" }),
    true,
  );
});
