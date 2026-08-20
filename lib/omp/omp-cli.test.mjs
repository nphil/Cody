import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { stripVersionPrefix } = jiti("./omp-cli.ts");
const { isNewerVersion } = jiti("../npm-update.ts");

test("normalizes omp --version output to bare semver", () => {
  assert.equal(stripVersionPrefix("omp/17.3.7"), "17.3.7");
  assert.equal(stripVersionPrefix("17.3.7"), "17.3.7");
  assert.equal(stripVersionPrefix("omp/17.3.8-rc.1"), "17.3.8-rc.1");
  assert.equal(stripVersionPrefix("  omp/17.3.7\n"), "17.3.7");
  assert.equal(stripVersionPrefix(""), "");
  assert.equal(stripVersionPrefix("not a version"), "not a version");
});

test("normalized version compares as semver against the registry", () => {
  // The prefixed form fails parseVersion, which silently reported "no update
  // available" for omp in Settings while the toast said otherwise.
  assert.equal(isNewerVersion("17.3.8", "omp/17.3.7"), false);
  assert.equal(isNewerVersion("17.3.8", stripVersionPrefix("omp/17.3.7")), true);
  assert.equal(isNewerVersion("17.3.7", stripVersionPrefix("omp/17.3.7")), false);
});
