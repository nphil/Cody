// The env.sh that docker/worker/cody-worker writes for jobs: rendered here by running its heredoc, then sourced.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(process.env.CODY_SCRATCH || tmpdir(), "entrypoint-env-"));
after(() => rmSync(base, { recursive: true, force: true }));

const script = readFileSync(new URL("../../docker/worker/cody-worker", import.meta.url), "utf8");
const heredoc = script.slice(script.indexOf('cat >"$W/env.sh.new" <<EOF'), script.indexOf("\nEOF\n") + 5);
assert.ok(heredoc.includes("npm_config_nodedir"), "found the env.sh heredoc");

function envSh() {
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  const r = spawnSync("sh", ["-c", `W=${work} VIEW=${work}/root/data OWN=.npm TZ=UTC NODE_ENV=production; ${heredoc}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return join(work, "env.sh.new");
}

/** Source env.sh (unmapped: its PATH starts with the server's `~/.local/bin` as shown in the view) and print npm_config_nodedir. */
function nodedir(file, preset = "") {
  const r = spawnSync("sh", ["-c", `${preset ? `npm_config_nodedir=${preset}; export npm_config_nodedir; ` : ""}. ${file}; echo "[$npm_config_nodedir]"`], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: base },
  });
  return r.stdout.trim().split("\n").pop();
}

/** A node (and maybe its headers) at the prefix `~/.local` of the view, where env.sh's PATH looks first. */
function fakeNode(withHeaders) {
  const prefix = join(base, "work", "root", "data", "home", ".local");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(prefix, "bin", "node"), 0o755);
  if (withHeaders) {
    mkdirSync(join(prefix, "include", "node"), { recursive: true });
    writeFileSync(join(prefix, "include", "node", "node.h"), "");
  }
  return prefix;
}

test("the generated env.sh has no syntax error and hands node-gyp the headers beside the node on PATH", () => {
  const file = envSh();
  assert.equal(spawnSync("sh", ["-n", file]).status, 0);
  const prefix = fakeNode(true);
  assert.equal(nodedir(file), `[${prefix}]`);
});

test("without headers beside the node, or with nodedir already set, it leaves npm_config_nodedir alone", () => {
  const file = envSh();
  fakeNode(false);
  assert.equal(nodedir(file), "[]");
  fakeNode(true);
  assert.equal(nodedir(file, "/mine"), "[/mine]");
});
