import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const FAKE_BIN = "/tmp/ompkg/package/bin/omp";
const skip = !fs.existsSync(FAKE_BIN) && "omp package not extracted";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function loadRoleIds(bin) {
  process.env.CODY_OMP_BIN = bin;
  const loaded = await jiti.import("./model-roles.ts");
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  loaded.clearOmpModelRoleIdsCache();
  return { loaded, ids: loaded.getOmpModelRoleIds() };
}

/** MODEL_ROLE_IDS read straight out of the package's text, so the assertion
 * below is not just the loader agreeing with itself. */
function declaredRoleIds() {
  const source = fs.readFileSync(path.join(path.dirname(FAKE_BIN), "..", "src", "config", "model-roles.ts"), "utf8");
  const body = source.match(/MODEL_ROLE_IDS[^=]*=\s*\[([^\]]*)\]/)[1];
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("takes the role list from the installed engine, not a frozen copy", { skip }, async () => {
  const { ids } = await loadRoleIds(FAKE_BIN);
  assert.deepEqual([...ids], declaredRoleIds());
});

test("falls back to the audited list when omp cannot be read", async () => {
  const { loaded, ids } = await loadRoleIds("/nonexistent/omp");
  assert.deepEqual([...ids], [...loaded.FALLBACK_MODEL_ROLE_IDS]);
  delete process.env.CODY_OMP_BIN;
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  loaded.clearOmpModelRoleIdsCache();
});

test("the fallback list carries no role the engine has dropped", async () => {
  // omp removed `designer` in 18.1.5. A stale fallback would put it back the
  // moment omp is missing, which is exactly when nothing can correct it.
  const { loaded } = await loadRoleIds("/nonexistent/omp");
  assert.equal(loaded.FALLBACK_MODEL_ROLE_IDS.includes("designer"), false);
  delete process.env.CODY_OMP_BIN;
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  loaded.clearOmpModelRoleIdsCache();
});
