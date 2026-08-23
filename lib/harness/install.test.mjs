import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// The SSE route (app/api/engines/install/events) leans on exactly these
// semantics: an engine nobody installed reads as "idle", and subscribing to a
// non-running install returns a live-but-inert unsubscribe rather than
// throwing — the route always subscribes before it snapshots.
test("install progress: unknown engine snapshots as idle", async () => {
  const { getInstallSnapshot } = await jiti.import("./install.ts");
  assert.deepEqual(getInstallSnapshot("never-installed"), { status: "idle", log: "", error: null });
});

test("install progress: subscribing to a non-running install is a safe no-op", async () => {
  const { subscribeInstall } = await jiti.import("./install.ts");
  let called = false;
  const unsubscribe = subscribeInstall("never-installed", () => { called = true; });
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.equal(called, false);
});

test("checkInstallDiskSpace refuses a full filesystem and names it", async () => {
  const { checkInstallDiskSpace } = await jiti.import("./install.ts");
  const GB = 1024 * 1024 * 1024;

  // Room everywhere: never block.
  assert.equal(checkInstallDiskSpace("/tools", "/data/home/.npm", () => ({ availableBytes: 10 * GB })), null);

  // The field failure: the npm CACHE filesystem is the one that is full, while
  // the install prefix looks fine. The message must name the cache path.
  const full = checkInstallDiskSpace("/tools", "/data/home/.npm", (dir) =>
    dir === "/data/home/.npm" ? { availableBytes: 0 } : { availableBytes: 10 * GB });
  assert.match(full ?? "", /npm cache \/data\/home\/\.npm/);
  assert.match(full ?? "", /0 B available/);
  assert.match(full ?? "", /quota/i, "must point at raising the quota, the actual remedy here");

  // A full install prefix is reported against its own path.
  const prefixFull = checkInstallDiskSpace("/tools", "/data/home/.npm", (dir) =>
    dir === "/tools" ? { availableBytes: 1024 } : { availableBytes: 10 * GB });
  assert.match(prefixFull ?? "", /install directory \/tools/);

  // Unreadable space must NOT block an install that would have worked.
  assert.equal(checkInstallDiskSpace("/tools", "/data/home/.npm", () => null), null);
});

test("requiredFreeBytes scales to the installed tree, not a flat floor", async (t) => {
  const { requiredFreeBytes, measureTreeBytes } = await jiti.import("./install.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cody-install-size-"));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));

  // Nothing installed yet: the flat floor applies.
  const floor = requiredFreeBytes(prefix, "@scope/pkg");
  assert.equal(floor, 512 * 1024 * 1024);

  // An installed tree raises the requirement, because npm keeps the old copy
  // alongside the new one while it swaps them — the case that made a 512 MB
  // floor wave omp's ~1.1 GB update straight through.
  const dir = path.join(prefix, "lib", "node_modules", "@scope", "pkg");
  fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
  // Sparse files: apparent size is what sizes the threshold, and this keeps
  // the test instant. Sized like omp's real tree (~1.1 GB), which is the case
  // a flat 512 MB floor would have waved through.
  const big = path.join(dir, "native.node");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 900 * 1024 * 1024);
  const more = path.join(dir, "nested", "more.node");
  fs.writeFileSync(more, "");
  fs.truncateSync(more, 200 * 1024 * 1024);
  assert.equal(measureTreeBytes(dir), 1100 * 1024 * 1024, "walks nested files");

  // Below the floor the floor wins; above it the measured tree does.
  assert.equal(requiredFreeBytes(prefix, "@scope/pkg"), (1100 + 256) * 1024 * 1024);
  assert.ok(requiredFreeBytes(prefix, "@scope/pkg") > 512 * 1024 * 1024,
    "an omp-sized update must demand far more than the first-install floor");

  // A missing tree and a capped walk both fall back rather than guess.
  assert.equal(measureTreeBytes(path.join(prefix, "nope")), null);
  assert.equal(measureTreeBytes(dir, 1), null, "entry cap returns null, not a partial sum");
});

test("cleanStaleInstallDirs removes npm's abandoned rename-aside trees only", async (t) => {
  const { cleanStaleInstallDirs } = await jiti.import("./install.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cody-install-stale-"));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  const scope = path.join(prefix, "lib", "node_modules", "@oh-my-pi");
  fs.mkdirSync(scope, { recursive: true });

  // The exact shape found on the broken instance: an abandoned 17.4.2 tree
  // that made every later install fail with ENOTEMPTY.
  const stale = path.join(scope, ".pi-coding-agent-jMgQTCc1");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "package.json"), "{}");
  // The live install and an unrelated package must survive.
  fs.mkdirSync(path.join(scope, "pi-coding-agent"), { recursive: true });
  fs.mkdirSync(path.join(scope, ".other-package-XYZ"), { recursive: true });

  const removed = cleanStaleInstallDirs(prefix, "@oh-my-pi/pi-coding-agent");
  assert.deepEqual(removed, [stale]);
  assert.equal(fs.existsSync(stale), false, "stale tree deleted");
  assert.equal(fs.existsSync(path.join(scope, "pi-coding-agent")), true, "live install untouched");
  assert.equal(fs.existsSync(path.join(scope, ".other-package-XYZ")), true, "other packages untouched");

  // Idempotent, and safe when the prefix does not exist at all.
  assert.deepEqual(cleanStaleInstallDirs(prefix, "@oh-my-pi/pi-coding-agent"), []);
  assert.deepEqual(cleanStaleInstallDirs(path.join(prefix, "missing"), "@oh-my-pi/pi-coding-agent"), []);
});

// The uninstall path has to use the manager that INSTALLED the engine. npm
// against a uv-installed engine is not a loud failure: it finds nothing to
// remove and exits 0, so the route reported a successful uninstall while the
// engine stayed on disk and kept running. A stub `uv` records what it was
// actually asked to do.
test("a uv-installed engine is uninstalled with uv, not npm", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-uninstall-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const log = join(dir, "invocation.log");
  const stubBin = join(dir, "stub-bin");
  mkdirSync(stubBin, { recursive: true });
  for (const name of ["uv", "npm"]) {
    const file = join(stubBin, name);
    writeFileSync(file, `#!/bin/sh\n{ echo "${name} $*"; echo "UV_TOOL_DIR=$UV_TOOL_DIR"; } >> ${JSON.stringify(log)}\nexit 0\n`);
    chmodSync(file, 0o755);
  }

  const tools = join(dir, "tools");
  mkdirSync(tools, { recursive: true });
  const env = { ...process.env };
  process.env.PATH = `${stubBin}:${process.env.PATH}`;
  process.env.CODY_TOOLS_DIR = tools;
  t.after(() => {
    process.env.PATH = env.PATH;
    if (env.CODY_TOOLS_DIR === undefined) delete process.env.CODY_TOOLS_DIR;
    else process.env.CODY_TOOLS_DIR = env.CODY_TOOLS_DIR;
  });

  const { uninstallEngine } = await jiti.import("./install.ts");
  await uninstallEngine({ id: "hermes", packageName: "hermes-agent", binaryName: "hermes", installVia: "uv" });

  const recorded = readFileSync(log, "utf8");
  assert.match(recorded, /^uv tool uninstall hermes-agent$/m, `uv was not invoked: ${recorded}`);
  assert.ok(!/^npm /m.test(recorded), `npm must not run for a uv engine: ${recorded}`);
  // Without the directory overrides uv looks in its default location and finds
  // nothing to remove — exiting 0 all the same.
  assert.match(recorded, new RegExp(`UV_TOOL_DIR=${tools.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/uv-tools`));
});
