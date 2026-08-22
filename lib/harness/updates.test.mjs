import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("isBeyondVerifiedMajor flags only a provable jump past the marker", async () => {
  const { isBeyondVerifiedMajor, majorVersionOf } = await jiti.import("./updates.ts");
  assert.equal(majorVersionOf("18.0.0"), 18);
  assert.equal(majorVersionOf("v19.2.1-rc.1"), 19);
  assert.equal(majorVersionOf("not-a-version"), null);
  assert.equal(majorVersionOf(null), null);
  assert.equal(isBeyondVerifiedMajor("19.0.0", 18), true);
  assert.equal(isBeyondVerifiedMajor("18.4.2", 18), false);
  assert.equal(isBeyondVerifiedMajor("17.4.2", 18), false);
  // Unknown version or unmarked adapter: never warn.
  assert.equal(isBeyondVerifiedMajor(null, 18), false);
  assert.equal(isBeyondVerifiedMajor("garbage", 18), false);
  assert.equal(isBeyondVerifiedMajor("99.0.0", undefined), false);
});

test("packageNameFromSpec strips the version tag, scoped or not", async () => {
  const { packageNameFromSpec } = await jiti.import("./updates.ts");
  assert.equal(packageNameFromSpec("@oh-my-pi/pi-coding-agent@latest"), "@oh-my-pi/pi-coding-agent");
  assert.equal(packageNameFromSpec("@openai/codex@latest"), "@openai/codex");
  assert.equal(packageNameFromSpec("some-package@1.2.3"), "some-package");
  assert.equal(packageNameFromSpec("bare-package"), "bare-package");
  assert.equal(packageNameFromSpec("@scope/untagged"), "@scope/untagged");
});
