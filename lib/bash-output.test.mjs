import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

async function loadSubject() {
  return import("./bash-output.ts");
}

test("accepts only pi bash logs directly inside the configured temp directory", async () => {
  const { resolveBashOutputPath } = await loadSubject();
  const tempRoot = join(tmpdir(), "cody-output-tests");
  const expected = resolve(tempRoot, "pi-bash-ab12.log");

  assert.equal(resolveBashOutputPath(join(tempRoot, "pi-bash-ab12.log"), tempRoot), expected);
  assert.equal(resolveBashOutputPath(join(tempRoot, "..", "pi-bash-ab12.log"), tempRoot), null);
  assert.equal(resolveBashOutputPath(join(tempRoot, "pi-bash-ab12.log.bak"), tempRoot), null);
  assert.equal(resolveBashOutputPath(join(`${tempRoot}-other`, "pi-bash-ab12.log"), tempRoot), null);
});

test("also accepts a log directly inside one chat's scratch dir, never deeper, looser or through a link", async (t) => {
  const { resolveBashOutputPath } = await loadSubject();
  const base = await mkdtemp(join(tmpdir(), "cody-bash-scratch-"));
  const tempRoot = join(base, "tmp");
  const scratchRoot = join(tempRoot, "cs");
  const chatDir = join(scratchRoot, "0123456789ab");
  const log = join(chatDir, "pi-bash-ab12.log");
  try {
    await mkdir(join(chatDir, "deeper"), { recursive: true });
    await mkdir(join(scratchRoot, "not-a-chat-dir"));
    await mkdir(join(scratchRoot, "0123456789AB"));
    await mkdir(join(base, "elsewhere", "0123456789ab"), { recursive: true });

    assert.equal(resolveBashOutputPath(log, tempRoot, scratchRoot), resolve(log));
    assert.equal(resolveBashOutputPath(log, tempRoot), null, "without a scratch root only the temp dir counts");
    assert.equal(resolveBashOutputPath(join(chatDir, "deeper", "pi-bash-ab12.log"), tempRoot, scratchRoot), null, "nothing deeper");
    assert.equal(resolveBashOutputPath(join(scratchRoot, "pi-bash-ab12.log"), tempRoot, scratchRoot), null, "not the root itself");
    assert.equal(resolveBashOutputPath(join(scratchRoot, "not-a-chat-dir", "pi-bash-ab12.log"), tempRoot, scratchRoot), null, "only a dir named like a chat's");
    assert.equal(resolveBashOutputPath(join(scratchRoot, "0123456789AB", "pi-bash-ab12.log"), tempRoot, scratchRoot), null, "lowercase hex only");
    assert.equal(resolveBashOutputPath(join(base, "elsewhere", "0123456789ab", "pi-bash-ab12.log"), tempRoot, scratchRoot), null, "only under the scratch root");
    assert.equal(resolveBashOutputPath(join(chatDir, "other.log"), tempRoot, scratchRoot), null, "still only pi bash logs");
    assert.equal(resolveBashOutputPath(join(chatDir, "..", "0123456789ab", "pi-bash-ab12.log"), tempRoot, scratchRoot), resolve(log), "a path that only wanders is the same file");

    try {
      await symlink(join(base, "elsewhere"), join(scratchRoot, "fedcba987654"));
    } catch (error) {
      if (error?.code === "EPERM") return t.skip("Creating symbolic links requires additional privileges on this platform");
      throw error;
    }
    assert.equal(resolveBashOutputPath(join(scratchRoot, "fedcba987654", "pi-bash-ab12.log"), tempRoot, scratchRoot), null, "a link in place of the chat's dir leads nowhere");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the name pattern agrees with the dirs lib/disk/scratch.ts really makes", async () => {
  const { resolveBashOutputPath } = await loadSubject();
  const base = await mkdtemp(join(tmpdir(), "cody-bash-real-scratch-"));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, temp: process.env.TMPDIR, root: process.env.CODY_SCRATCH_ROOT };
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  process.env.TMPDIR = join(base, "tmp");
  delete process.env.CODY_SCRATCH_ROOT;
  try {
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const scratch = await jiti.import("./disk/scratch.ts");
    const chatDir = scratch.ensureSessionScratch("bash-output-chat");
    const log = join(chatDir, "pi-bash-ab12.log");
    assert.equal(resolveBashOutputPath(log, tmpdir(), scratch.scratchRoot()), resolve(log));
  } finally {
    for (const [name, value] of [["PI_CODING_AGENT_DIR", previous.agent], ["TMPDIR", previous.temp], ["CODY_SCRATCH_ROOT", previous.root]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(base, { recursive: true, force: true });
  }
});

test("reads small output and rejects oversized inline output before buffering it", async () => {
  const { readUtf8FileWithinLimit } = await loadSubject();
  const dir = await mkdtemp(join(tmpdir(), "cody-bash-output-"));
  const filePath = join(dir, "pi-bash-ab12.log");
  try {
    await writeFile(filePath, "shell output", "utf8");

    assert.deepEqual(await readUtf8FileWithinLimit(filePath, 32), {
      tooLarge: false,
      content: "shell output",
      size: 12,
    });
    assert.deepEqual(await readUtf8FileWithinLimit(filePath, 4), {
      tooLarge: true,
      size: 12,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects symbolic links when opening bash output", async (t) => {
  const { readUtf8FileWithinLimit } = await loadSubject();
  const dir = await mkdtemp(join(tmpdir(), "cody-bash-output-link-"));
  const targetPath = join(dir, "target.log");
  const linkPath = join(dir, "pi-bash-link.log");
  try {
    await writeFile(targetPath, "not authorized through a link", "utf8");
    try {
      await symlink(targetPath, linkPath);
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("Creating symbolic links requires additional privileges on this platform");
        return;
      }
      throw error;
    }
    await assert.rejects(() => readUtf8FileWithinLimit(linkPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
