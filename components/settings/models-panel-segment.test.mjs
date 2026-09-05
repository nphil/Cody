import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * `ModelsPanel`'s segment used to be local `useState`, synced from `sub`
 * only on CHANGE (`components/settings/panels/ModelsPanel.tsx`). Search
 * landing on the same `sub` twice — e.g. "Model roles" then later "Retry &
 * fallback", both `sub: "assignments"` — made `setSub` a no-op (same value),
 * so the effect never re-ran and the panel stayed on whichever segment a
 * manual click had left it on, silently swallowing the jump. Deriving the
 * segment straight from `sub` (as `ExtensionsPanel` derives `active`) makes
 * that class of bug impossible: there is no second state to fall out of sync.
 */
const panel = await readFile(new URL("./panels/ModelsPanel.tsx", import.meta.url), "utf8");

test("the segment is derived from `sub`, not a separate useState the shell can desync from", () => {
  assert.doesNotMatch(panel, /useState<Segment>/, "a local segment state is exactly the bug this fix removes");
  assert.match(panel, /const segment: Segment = sub === "assignments" && hasAssignments \? "assignments" : "catalog";/);
});

test("the segment control routes through the shell's selectSection, like ExtensionsPanel's", async () => {
  const extensionsPanel = await readFile(new URL("./panels/ExtensionsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /onChange=\{\(id\) => callbacks\.selectSection\("models", id\)\}/);
  assert.match(extensionsPanel, /callbacks\.selectSection\("extensions", id\)/, "the pattern this fix follows");
});
