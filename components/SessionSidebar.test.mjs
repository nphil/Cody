import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("resets the commanded cwd sentinel when the prop is withdrawn", async () => {
  const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const lastSyncedCwdPropRef = useRef<string | null>(null);");
  const end = source.indexOf("  }, [selectedCwdProp, projectRootFor, expandProject]);", start);

  assert.notEqual(start, -1, "cwd sync sentinel should remain explicit");
  assert.notEqual(end, -1, "cwd sync effect should remain explicit");

  const syncEffect = source.slice(start, end);
  const withdrawal = syncEffect.indexOf("if (!selectedCwdProp)");
  const comparison = syncEffect.indexOf("if (selectedCwdProp !== lastSyncedCwdPropRef.current)");

  assert.ok(withdrawal >= 0, "withdrawn cwd commands must reset the sentinel");
  assert.ok(comparison > withdrawal, "the withdrawal guard must run before deduplication");
  assert.match(syncEffect, /lastSyncedCwdPropRef\.current = null;\s+return;/);
  assert.match(syncEffect, /lastSyncedCwdPropRef\.current = selectedCwdProp;/);
});
