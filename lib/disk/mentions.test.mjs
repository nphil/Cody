import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { fakeProcess } from "./fake-proc.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PathMentions, isPlainName, scanProcessUsage } = await jiti.import("./mentions.ts");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mentions-test-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const TMP = "/var/fake-tmp";
const HOME_TMP = "/home/someone/tmp";
const roots = [{ path: TMP }, { path: HOME_TMP, spellings: ["~/tmp", "$HOME/tmp"] }];

test("text names a path and every folder above it, the way people and tools write it", () => {
  const mentions = new PathMentions(roots);
  mentions.addText(`cd ${TMP}/venv-a/bin && ./python; the log is in ${TMP}/notes.`);
  mentions.addText(`{"text":"${TMP}/json-first\\n${TMP}/json-second"}`);

  assert.equal(mentions.has(`${TMP}/venv-a`), true, "a folder above the named file");
  assert.equal(mentions.has(`${TMP}/venv-a/bin`), true);
  assert.equal(mentions.has(`${TMP}/notes`), true, "the sentence's full stop is not part of the name");
  assert.equal(mentions.has(`${TMP}/json-first`), true, "paths separated by a JSON-escaped newline");
  assert.equal(mentions.has(`${TMP}/json-second`), true);
  assert.equal(mentions.has(`${TMP}/never-written`), false);
});

test("a longer name that merely starts like a shorter one does not mention it", () => {
  const mentions = new PathMentions(roots);
  mentions.addText(`${TMP}/build-final/out.bin`);
  assert.equal(mentions.has(`${TMP}/build`), false);
  assert.equal(mentions.has(`${TMP}/build-final`), true);
});

test("the home temp dir is found however it is spelled", () => {
  const mentions = new PathMentions(roots);
  mentions.addText("run ~/tmp/helper.sh then $HOME/tmp/receipts/a.json");
  assert.equal(mentions.has(`${HOME_TMP}/helper.sh`), true);
  assert.equal(mentions.has(`${HOME_TMP}/receipts`), true);
  assert.equal(mentions.has(`${TMP}/helper.sh`), false, "the other root is a different directory");
});

test("a name text cannot give back is searched for whole", () => {
  assert.equal(isPlainName("rustsettings-ab12"), true);
  assert.equal(isPlainName("My Build (1)"), false);
  const odd = `${TMP}/My Build (1)`;
  const mentions = new PathMentions(roots, [odd, `${TMP}/Other Build (2)`]);
  mentions.addText(`cd '${odd}' && make`);
  assert.equal(mentions.has(odd), true);
  assert.equal(mentions.has(`${TMP}/Other Build (2)`), false);
});

/** A fake process table: `procs` maps a pid to what that process holds. */
function fakeProc(name, procs, sockets = []) {
  const proc = path.join(base, name);
  fs.mkdirSync(path.join(proc, "not-a-pid"), { recursive: true });
  for (const [pid, held] of Object.entries(procs)) fakeProcess(proc, pid, held, sockets);
  return proc;
}

test("every way a process can hold a temp path is noticed", async () => {
  const self = 4242;
  const proc = fakeProc("proc-all", {
    [self]: { cwd: "/" },
    100: { cwd: `${TMP}/by-cwd/sub` },
    101: { exe: `${TMP}/by-exe/tool` },
    102: { fds: [`${TMP}/by-open-file.log`, "socket:[123]"] },
    103: { cmdline: ["python", `${TMP}/by-argv/bin/pytest`] },
    104: { environ: ["PATH=/usr/bin", `VIRTUAL_ENV=${TMP}/by-environ`] },
    105: { maps: `7f00-7f01 r-xp 00000000 08:01 5 ${TMP}/by-library/lib.so\n7f02-7f03 r--p 00000000 08:01 6 /usr/lib/libc.so.6\n` },
    106: { cwd: `${TMP}/by-deleted-cwd (deleted)` },
  }, [`${TMP}/by-socket/agent.1`, "@abstract-socket"]);
  const mentions = new PathMentions(roots);

  assert.equal(await scanProcessUsage(mentions, { procRoot: proc, selfPid: self }), true);
  for (const name of ["by-cwd", "by-exe", "by-open-file.log", "by-argv", "by-environ", "by-library", "by-deleted-cwd", "by-socket"]) {
    assert.equal(mentions.has(`${TMP}/${name}`), true, name);
  }
  assert.equal(mentions.has(`${TMP}/unused`), false);
});

test("a process table that cannot be trusted is reported, so the caller keeps everything", async () => {
  const mentions = new PathMentions(roots);
  assert.equal(await scanProcessUsage(mentions, { procRoot: path.join(base, "no-proc-here") }), false, "no process table");

  const hidden = fakeProc("proc-hidden", { 100: { cwd: `${TMP}/a` } });
  assert.equal(await scanProcessUsage(mentions, { procRoot: hidden, selfPid: 4242 }), false, "our own process is not in it");
});
