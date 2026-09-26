import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

/**
 * The one symlink dance every isolated omp child shares: sidebar chat, the
 * web-research planner, Distill and the session namer. An explicitly empty
 * `mcp.json`, and symlinks — never copies — for whatever the real agent dir
 * actually has; a target that does not exist yet is skipped, never linked
 * dangling.
 */
const realAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-real-agent-"));
process.env.PI_CODING_AGENT_DIR = realAgentDir;
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
process.on("exit", () => {
  fs.rmSync(realAgentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const iso = await jiti.import("./isolated-agent-dir.ts");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("mcp.json is written explicitly empty", () => {
  const target = tempDir("cody-iso-mcp-");
  iso.linkIsolatedAgentDir(target, []);
  assert.equal(fs.readFileSync(path.join(target, "mcp.json"), "utf8"), '{"mcpServers":{}}\n');
});

test("a target the real agent dir does not have is skipped, never linked dangling", () => {
  const target = tempDir("cody-iso-missing-");
  iso.linkIsolatedAgentDir(target, ["no-such-file.yml"]);
  assert.equal(fs.existsSync(path.join(target, "no-such-file.yml")), false);
  // The rest of the contract still happened even though this one file had
  // nothing to link.
  assert.equal(fs.existsSync(path.join(target, "mcp.json")), true);
});

test("an existing target is symlinked, never copied", () => {
  fs.writeFileSync(path.join(realAgentDir, "models.yml"), "models: []\n");
  const target = tempDir("cody-iso-link-");
  iso.linkIsolatedAgentDir(target, ["models.yml"]);
  const link = path.join(target, "models.yml");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), path.join(realAgentDir, "models.yml"));
  // A write to the REAL file is visible through the link: proof this is a
  // live symlink, not a snapshot an OAuth refresh would never reach.
  fs.writeFileSync(path.join(realAgentDir, "models.yml"), "models: [changed]\n");
  assert.equal(fs.readFileSync(link, "utf8"), "models: [changed]\n");
});

test("a directory target (blobs) is symlinked too", () => {
  fs.mkdirSync(path.join(realAgentDir, "blobs"), { recursive: true });
  fs.writeFileSync(path.join(realAgentDir, "blobs", "one.bin"), "x");
  const target = tempDir("cody-iso-blobs-");
  iso.linkIsolatedAgentDir(target, ["blobs"]);
  assert.equal(fs.readFileSync(path.join(target, "blobs", "one.bin"), "utf8"), "x");
});

test("a stale symlink pointing somewhere else is replaced, not left dangling", () => {
  const target = tempDir("cody-iso-stale-");
  const elsewhere = tempDir("cody-iso-elsewhere-");
  fs.writeFileSync(path.join(elsewhere, "config.yml"), "old\n");
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(path.join(elsewhere, "config.yml"), path.join(target, "config.yml"));
  fs.writeFileSync(path.join(realAgentDir, "config.yml"), "new\n");

  iso.linkIsolatedAgentDir(target, ["config.yml"]);
  assert.equal(fs.readlinkSync(path.join(target, "config.yml")), path.join(realAgentDir, "config.yml"));
  assert.equal(fs.readFileSync(path.join(target, "config.yml"), "utf8"), "new\n");
});

test("an already-correct link is left alone, not recreated, on a second call", () => {
  fs.writeFileSync(path.join(realAgentDir, "agent.db"), "db\n");
  const target = tempDir("cody-iso-idempotent-");
  iso.linkIsolatedAgentDir(target, ["agent.db"]);
  const link = path.join(target, "agent.db");
  const before = fs.lstatSync(link).ino;
  iso.linkIsolatedAgentDir(target, ["agent.db"]);
  assert.equal(fs.lstatSync(link).ino, before);
});

test("mcp.json already correct is not rewritten", () => {
  const target = tempDir("cody-iso-mcp-idempotent-");
  iso.linkIsolatedAgentDir(target, []);
  const mcpPath = path.join(target, "mcp.json");
  const before = fs.statSync(mcpPath).mtimeMs;
  iso.linkIsolatedAgentDir(target, []);
  assert.equal(fs.statSync(mcpPath).mtimeMs, before);
});

test("getOneShotAgentDir reuses one directory under the agent dir across calls", () => {
  fs.writeFileSync(path.join(realAgentDir, "config.yml"), "real\n");
  const first = iso.getOneShotAgentDir();
  assert.equal(path.dirname(first), realAgentDir, "kept under Cody's own agent dir, never a user workspace");
  assert.equal(fs.existsSync(path.join(first, "mcp.json")), true);
  assert.equal(fs.readlinkSync(path.join(first, "config.yml")), path.join(realAgentDir, "config.yml"));
  const second = iso.getOneShotAgentDir();
  assert.equal(second, first, "the same directory is reused, not recreated, per process");
});

test("the default linked-file set covers agent.db, models.yml, config.yml and blobs", () => {
  for (const name of ["agent.db", "models.yml", "config.yml"]) {
    fs.writeFileSync(path.join(realAgentDir, name), name);
  }
  fs.mkdirSync(path.join(realAgentDir, "blobs"), { recursive: true });
  const target = tempDir("cody-iso-defaults-");
  iso.linkIsolatedAgentDir(target);
  for (const name of ["agent.db", "models.yml", "config.yml", "blobs"]) {
    assert.equal(fs.existsSync(path.join(target, name)), true, `${name} is linked by default`);
  }
});
