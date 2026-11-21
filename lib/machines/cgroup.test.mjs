import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * This server's own container, read from control-group files. Fixtures stand
 * in for /sys/fs/cgroup: a v2 tree, a v1 tree (both directory spellings of the
 * cpu controller), and a machine with neither. The lines must parse with the
 * same parser the ssh loop's output goes through.
 */
const jiti = createJiti(import.meta.url);
const { readOwnLines } = await jiti.import("./cgroup.ts");
const proc = await jiti.import("./proc.ts");

const base = mkdtempSync(join(tmpdir(), "cody-cgroup-"));
after(() => rmSync(base, { recursive: true, force: true }));

function tree(name, files) {
  const root = join(base, name);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), body);
  }
  return root;
}

test("a cgroup v2 tree is read the way the ssh loop prints it", async () => {
  const root = tree("v2", {
    "cpu.stat": "usage_usec 5260371313\nuser_usec 1\nsystem_usec 2\n",
    "memory.current": "14581338112\n",
    "memory.max": "25769803776\n",
    "cpu.max": "max 100000\n",
    "memory.stat": "anon 14858350592\nfile 1591902208\ninactive_file 784424960\n",
  });
  const lines = await readOwnLines({ root, uptimeSeconds: 4100.04, cpus: 16 });
  assert.ok(lines.includes("cg2 usage_usec 5260371313"));
  assert.ok(lines.includes("cg2 inactive_file 784424960"));
  assert.equal(lines.some((line) => line.includes("user_usec")), false, "only the names asked for");
  assert.deepEqual(proc.parseOwn(lines, null), {
    cpuUsec: 5260371313, clockMs: 4100040, cores: 16, memUsedBytes: 14581338112 - 784424960, memLimitBytes: 25769803776,
  });
});

test("a v2 tree without memory.max or memory.stat still reads (the root group has neither)", async () => {
  const root = tree("v2-root", { "cpu.stat": "usage_usec 10\n", "memory.current": "1000\n" });
  const own = proc.parseOwn(await readOwnLines({ root, uptimeSeconds: 1, cpus: 4 }), null);
  assert.deepEqual(own, { cpuUsec: 10, clockMs: 1000, cores: 4, memUsedBytes: 1000, memLimitBytes: null });
});

test("a cgroup v1 tree, in either directory spelling", async () => {
  for (const cpuDir of ["cpuacct", "cpu,cpuacct"]) {
    const root = tree(`v1-${cpuDir}`, {
      [`${cpuDir}/cpuacct.usage`]: "4000000000\n",
      [`${cpuDir}/cpu.cfs_quota_us`]: "200000\n",
      [`${cpuDir}/cpu.cfs_period_us`]: "100000\n",
      "memory/memory.usage_in_bytes": "2000000000\n",
      "memory/memory.limit_in_bytes": "4294967296\n",
      "memory/memory.stat": "cache 1\ntotal_inactive_file 500000000\n",
    });
    const own = proc.parseOwn(await readOwnLines({ root, uptimeSeconds: 5, cpus: 8 }), null);
    assert.deepEqual(own, { cpuUsec: 4000000, clockMs: 5000, cores: 2, memUsedBytes: 1500000000, memLimitBytes: 4294967296 }, cpuDir);
  }
});

test("no cgroup files at all means no lines, so the bar falls back to the whole machine", async () => {
  assert.deepEqual(await readOwnLines({ root: join(base, "nothing-here"), uptimeSeconds: 1, cpus: 2 }), []);
  assert.equal(proc.parseOwn([], 2), null);
  // Half a tree (a stat file but no memory file) is no tree.
  const half = tree("half", { "cpu.stat": "usage_usec 1\n" });
  assert.deepEqual(await readOwnLines({ root: half, uptimeSeconds: 1, cpus: 2 }), []);
});
