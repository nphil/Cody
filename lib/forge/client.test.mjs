import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * One interface, two code hosts. Gitea copied GitHub's JSON for most of what
 * Cody reads, so these tests pin the places where it did NOT: the star field
 * and the freshness timestamp on a repository, pagination (`per_page` vs
 * `limit`), whether the issue list contains pull requests, how a diff is
 * asked for, and where packages live. Anything an agent or the update check
 * reads has to come out identical whichever host answered.
 *
 * Fixtures are trimmed real payloads — the fields the mapper reads plus a few
 * it must ignore.
 */
const piCodingAgentDirScratch = mkdtempSync(join(tmpdir(), "cody-forge-client-"));
process.env.PI_CODING_AGENT_DIR = piCodingAgentDirScratch;
process.on("exit", () => rmSync(piCodingAgentDirScratch, { recursive: true, force: true }));
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const jiti = createJiti(import.meta.url);
const { createForgeClient, ForgeError, parseRepoRef } = await jiti.import("./client.ts");

const GITHUB = { id: "github", kind: "github", label: "GitHub", baseUrl: "https://github.com", owner: "nphil", token: "gh-token" };
const GITEA = { id: "home", kind: "gitea", label: "Home forge", baseUrl: "https://git.example.net", owner: "nphil", token: "gitea-token" };
const REPO = { owner: "nphil", name: "Cody" };

/** Records every request and answers each one from `answers`, matched by the
 * first key the URL contains. */
function stub(answers) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init, headers: init.headers ?? {} });
    const key = Object.keys(answers).find((candidate) => url.includes(candidate));
    if (key === undefined) throw new Error(`unexpected request: ${url}`);
    const value = answers[key];
    if (typeof value === "string") return new Response(value, { status: 200, headers: { "Content-Type": "text/plain" } });
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetcher };
}

const GITHUB_REPO_FIXTURE = {
  full_name: "nphil/Cody",
  description: "A local web workspace",
  default_branch: "main",
  private: true,
  archived: false,
  fork: false,
  stargazers_count: 12,
  open_issues_count: 3,
  pushed_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
  html_url: "https://github.com/nphil/Cody",
  clone_url: "https://github.com/nphil/Cody.git",
  owner: { login: "nphil", email: "someone@example.com" },
};

const GITEA_REPO_FIXTURE = {
  full_name: "nphil/Cody",
  description: "A local web workspace",
  default_branch: "main",
  private: true,
  archived: false,
  fork: false,
  stars_count: 12,
  open_issues_count: 3,
  updated_at: "2026-09-01T10:00:00Z",
  html_url: "https://git.example.net/nphil/Cody",
  clone_url: "https://git.example.net/nphil/Cody.git",
};

test("a repository reads the same on both hosts, from the field each one actually uses", async () => {
  const gh = stub({ "/repos/nphil/Cody": GITHUB_REPO_FIXTURE });
  const github = await createForgeClient(GITHUB, { fetcher: gh.fetcher }).repoView(REPO);
  const gt = stub({ "/repos/nphil/Cody": GITEA_REPO_FIXTURE });
  const gitea = await createForgeClient(GITEA, { fetcher: gt.fetcher }).repoView(REPO);

  // The URLs are each host's own; everything else must come out identical.
  assert.deepEqual(
    { ...github, htmlUrl: null, cloneUrl: null },
    { ...gitea, htmlUrl: null, cloneUrl: null },
    "the two backends produce one shape",
  );
  assert.equal(gitea.htmlUrl, "https://git.example.net/nphil/Cody");
  assert.equal(github.stars, 12, "stargazers_count on GitHub, stars_count on Gitea");
  assert.equal(github.updatedAt, "2026-09-01T10:00:00Z", "GitHub's pushed_at is the freshness signal; Gitea has only updated_at");
  assert.equal(github.private, true);
  assert.equal(gh.calls[0].url, "https://api.github.com/repos/nphil/Cody");
  assert.equal(gt.calls[0].url, "https://git.example.net/api/v1/repos/nphil/Cody");
});

test("each host gets the Accept and Authorization scheme it accepts, and never the other's", async () => {
  const gh = stub({ "/repos/": GITHUB_REPO_FIXTURE });
  await createForgeClient(GITHUB, { fetcher: gh.fetcher }).repoView(REPO);
  assert.equal(gh.calls[0].headers.Authorization, "Bearer gh-token");
  assert.equal(gh.calls[0].headers.Accept, "application/vnd.github+json");

  const gt = stub({ "/repos/": GITEA_REPO_FIXTURE });
  await createForgeClient(GITEA, { fetcher: gt.fetcher }).repoView(REPO);
  assert.equal(gt.calls[0].headers.Authorization, "token gitea-token");
  assert.equal(gt.calls[0].headers.Accept, "application/json");

  const anon = stub({ "/repos/": GITEA_REPO_FIXTURE });
  await createForgeClient({ ...GITEA, token: undefined }, { fetcher: anon.fetcher }).repoView(REPO);
  assert.equal("Authorization" in anon.calls[0].headers, false, "no token means no header, not an empty one");
});

test("the issue list means issues on both hosts, and pages with each host's own parameter", async () => {
  const issue = {
    number: 7,
    title: "Preview panel is blank",
    state: "open",
    user: { login: "nitin" },
    labels: [{ name: "bug" }, { name: "ui" }],
    comments: 2,
    created_at: "2026-08-30T09:00:00Z",
    updated_at: "2026-09-01T09:00:00Z",
    html_url: "https://example.net/nphil/Cody/issues/7",
  };
  // GitHub's /issues includes pull requests; Gitea's does not.
  const gh = stub({ "/issues": [issue, { ...issue, number: 8, pull_request: { url: "…" } }] });
  const github = await createForgeClient(GITHUB, { fetcher: gh.fetcher }).issues(REPO, { state: "all", limit: 5 });
  assert.deepEqual(github.map((row) => row.number), [7], "a pull request is not an issue");
  assert.equal(github[0].author, "nitin");
  assert.deepEqual(github[0].labels, ["bug", "ui"]);
  assert.match(gh.calls[0].url, /[?&]per_page=5(&|$)/);
  assert.match(gh.calls[0].url, /[?&]state=all(&|$)/);

  const gt = stub({ "/issues": [issue] });
  const gitea = await createForgeClient(GITEA, { fetcher: gt.fetcher }).issues(REPO, { state: "all", limit: 5 });
  assert.deepEqual(gitea, github);
  assert.match(gt.calls[0].url, /[?&]limit=5(&|$)/);
  assert.match(gt.calls[0].url, /[?&]type=issues(&|$)/, "Gitea filters pull requests out server-side");
});

test("a pull request reads the same, and its diff is fetched the way each host serves one", async () => {
  const pull = {
    number: 42,
    title: "Add the forge tool",
    state: "open",
    draft: false,
    merged: false,
    user: { login: "nitin" },
    head: { label: "nphil:forge", ref: "forge", sha: "abcdef1234567890" },
    base: { label: "nphil:main", ref: "main", sha: "0011223344556677" },
    created_at: "2026-09-01T09:00:00Z",
    updated_at: "2026-09-02T09:00:00Z",
    html_url: "https://example.net/nphil/Cody/pulls/42",
    body: "Adds a code-host tool.",
    mergeable: true,
    additions: 120,
    deletions: 4,
    changed_files: 6,
  };
  const gh = stub({ "/pulls/42": pull });
  const github = await createForgeClient(GITHUB, { fetcher: gh.fetcher }).pullView(REPO, 42);
  const gt = stub({ "/pulls/42": pull });
  const gitea = await createForgeClient(GITEA, { fetcher: gt.fetcher }).pullView(REPO, 42);
  assert.deepEqual(github, gitea);
  assert.equal(github.head, "nphil:forge");
  assert.equal(github.changedFiles, 6);

  const diff = "diff --git a/x b/x\n";
  const ghDiff = stub({ "/pulls/42": diff });
  assert.equal(await createForgeClient(GITHUB, { fetcher: ghDiff.fetcher }).pullDiff(REPO, 42), diff);
  assert.equal(ghDiff.calls[0].url, "https://api.github.com/repos/nphil/Cody/pulls/42");
  assert.equal(ghDiff.calls[0].headers.Accept, "application/vnd.github.diff", "GitHub asks for a diff through Accept");

  const gtDiff = stub({ "/pulls/42.diff": diff });
  assert.equal(await createForgeClient(GITEA, { fetcher: gtDiff.fetcher }).pullDiff(REPO, 42), diff);
  assert.equal(gtDiff.calls[0].url, "https://git.example.net/api/v1/repos/nphil/Cody/pulls/42.diff", "Gitea puts it in the path");
});

test("a release carries its assets, and a missing latest release is an absence rather than a failure", async () => {
  const release = {
    id: 9,
    tag_name: "v0.18.0",
    name: "Cody v0.18.0",
    draft: false,
    prerelease: false,
    published_at: "2026-09-05T12:00:00Z",
    html_url: "https://example.net/nphil/Cody/releases/tag/v0.18.0",
    body: "Code hosts.",
    assets: [{ id: 3, name: "cody.zip", size: 1024, browser_download_url: "https://example.net/a/cody.zip" }],
  };
  for (const host of [GITHUB, GITEA]) {
    const { calls, fetcher } = stub({ "/releases/latest": release });
    const latest = await createForgeClient(host, { fetcher }).releaseLatest(REPO);
    assert.equal(latest.tagName, "v0.18.0");
    assert.deepEqual(latest.assets, [{ id: 3, name: "cody.zip", size: 1024, downloadUrl: "https://example.net/a/cody.zip" }]);
    assert.ok(calls[0].url.endsWith("/repos/nphil/Cody/releases/latest"));
  }

  const empty = stub({ "/releases/latest": new Response("{}", { status: 404 }) });
  assert.equal(await createForgeClient(GITEA, { fetcher: empty.fetcher }).releaseLatest(REPO), null);

  const broken = stub({ "/releases/latest": new Response(JSON.stringify({ message: "token expired" }), { status: 401 }) });
  await assert.rejects(
    createForgeClient(GITEA, { fetcher: broken.fetcher }).releaseLatest(REPO),
    (error) => error instanceof ForgeError && error.status === 401 && /token expired/.test(error.message),
  );
});

test("runs and jobs read identically, because Gitea copied the Actions payloads", async () => {
  const run = {
    id: 501,
    display_title: "Build and publish",
    status: "completed",
    conclusion: "failure",
    event: "push",
    head_branch: "main",
    head_sha: "0123456789abcdef0123",
    run_number: 88,
    html_url: "https://example.net/nphil/Cody/actions/runs/501",
    started_at: "2026-09-05T12:00:00Z",
    completed_at: "2026-09-05T12:09:00Z",
  };
  const jobs = {
    total_count: 1,
    jobs: [{
      id: 900,
      name: "build",
      status: "completed",
      conclusion: "failure",
      runner_name: "unraid-1",
      started_at: "2026-09-05T12:00:10Z",
      completed_at: "2026-09-05T12:08:00Z",
      steps: [
        { name: "checkout", conclusion: "success" },
        { name: "npm test", conclusion: "failure" },
      ],
    }],
  };
  for (const host of [GITHUB, GITEA]) {
    const { calls, fetcher } = stub({
      "/actions/runs/501/jobs": jobs,
      "/actions/runs/501": run,
      "/actions/runs": { total_count: 1, workflow_runs: [run] },
    });
    const client = createForgeClient(host, { fetcher });
    const [listed] = await client.runs(REPO, { limit: 3, branch: "main" });
    assert.equal(listed.name, "Build and publish");
    assert.equal(listed.headSha, "0123456789ab", "the sha is trimmed to something a human can read");
    assert.equal(listed.conclusion, "failure");
    assert.match(calls[0].url, host.kind === "github" ? /[?&]per_page=3(&|$)/ : /[?&]limit=3(&|$)/);

    assert.equal((await client.runView(REPO, 501)).runNumber, 88);
    const [job] = await client.runJobs(REPO, 501);
    assert.deepEqual(job.failedSteps, ["npm test"], "the failing step is what the agent needs, not all six");
    assert.equal(job.runnerName, "unraid-1");
  }
});

test("job logs come back as text from the endpoint Gitea 1.26 and GitHub both expose", async () => {
  const log = "2026-09-05T12:08:00Z ##[error]npm test failed\n";
  for (const host of [GITHUB, GITEA]) {
    const { calls, fetcher } = stub({ "/actions/jobs/900/logs": log });
    assert.equal(await createForgeClient(host, { fetcher }).jobLogs(REPO, 900), log);
    assert.ok(calls[0].url.endsWith("/repos/nphil/Cody/actions/jobs/900/logs"));
  }
});

test("container packages are listed from the endpoint each host puts them behind", async () => {
  const gt = stub({ "/packages/nphil": [{ name: "cody", type: "container", version: "0.18.0", created_at: "2026-09-05T12:00:00Z", html_url: "https://git.example.net/nphil/-/packages/container/cody/0.18.0" }] });
  const gitea = await createForgeClient(GITEA, { fetcher: gt.fetcher }).packages("nphil", 10);
  assert.deepEqual(gitea, [{ name: "cody", type: "container", version: "0.18.0", createdAt: "2026-09-05T12:00:00Z", htmlUrl: "https://git.example.net/nphil/-/packages/container/cody/0.18.0" }]);
  assert.match(gt.calls[0].url, /\/packages\/nphil\?/);
  assert.match(gt.calls[0].url, /[?&]type=container(&|$)/);

  // GitHub splits user and organization packages; the 404 on the wrong one is
  // expected, not a failure.
  const gh = stub({
    "/users/nphil/packages": new Response("{}", { status: 404 }),
    "/orgs/nphil/packages": [{ name: "cody", package_type: "container", created_at: "2026-09-05T12:00:00Z", html_url: "https://github.com/users/nphil/packages/container/cody" }],
  });
  const github = await createForgeClient(GITHUB, { fetcher: gh.fetcher }).packages("nphil", 10);
  assert.deepEqual(github.map((row) => row.name), ["cody"]);
  assert.equal(gh.calls.length, 2, "the user endpoint is tried first, then the org one");
  assert.match(gh.calls[0].url, /[?&]package_type=container(&|$)/);
});

test("a git tree reads the same, asked for recursively the way each host spells it", async () => {
  const tree = {
    sha: "roothash",
    truncated: false,
    tree: [
      { path: "skills/edge-tts", type: "tree", sha: "folderhash" },
      { path: "README.md", type: "blob", sha: "blobhash" },
    ],
  };
  const gh = stub({ "/git/trees/HEAD": tree });
  const github = await createForgeClient(GITHUB, { fetcher: gh.fetcher }).gitTree(REPO, "HEAD", true);
  assert.equal(github.sha, "roothash");
  assert.deepEqual(github.entries[0], { path: "skills/edge-tts", type: "tree", sha: "folderhash" });
  assert.match(gh.calls[0].url, /\?recursive=1$/);

  const gt = stub({ "/git/trees/HEAD": tree });
  const gitea = await createForgeClient(GITEA, { fetcher: gt.fetcher }).gitTree(REPO, "HEAD", true);
  assert.deepEqual(gitea, github);
  assert.match(gt.calls[0].url, /[?&]recursive=true(&|$)/);
});

test("file contents come back decoded, and a binary blob says so instead of arriving as mojibake", async () => {
  const utf8 = Buffer.from("# Cody\n", "utf8").toString("base64");
  const text = stub({ "/contents/docs/README.md": { path: "docs/README.md", sha: "s1", size: 7, encoding: "base64", content: utf8, type: "file" } });
  const file = await createForgeClient(GITEA, { fetcher: text.fetcher }).fileRead(REPO, "docs/README.md", "main");
  assert.equal(file.text, "# Cody\n");
  assert.equal(file.binary, false);
  assert.match(text.calls[0].url, /[?&]ref=main(&|$)/);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString("base64");
  const binary = stub({ "/contents/icon.png": { path: "icon.png", sha: "s2", size: 6, encoding: "base64", content: png, type: "file" } });
  const blob = await createForgeClient(GITEA, { fetcher: binary.fetcher }).fileRead(REPO, "icon.png");
  assert.equal(blob.binary, true);
  assert.equal(blob.text, null);

  const dir = stub({ "/contents/docs": { path: "docs", type: "dir" } });
  await assert.rejects(createForgeClient(GITEA, { fetcher: dir.fetcher }).fileRead(REPO, "docs"), /directory/);
});

test("a repository argument resolves against the host's owner, and says so when it cannot", () => {
  assert.deepEqual(parseRepoRef("nphil/Cody", ""), { owner: "nphil", name: "Cody" });
  assert.deepEqual(parseRepoRef("Cody", "nphil"), { owner: "nphil", name: "Cody" });
  assert.deepEqual(parseRepoRef("/nphil/Cody.git", ""), { owner: "nphil", name: "Cody" });
  assert.throws(() => parseRepoRef("Cody", ""), /owner\/Cody/);
  assert.throws(() => parseRepoRef("a/b/c", "nphil"), /owner\/name/);
  assert.throws(() => parseRepoRef("  ", "nphil"), /required/);
});

test("an unreachable host is reported as unreachable, not as an empty answer", async () => {
  const fetcher = async () => {
    throw new Error("getaddrinfo ENOTFOUND git.example.net");
  };
  await assert.rejects(
    createForgeClient(GITEA, { fetcher }).repoView(REPO),
    (error) => error instanceof ForgeError && error.status === null && /Home forge is unreachable/.test(error.message),
  );
});
