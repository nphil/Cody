import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createReconcileGuard } = await jiti.import("./reconcile-guard.ts");

test("reconcile guard coalesces triggers while one request is active", () => {
  const guard = createReconcileGuard();
  const first = guard.tryAcquire();

  assert.equal(typeof first, "number");
  assert.equal(guard.tryAcquire(), null);
  assert.equal(guard.release(first), true);

  const second = guard.tryAcquire();
  assert.equal(typeof second, "number");
  assert.notEqual(second, first);
  assert.equal(guard.release(second), false);
});

test("reset makes an old request unable to release a newer generation", () => {
  const guard = createReconcileGuard();
  const oldToken = guard.tryAcquire();
  assert.equal(typeof oldToken, "number");

  guard.reset();
  const newToken = guard.tryAcquire();
  assert.equal(typeof newToken, "number");
  assert.equal(guard.release(oldToken), false);
  assert.equal(guard.release(newToken), false);
});

test("a stalled reconciliation is released after the configured timeout", async () => {
  const guard = createReconcileGuard({ timeoutMs: 20 });
  assert.equal(typeof guard.tryAcquire(), "number");

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(typeof guard.tryAcquire(), "number");
});
