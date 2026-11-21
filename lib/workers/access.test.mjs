import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createJiti } from "jiti";

process.env.CODY_INTERNAL_DISPLAY_SECRET = randomBytes(32).toString("base64url");
process.env.CODY_INTERNAL_DISPLAY_ORIGIN = "http://127.0.0.1:30178";

const jiti = createJiti(import.meta.url);
const { workersEnv, scratchKeyOf, SCRATCH_SESSION_PREFIX } = await jiti.import("./access.ts");
const { verifyDisplayCapability } = await jiti.import("../display/capability.ts");

/**
 * What an omp engine is handed so its agents (helpers too) can call
 * /api/internal/workers: a capability that names the chat's scratch folder.
 */

test("an engine in a scratch folder gets the endpoint, its identity and a token the route accepts", () => {
  const env = workersEnv("/tmp/cody-scratch/abcdef012345");
  assert.deepEqual(Object.keys(env).sort(), ["CODY_WORKERS_ENDPOINT", "CODY_WORKERS_SESSION", "CODY_WORKERS_TOKEN"]);
  assert.equal(env.CODY_WORKERS_ENDPOINT, "http://127.0.0.1:30178/api/internal/workers");
  assert.equal(env.CODY_WORKERS_SESSION, `${SCRATCH_SESSION_PREFIX}abcdef012345`);
  const capability = verifyDisplayCapability(env.CODY_WORKERS_TOKEN);
  assert.equal(capability?.sid, env.CODY_WORKERS_SESSION);
  assert.equal(scratchKeyOf(capability.sid), "abcdef012345");
  assert.ok(capability.exp - Date.now() > 30 * 24 * 60 * 60 * 1000, "outlives any engine process");
});

test("only a scratch folder named like Cody's own makes an identity, and only a scratch capability names one", () => {
  assert.deepEqual(workersEnv("/tmp/cody-scratch/not-hex"), {});
  assert.deepEqual(workersEnv("/tmp/cody-scratch/abc"), {}, "too short to be one");
  assert.equal(scratchKeyOf("chat-alice"), null, "an ordinary session id");
  assert.equal(scratchKeyOf("scratch:"), null);
  assert.equal(scratchKeyOf("scratch:../../etc"), null);
  assert.equal(scratchKeyOf("scratch:ABCDEF012345"), null);
  assert.equal(scratchKeyOf("scratch:abcdef012345"), "abcdef012345");
});

test("outside the running server there is nothing to hand out", () => {
  const secret = process.env.CODY_INTERNAL_DISPLAY_SECRET;
  delete process.env.CODY_INTERNAL_DISPLAY_SECRET;
  try {
    assert.deepEqual(workersEnv("/tmp/cody-scratch/abcdef012345"), {});
  } finally {
    process.env.CODY_INTERNAL_DISPLAY_SECRET = secret;
  }
  const origin = process.env.CODY_INTERNAL_DISPLAY_ORIGIN;
  delete process.env.CODY_INTERNAL_DISPLAY_ORIGIN;
  try {
    assert.deepEqual(workersEnv("/tmp/cody-scratch/abcdef012345"), {});
  } finally {
    process.env.CODY_INTERNAL_DISPLAY_ORIGIN = origin;
  }
});
