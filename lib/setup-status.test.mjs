import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Readiness is what decides whether Cody tells a new user their instance is
 * incomplete, so the cases that matter are the ones where an unread fact
 * could be mistaken for a missing one — that mistake tells a working install
 * it is broken, and its mirror image (judging too eagerly) is what let a
 * fresh install reach the chat with no engine at all.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { deriveReadiness, isSetupComplete, missingRequirements } = await jiti.import("./setup-status.ts");

const ENGINE_READY = { engines: [{ id: "omp", installed: true }], active: "omp" };

test("an engine that is active but not installed is not ready", () => {
  // The live defect: the picker marked OMP "Active engine" while its status
  // read "Not installed", and onboarding let you leave on that state.
  const readiness = deriveReadiness({ engines: { engines: [{ id: "omp", installed: false }], active: "omp" }, providers: null });
  assert.equal(readiness.engine, false);
  assert.equal(readiness.pending, false);
  assert.deepEqual(missingRequirements(readiness), ["engine", "provider", "models"]);
});

test("an unread fact is pending, never reported as missing", () => {
  const noEngines = deriveReadiness({ engines: null, providers: null });
  assert.equal(noEngines.pending, true);
  assert.deepEqual(missingRequirements(noEngines), []);
  assert.equal(isSetupComplete(noEngines), false);

  const noProviders = deriveReadiness({ engines: ENGINE_READY, providers: null });
  assert.equal(noProviders.pending, true);
  assert.deepEqual(missingRequirements(noProviders), []);
});

test("a pending provider response is unread, not zero models", () => {
  const readiness = deriveReadiness({
    engines: ENGINE_READY,
    providers: { providers: [{ connected: true, modelCount: 0 }], pending: true },
  });
  assert.equal(readiness.provider, false);
  assert.equal(readiness.pending, true);
  assert.deepEqual(missingRequirements(readiness), []);
});

test("a cold cached provider response is pending even when it has partial rows", () => {
  const readiness = deriveReadiness({
    engines: ENGINE_READY,
    providers: { providers: [], pending: true },
  });
  assert.equal(readiness.pending, true);
  assert.deepEqual(missingRequirements(readiness), []);
});

test("an empty provider list under a working engine is a real answer", () => {
  const readiness = deriveReadiness({ engines: ENGINE_READY, providers: { providers: [] } });
  assert.equal(readiness.pending, false);
  assert.deepEqual(missingRequirements(readiness), ["provider", "models"]);
});

test("connected with a counted catalog is complete", () => {
  const readiness = deriveReadiness({
    engines: ENGINE_READY,
    providers: { providers: [{ connected: true, modelCount: 12 }] },
  });
  assert.equal(isSetupComplete(readiness), true);
  assert.deepEqual(missingRequirements(readiness), []);
});

test("requirements come back nearest-dependency first", () => {
  const readiness = deriveReadiness({
    engines: ENGINE_READY,
    providers: { providers: [{ connected: false, modelCount: 0 }] },
  });
  assert.deepEqual(missingRequirements(readiness), ["provider", "models"]);
});
