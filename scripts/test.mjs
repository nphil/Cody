#!/usr/bin/env node
// `npm test`: the whole suite under a private TMPDIR that is deleted afterwards.
// Dozens of tests mkdtemp under os.tmpdir() and never remove what they made —
// one run left ~50 directories in /tmp, and on a long-lived container they only
// accumulate. Scoping TMPDIR catches every such test at once, including ones
// written later, without editing each of them.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUITES = [
  "lib/*.test.mjs",
  "lib/auth/*.test.mjs",
  "lib/devices/*.test.mjs",
  "lib/forge/*.test.mjs",
  "lib/harness/*.test.mjs",
  "lib/i18n/*.test.mjs",
  "lib/model-plan/*.test.mjs",
  "lib/notifications/*.test.mjs",
  "lib/omp/*.test.mjs",
  "lib/openrouter/*.test.mjs",
  "lib/routing/*.test.mjs",
  "lib/scheduled/*.test.mjs",
  "lib/usage/*.test.mjs",
  "components/*.test.mjs",
  "components/settings/*.test.mjs",
  "components/settings/providers/*.test.mjs",
  "components/ui/*.test.mjs",
  "hooks/*.test.mjs",
  "bin/*.test.mjs",
];

const scratch = mkdtempSync(join(tmpdir(), "cody-test-run-"));
let status = 1;
try {
  // node --test expands the glob patterns itself; no shell is involved.
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", ...process.argv.slice(2), ...SUITES],
    { stdio: "inherit", env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } },
  );
  status = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
