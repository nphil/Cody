import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostToolDefinition } from "../pi-types";
import { formatToolTime, toolTimeZone } from "../tool-time";
import {
  createForgeClient,
  fileAsBlob,
  ForgeError,
  parseRepoRef,
  type ForgeClient,
  type ForgeRepoRef,
} from "./client";
import { listForgeHosts, matchForgeHostUrl, resolveForgeHost, type ForgeHost } from "./config";

/**
 * `forge`: the agent's own access to the code host, GitHub or self-hosted
 * Gitea, without a `gh` binary and without github.com.
 *
 * Only omp sessions get it. It rides the same `set_host_tools` registration as
 * `preview_screenshot` and `cody_todo` (lib/rpc-manager.ts) and settles inside
 * the Cody server process, where the tokens live. Cody's ACP engines (Claude
 * Code, Codex) reach Cody through `bin/cody-display-mcp.js`, a standalone
 * script that holds no Cody state and talks back over capability-scoped HTTP;
 * giving it the forge would mean publishing a new authenticated HTTP surface
 * that proxies arbitrary code-host calls, which is a bigger blast radius than
 * this buys. So: omp sessions only, deliberately.
 */

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 120_000;
const MAX_LOG_CHARS = 8_000;
const REMOTE_TIMEOUT_MS = 5_000;
const RUN_POLL_MS = 5_000;
const DEFAULT_RUN_WATCH_SECONDS = 300;
const MAX_RUN_WATCH_SECONDS = 1_800;

/** Keys the client maps from a code host's `*_at` timestamps. The tool writes
 * them in the session's zone instead of the host's UTC string. */
const TIMESTAMP_FIELDS: Record<string, true> = { createdAt: true, updatedAt: true, publishedAt: true, startedAt: true, completedAt: true };

export const FORGE_TOOL_OPS = [
  "hosts",
  "repo_view",
  "file_read",
  "issues",
  "issue_view",
  "prs",
  "pr_view",
  "pr_diff",
  "pr_create",
  "releases",
  "release_create",
  "release_upload",
  "runs",
  "run_watch",
  "packages",
] as const;

export type ForgeToolOp = (typeof FORGE_TOOL_OPS)[number];

export const FORGE_HOST_TOOL: HostToolDefinition = {
  name: "forge",
  description:
    "Read and write the code host this project lives on — GitHub or a self-hosted Gitea — without the gh CLI. "
    + "Repositories, files at a ref, issues, pull requests and their diffs, releases and their assets, Actions runs and packages. "
    + "`repo` defaults to the origin remote of the session's checkout when that host is configured in Cody; pass owner/name to reach another repository. "
    + "`host` picks a configured code host by id (run op=hosts to see them); omitted uses the default one. "
    + "Use pr_diff to review a pull request, run_watch after pushing to see whether CI passed (it polls until the run finishes and reports the failing jobs with a log tail), and packages to see what container images an owner has published.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: [...FORGE_TOOL_OPS], description: "Operation to perform." },
      host: { type: "string", description: "Configured code host id. Omit for the default host." },
      repo: { type: "string", description: "Repository as owner/name, or a bare name to use the host's default owner. Omit to use the checkout's origin remote." },
      path: { type: "string", description: "file_read: repository-relative file path. release_upload: local file to upload." },
      ref: { type: "string", description: "file_read: branch, tag or commit. Defaults to the repository's default branch." },
      state: { type: "string", enum: ["open", "closed", "all"], description: "issues / prs: which state to list. Default open." },
      limit: { type: "number", description: "List operations: how many to return (default 30, max 100)." },
      number: { type: "number", description: "issue_view / pr_view / pr_diff: the issue or pull request number." },
      comments: { type: "boolean", description: "issue_view: include the comment thread." },
      title: { type: "string", description: "pr_create: pull request title." },
      body: { type: "string", description: "pr_create / release_create: markdown body." },
      head: { type: "string", description: "pr_create: source branch." },
      base: { type: "string", description: "pr_create: target branch." },
      tag: { type: "string", description: "release_create: tag name, for example v1.2.0." },
      name: { type: "string", description: "release_create: release title. release_upload: asset name (defaults to the file's own name)." },
      prerelease: { type: "boolean", description: "release_create: mark as a pre-release." },
      draft: { type: "boolean", description: "release_create: create as a draft." },
      release_id: { type: "number", description: "release_upload: the release to attach the asset to." },
      run_id: { type: "number", description: "run_watch: the run to watch. Omit to watch the newest run." },
      branch: { type: "string", description: "runs / run_watch: only runs on this branch." },
      event: { type: "string", description: "runs: only runs triggered by this event, for example push." },
      status: { type: "string", description: "runs: only runs in this status, for example failure." },
      owner: { type: "string", description: "packages: the account whose packages to list. Defaults to the host's owner." },
      timeout: { type: "number", description: `run_watch: seconds to keep polling (default ${DEFAULT_RUN_WATCH_SECONDS}, max ${MAX_RUN_WATCH_SECONDS}).` },
    },
    required: ["op"],
  },
};

export interface ForgeToolContext {
  /** The session's working directory, used to find the origin remote. */
  cwd: string;
  /** IANA zone of the message the agent is answering; dates in results are written in it. Omitted or invalid -> the server's zone. */
  timeZone?: string;
}

interface ForgeToolArgs {
  op?: unknown;
  host?: unknown;
  repo?: unknown;
  path?: unknown;
  ref?: unknown;
  state?: unknown;
  limit?: unknown;
  number?: unknown;
  comments?: unknown;
  title?: unknown;
  body?: unknown;
  head?: unknown;
  base?: unknown;
  tag?: unknown;
  name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  release_id?: unknown;
  run_id?: unknown;
  branch?: unknown;
  event?: unknown;
  status?: unknown;
  owner?: unknown;
  timeout?: unknown;
}

function requireString(args: ForgeToolArgs, key: keyof ForgeToolArgs, op: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new ForgeError(`${op} requires ${String(key)}`);
  return value.trim();
}

function requireNumber(args: ForgeToolArgs, key: keyof ForgeToolArgs, op: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ForgeError(`${op} requires ${String(key)}`);
  return value;
}

/** The checkout's own code host, when Cody knows it. Silent on anything that
 * is not a git worktree with an origin — the caller then has to name a repo,
 * which the error says. */
async function repoFromOrigin(cwd: string): Promise<{ host: ForgeHost; repo: string } | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: REMOTE_TIMEOUT_MS });
    return matchForgeHostUrl(stdout.trim());
  } catch {
    return null;
  }
}

async function resolveTarget(args: ForgeToolArgs, context: ForgeToolContext): Promise<{ host: ForgeHost; repo: ForgeRepoRef }> {
  const requestedHost = typeof args.host === "string" && args.host.trim() ? args.host.trim() : undefined;
  const requestedRepo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;

  if (!requestedRepo) {
    const derived = await repoFromOrigin(context.cwd);
    if (!derived) {
      throw new ForgeError(
        "No repository given, and this checkout's origin remote does not match a configured code host. Pass repo as owner/name, or add the host in Settings › Code hosts.",
      );
    }
    // An explicit host still wins: the same owner/name may be mirrored.
    const host = requestedHost ? resolveForgeHost(requestedHost) : derived.host;
    if (!host) throw new ForgeError(`Unknown code host "${requestedHost}". Run op=hosts to list the configured ones.`);
    return { host, repo: parseRepoRef(derived.repo, host.owner) };
  }

  const host = resolveForgeHost(requestedHost);
  if (!host) {
    throw new ForgeError(
      requestedHost
        ? `Unknown code host "${requestedHost}". Run op=hosts to list the configured ones.`
        : "No code host is configured. Add one in Settings › Code hosts.",
    );
  }
  return { host, repo: parseRepoRef(requestedRepo, host.owner) };
}

function boundedLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function truncate(value: string, max: number, what: string): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… ${what} truncated at ${max} characters (${value.length} total).`;
}

/** A run nobody is waiting on any more: Gitea reports a terminal state in
 * `status`, GitHub moves `status` to `completed` and fills `conclusion`. */
function isTerminalRun(run: { status: string; conclusion: string }): boolean {
  const terminal: Record<string, true> = { completed: true, success: true, failure: true, failed: true, cancelled: true, canceled: true, skipped: true, error: true };
  return terminal[run.status] === true || (run.conclusion !== "" && run.conclusion !== "null");
}

async function runWatch(client: ForgeClient, repo: ForgeRepoRef, args: ForgeToolArgs): Promise<unknown> {
  const branch = typeof args.branch === "string" ? args.branch : undefined;
  let runId = typeof args.run_id === "number" ? args.run_id : 0;
  if (!runId) {
    const [newest] = await client.runs(repo, { limit: 1, branch });
    if (!newest) return { watched: null, note: "No workflow runs found for this repository." };
    runId = newest.id;
  }
  const seconds = typeof args.timeout === "number" && Number.isFinite(args.timeout)
    ? Math.max(RUN_POLL_MS / 1000, Math.min(MAX_RUN_WATCH_SECONDS, args.timeout))
    : DEFAULT_RUN_WATCH_SECONDS;
  const deadline = Date.now() + seconds * 1000;

  let run = await client.runView(repo, runId);
  while (!isTerminalRun(run) && Date.now() < deadline) {
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, RUN_POLL_MS);
    await tick.promise;
    run = await client.runView(repo, runId);
  }
  const jobs = await client.runJobs(repo, runId);
  const timedOut = !isTerminalRun(run);

  // Only the failures get logs: a green run's output is noise, and a job log
  // is the largest thing this tool can return.
  const logs: Array<{ job: string; tail: string }> = [];
  for (const job of jobs) {
    if (job.conclusion !== "failure" && job.status !== "failure") continue;
    try {
      const body = await client.jobLogs(repo, job.id);
      logs.push({ job: job.name, tail: body.length > MAX_LOG_CHARS ? body.slice(-MAX_LOG_CHARS) : body });
    } catch (error) {
      logs.push({ job: job.name, tail: `Logs unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return {
    run,
    jobs,
    ...(logs.length > 0 ? { failedJobLogs: logs } : {}),
    ...(timedOut ? { note: `Still running after ${seconds}s; the state above is the last one polled.` } : {}),
  };
}

/** Runs one `forge` call and returns the text the agent sees. Throws
 * ForgeError with a sentence the model can act on. */
export async function runForgeTool(rawArgs: unknown, context: ForgeToolContext): Promise<string> {
  const args = (typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}) as ForgeToolArgs;
  const op = typeof args.op === "string" ? args.op : "";
  if (!(FORGE_TOOL_OPS as readonly string[]).includes(op)) {
    throw new ForgeError(`Unknown forge op "${op}". Valid ops: ${FORGE_TOOL_OPS.join(", ")}.`);
  }

  if (op === "hosts") {
    const hosts = listForgeHosts().map((host) => ({
      id: host.id,
      kind: host.kind,
      label: host.label,
      baseUrl: host.baseUrl,
      apiUrl: host.apiUrl,
      owner: host.owner,
      authenticated: host.hasToken,
      default: host.isDefault,
    }));
    return JSON.stringify({ hosts }, null, 2);
  }

  const { host, repo } = await resolveTarget(args, context);
  const client = createForgeClient(host);
  const limit = boundedLimit(args.limit, 30);
  const state = args.state === "closed" || args.state === "all" ? args.state : "open";
  const zone = toolTimeZone(context.timeZone);
  const json = (value: unknown): string => JSON.stringify(value, (key, field) => (
    TIMESTAMP_FIELDS[key] === true && typeof field === "string" && field !== "" ? formatToolTime(field, zone) : field
  ), 2);

  switch (op) {
    case "repo_view":
      return json({ host: host.id, ...(await client.repoView(repo)) });

    case "file_read": {
      const content = await client.fileRead(repo, requireString(args, "path", "file_read"), typeof args.ref === "string" ? args.ref : undefined);
      if (content.binary) return `${content.path} is a binary file (${content.size} bytes, sha ${content.sha}).`;
      if (content.text === null) return `${content.path} was not returned inline by ${host.label} (${content.size} bytes).`;
      return content.text;
    }

    case "issues":
      return json({ repo: `${repo.owner}/${repo.name}`, issues: await client.issues(repo, { state, limit }) });

    case "issue_view":
      return json(await client.issueView(repo, requireNumber(args, "number", "issue_view"), args.comments === true));

    case "prs":
      return json({ repo: `${repo.owner}/${repo.name}`, pulls: await client.pulls(repo, { state, limit }) });

    case "pr_view":
      return json(await client.pullView(repo, requireNumber(args, "number", "pr_view")));

    case "pr_diff": {
      const diff = await client.pullDiff(repo, requireNumber(args, "number", "pr_diff"));
      return diff.trim() ? truncate(diff, MAX_DIFF_CHARS, "Diff") : "That pull request has an empty diff.";
    }

    case "pr_create":
      return json(await client.pullCreate(repo, {
        head: requireString(args, "head", "pr_create"),
        base: requireString(args, "base", "pr_create"),
        title: requireString(args, "title", "pr_create"),
        body: typeof args.body === "string" ? args.body : "",
      }));

    case "releases":
      return json({ repo: `${repo.owner}/${repo.name}`, releases: await client.releases(repo, limit) });

    case "release_create":
      return json(await client.releaseCreate(repo, {
        tag: requireString(args, "tag", "release_create"),
        name: typeof args.name === "string" ? args.name : undefined,
        body: typeof args.body === "string" ? args.body : "",
        draft: args.draft === true,
        prerelease: args.prerelease === true,
      }));

    case "release_upload": {
      const releaseId = requireNumber(args, "release_id", "release_upload");
      const filePath = requireString(args, "path", "release_upload");
      const { blob, name } = await fileAsBlob(filePath);
      const assetName = typeof args.name === "string" && args.name.trim() ? args.name.trim() : name;
      return json(await client.releaseUpload(repo, releaseId, blob, assetName));
    }

    case "runs":
      return json({
        repo: `${repo.owner}/${repo.name}`,
        runs: await client.runs(repo, {
          limit,
          branch: typeof args.branch === "string" ? args.branch : undefined,
          event: typeof args.event === "string" ? args.event : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
        }),
      });

    case "run_watch":
      return json(await runWatch(client, repo, args));

    case "packages": {
      const owner = typeof args.owner === "string" && args.owner.trim() ? args.owner.trim() : host.owner || repo.owner;
      return json({ owner, packages: await client.packages(owner, limit) });
    }

    default:
      throw new ForgeError(`Unhandled forge op "${op}"`);
  }
}
