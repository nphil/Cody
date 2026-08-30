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

  // An engine that installs as SEVERAL packages (an ACP adapter beside the CLI
  // it drives) writes all of them into the same prefix in one run, so the
  // requirement is their sum. Sizing it from the first package alone would
  // wave through exactly the update that fills the disk.
  const second = path.join(prefix, "lib", "node_modules", "@scope", "other");
  fs.mkdirSync(second, { recursive: true });
  const secondFile = path.join(second, "native.node");
  fs.writeFileSync(secondFile, "");
  fs.truncateSync(secondFile, 300 * 1024 * 1024);
  assert.equal(
    requiredFreeBytes(prefix, ["@scope/pkg", "@scope/other"]),
    (1100 + 300 + 256) * 1024 * 1024,
  );
  // An unmeasurable member does not poison the total; it just makes it a floor.
  assert.equal(
    requiredFreeBytes(prefix, ["@scope/pkg", "@scope/never-installed"]),
    (1100 + 256) * 1024 * 1024,
  );
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

// An engine split across two packages is only updated when BOTH are, and the
// flags are per-package: the adapter is installed without its bundled ~300 MB
// CLI copy, while the CLI beside it needs precisely that platform binary.
// Every install IS the update path, so a step list that dropped `installAlso`
// on a re-run would leave the companion frozen at whatever version first
// installed it.
test("installSteps installs the companion package on every run, with per-package flags", async () => {
  const { installSteps } = await jiti.import("./install.ts");

  const split = installSteps({
    id: "claude",
    installSpec: "@agentclientprotocol/claude-agent-acp@latest",
    binaryName: "claude-agent-acp",
    installAlso: ["@anthropic-ai/claude-code@latest"],
    skipNativeOptional: true,
  });
  assert.deepEqual(split, [
    { spec: "@agentclientprotocol/claude-agent-acp@latest", skipNativeOptional: true },
    { spec: "@anthropic-ai/claude-code@latest" },
  ]);

  // A revert pins both halves; the step list has to carry the pins through.
  const pinned = installSteps({
    id: "claude",
    installSpec: "@agentclientprotocol/claude-agent-acp@0.70.0",
    binaryName: "claude-agent-acp",
    installAlso: ["@anthropic-ai/claude-code@2.1.238"],
    skipNativeOptional: true,
  });
  assert.deepEqual(pinned.map((step) => step.spec), [
    "@agentclientprotocol/claude-agent-acp@0.70.0",
    "@anthropic-ai/claude-code@2.1.238",
  ]);

  // One package, one step — and uv has no companion mechanism at all.
  assert.deepEqual(
    installSteps({ id: "omp", installSpec: "@oh-my-pi/pi-coding-agent@latest", binaryName: "omp" }),
    [{ spec: "@oh-my-pi/pi-coding-agent@latest", skipNativeOptional: undefined }],
  );
  assert.deepEqual(
    installSteps({ id: "hermes", installSpec: "hermes-agent[acp]", binaryName: "hermes", installVia: "uv", installAlso: ["ignored"] }),
    [{ spec: "hermes-agent[acp]", skipNativeOptional: undefined }],
  );
});

// The revert pin for a split engine is looked up by package name against
// `installAlso`. A `engineCli.packageName` that names nothing in that list is
// a silent no-op: the adapter goes back and the CLI installs `@latest`, which
// is the half most likely to have caused the breakage being reverted.
test("every engine's CLI half names a package the install actually installs", async () => {
  const { listHarnesses } = await jiti.import("./index.ts");
  const { packageNameFromSpec } = await jiti.import("./install.ts");
  for (const adapter of listHarnesses()) {
    if (!adapter.engineCli) continue;
    const alsoNames = (adapter.installAlso ?? []).map(packageNameFromSpec);
    assert.ok(
      alsoNames.includes(adapter.engineCli.packageName),
      `${adapter.id}: engineCli.packageName ${adapter.engineCli.packageName} is not among installAlso [${alsoNames.join(", ")}]`,
    );
    // Two labels, because two versions are shown side by side and an
    // unlabelled pair is the confusion this exists to remove.
    assert.notEqual(adapter.engineCli.label, adapter.engineCli.adapterLabel, `${adapter.id}: the two halves need distinct labels`);
    // `verifiedVersion` belongs to the package installSpec names, so a split
    // engine that sets it must also carry the label the notice will use.
    if (adapter.verifiedVersion !== undefined) {
      assert.ok(adapter.engineCli.adapterLabel.length > 0, `${adapter.id}: the compat notice has nothing to name`);
    }
  }
});

// The revert record is a PAIR for a split engine. Records written before the
// second half existed must still read back — a missing partner is "none
// recorded", never a resurrected version from an older install.
test("install history round-trips both halves and tolerates older records", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cody-install-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previousTools = process.env.CODY_TOOLS_DIR;
  process.env.CODY_TOOLS_DIR = dir;
  t.after(() => {
    if (previousTools === undefined) delete process.env.CODY_TOOLS_DIR;
    else process.env.CODY_TOOLS_DIR = previousTools;
  });

  const { readInstallHistory } = await jiti.import("./install.ts");
  writeFileSync(join(dir, "install-history.json"), JSON.stringify({
    claude: { previousVersion: "0.70.0", previousEngineVersion: "2.1.238", updatedAt: "2026-01-01T00:00:00.000Z" },
    // Written before the CLI half was recorded at all.
    codex: { previousVersion: "1.6.2", updatedAt: "2025-01-01T00:00:00.000Z" },
    // The pre-normalization omp shape, which stored "omp/17.3.5".
    omp: { previousVersion: "omp/17.3.5", updatedAt: "2025-01-01T00:00:00.000Z" },
  }));

  const history = readInstallHistory();
  assert.deepEqual(history.claude, { previousVersion: "0.70.0", previousEngineVersion: "2.1.238", updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(history.codex.previousEngineVersion, null);
  assert.equal(history.omp.previousVersion, "17.3.5");
  assert.equal(history.omp.previousEngineVersion, null);
});

// Everything that labels a number with the ENGINE's name goes through this:
// the picker card, the engine list in User Accounts, the Info panel. Reporting
// the ACP adapter's version there is not a smaller truth, it is a different
// package's version.
test("engineOwnVersion reports the engine's version, falling back to the package's", async () => {
  const { engineOwnVersion } = await jiti.import("./index.ts");

  const split = {
    getVersion: async () => "0.70.0",
    engineCli: { adapterLabel: "a", label: "b", packageName: "p", getVersion: async () => "2.1.241" },
  };
  assert.equal(await engineOwnVersion(split), "2.1.241");

  // The half-failed install: the adapter answers, the CLI it drives does not.
  // A half that answers beats showing nothing at all.
  assert.equal(
    await engineOwnVersion({ ...split, engineCli: { ...split.engineCli, getVersion: async () => null } }),
    "0.70.0",
  );

  // One package: the engine's version IS the package's.
  assert.equal(await engineOwnVersion({ getVersion: async () => "18.0.1" }), "18.0.1");
  assert.equal(await engineOwnVersion({ getVersion: async () => null }), null);
});
