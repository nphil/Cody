import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("packageNameFromSpec strips the version tag, scoped or not", async () => {
  const { packageNameFromSpec } = await jiti.import("./updates.ts");
  assert.equal(packageNameFromSpec("@oh-my-pi/pi-coding-agent@latest"), "@oh-my-pi/pi-coding-agent");
  assert.equal(packageNameFromSpec("@openai/codex@latest"), "@openai/codex");
  assert.equal(packageNameFromSpec("some-package@1.2.3"), "some-package");
  assert.equal(packageNameFromSpec("bare-package"), "bare-package");
  assert.equal(packageNameFromSpec("@scope/untagged"), "@scope/untagged");
});
