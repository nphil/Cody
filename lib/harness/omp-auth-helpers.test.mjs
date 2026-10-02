import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ompTestPackageBin } from "../omp/omp-test-package.mjs";

/**
 * The credential, reset and unblock helpers run against the INSTALLED omp's
 * AuthStorage, and every other test of them uses a hand-written fixture of
 * that API. omp 18.3.4 renamed the whole surface into namespaces; the
 * fixtures kept passing while every real call failed, and the failure was
 * soft by design — the composer quietly lost the account a conversation is on
 * and gauged the idle sibling at 0%. So each helper is run here against the
 * real package, on an empty store in a throwaway agent dir.
 */

function packageRootOf(bin) {
  let current = fs.realpathSync(bin);
  for (let depth = 0; depth < 8; depth += 1) {
    current = path.dirname(current);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (typeof manifest.name === "string" && manifest.name.includes("pi-coding-agent")) return current;
    } catch {
      // Keep walking.
    }
  }
  return null;
}

function bunBin() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "bun");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const ompBin = ompTestPackageBin();
const packageRoot = ompBin ? packageRootOf(ompBin) : null;
const bun = bunBin();
const skip = (!packageRoot && "no omp package available") || (!bun && "bun is not installed");

let agentDir;
test.before(async () => { if (!skip) agentDir = await mkdtemp(path.join(os.tmpdir(), "cody-omp-auth-")); });
test.after(async () => { if (agentDir) await rm(agentDir, { recursive: true, force: true }); });

function run(helper, request) {
  const result = spawnSync(bun, [path.resolve(process.cwd(), "bin", helper), JSON.stringify({ packageRoot, agentDir, ...request })], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  return JSON.parse(result.stdout);
}

test("the credential helper lists the installed omp's store", { skip }, () => {
  const frame = run("cody-omp-credentials.mjs", { operation: "list" });
  assert.equal(frame.ok, true, frame.message);
  assert.deepEqual(frame.credentials, []);
});

test("the reset-credit helper lists the installed omp's saved resets", { skip }, () => {
  const frame = run("cody-omp-reset-credits.mjs", { operation: "list" });
  assert.equal(frame.ok, true, frame.message);
  assert.deepEqual(frame.accounts, []);
});

test("the unblock helper reads the installed omp's credential blocks", { skip }, () => {
  const frame = run("cody-omp-unblock.mjs", { operation: "unblock", credentialId: 999 });
  assert.equal(frame.ok, true, frame.message);
  assert.equal(frame.outcome, "not_blocked");
});
