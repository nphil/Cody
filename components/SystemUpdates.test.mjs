import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("system update confirmations use the shared Cody dialog for every destructive action", async () => {
  const [systemUpdates, engineRoster] = await Promise.all([
    readFile(new URL("./settings/SystemUpdates.tsx", import.meta.url), "utf8"),
    readFile(new URL("./settings/EngineRoster.tsx", import.meta.url), "utf8"),
  ]);

  // The upstream Settings redesign moved engine actions from SystemUpdates
  // into EngineRoster. Keep this regression test pointed at the new owner so
  // a future upstream merge cannot silently reintroduce browser prompts.
  assert.match(systemUpdates, /<EngineRoster mode="manage"/);
  assert.match(engineRoster, /import \{ ConfirmDialog \} from "@\/components\/ui\/field"/);
  assert.match(engineRoster, /type PendingAction =/);
  assert.match(engineRoster, /const \[pending, setPending\] = useState<PendingAction \| null>\(null\)/);
  assert.match(engineRoster, /<ConfirmDialog[\s\S]*onConfirm=\{confirmPending\}/);
  assert.doesNotMatch(systemUpdates, /window\.confirm\(/);
  assert.doesNotMatch(engineRoster, /window\.confirm\(/);

  for (const label of [
    "updates.engines.confirmUpdate",
    "updates.engines.reinstallConfirm",
    "updates.engines.confirmReinstall",
    "updates.engines.confirmRevert",
    "updates.omp.updateConfirm",
    "updates.omp.restartConfirm",
    "updates.engines.uninstallBody",
  ]) {
    assert.match(engineRoster, new RegExp(label.replaceAll(".", "\\.")));
  }
});
