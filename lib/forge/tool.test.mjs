import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * What the forge tool hands the model: every code-host timestamp is written in
 * the session's zone with its offset stated, not as the host's UTC string.
 * Only the `forge` tool's own output is asserted here — the client's mapping of
 * each host's payload is client.test.mjs's job.
 */
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cody-forge-tool-"));
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const jiti = createJiti(import.meta.url);
const { runForgeTool } = await jiti.import("./tool.ts");

const ISSUE = {
  number: 7,
  title: "Preview panel is blank",
  state: "open",
  user: { login: "nitin" },
  labels: [],
  comments: 0,
  created_at: "2026-10-01T23:31:39Z",
  updated_at: "2026-10-02T00:05:00Z",
  html_url: "https://example.net/nphil/Cody/issues/7",
};
const RUN = {
  id: 501,
  display_title: "Build",
  status: "completed",
  conclusion: "success",
  event: "push",
  head_branch: "main",
  head_sha: "0123456789abcdef0123",
  run_number: 88,
  html_url: "https://example.net/nphil/Cody/actions/runs/501",
  started_at: "2026-10-01T23:31:39Z",
  completed_at: "",
};

async function withHost(answers, run) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = Object.keys(answers).find((candidate) => String(url).includes(candidate));
    if (key === undefined) throw new Error(`unexpected request: ${String(url)}`);
    return new Response(JSON.stringify(answers[key]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const ARGS = { op: "issues", repo: "nphil/Cody" };

test("issue dates are written in the session's zone and never as the host's UTC string", () =>
  withHost({ "/issues": [ISSUE] }, async () => {
    const newYork = JSON.parse(await runForgeTool(ARGS, { cwd: "/tmp", timeZone: "America/New_York" }));
    assert.equal(newYork.issues[0].createdAt, "2026-10-01 19:31 EDT");
    assert.equal(newYork.issues[0].updatedAt, "2026-10-01 20:05 EDT");

    // Same instants, another zone: the date rolls over and the offset is spelled out.
    const tokyo = JSON.parse(await runForgeTool(ARGS, { cwd: "/tmp", timeZone: "Asia/Tokyo" }));
    assert.equal(tokyo.issues[0].createdAt, "2026-10-02 08:31 UTC+09:00");
    assert.equal(tokyo.issues[0].updatedAt, "2026-10-02 09:05 UTC+09:00");
    assert.doesNotMatch(JSON.stringify(tokyo), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  }));

test("a date the host leaves empty stays empty, and non-date fields are untouched", () =>
  withHost({ "/actions/runs": { total_count: 1, workflow_runs: [RUN] } }, async () => {
    const out = JSON.parse(await runForgeTool({ op: "runs", repo: "nphil/Cody" }, { cwd: "/tmp", timeZone: "Asia/Tokyo" }));
    assert.equal(out.runs[0].startedAt, "2026-10-02 08:31 UTC+09:00");
    assert.equal(out.runs[0].completedAt, "");
    assert.equal(out.runs[0].name, "Build");
    assert.equal(out.runs[0].htmlUrl, RUN.html_url);
  }));

test("a missing or invalid zone falls back to the server's zone", () =>
  withHost({ "/issues": [ISSUE] }, async () => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      for (const timeZone of [undefined, "Not/AZone"]) {
        const out = JSON.parse(await runForgeTool(ARGS, { cwd: "/tmp", timeZone }));
        assert.equal(out.issues[0].createdAt, "2026-10-02 08:31 UTC+09:00");
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }));
