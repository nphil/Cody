/**
 * What the agent reads about `run_on_worker`: its name, its description and the
 * arguments it may pass.
 *
 * Pure data with no imports, because the words are needed in places that
 * cannot all import Cody's code: the omp extension that offers the tool
 * (lib/omp/extensions/cody-run-on-worker.ts, loaded by omp itself under Bun),
 * the parser and its tests (lib/workers/tool.ts), and the MCP bridge for
 * Claude and Codex (bin/cody-display-mcp.js, a plain script that repeats the
 * words; bin/cody-display-mcp.test.mjs fails when its copy drifts).
 */

export const RUN_ON_WORKER_NAME = "run_on_worker";

export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const MAX_TIMEOUT_SECONDS = 7200;

export interface RunOnWorkerProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface RunOnWorkerDefinition {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, RunOnWorkerProperty>; required: string[] };
}

export const RUN_ON_WORKER_TOOL: RunOnWorkerDefinition = {
  name: RUN_ON_WORKER_NAME,
  description:
    "Run a heavy command on another machine (a \"worker\") instead of on the server this chat runs on, and get its output and result files back. Helper agents can call it too. "
    + "Use it for builds and tests you expect to take over a minute: a cold cargo or zig build (also the TV cross build), a Next or bun build, a whole test suite, bundling, image builds. This server is usually busy, so these run faster on the worker and stop slowing every other chat down. "
    + "Do NOT use it for quick commands, edits, git, or anything that needs this machine's running services, dev server, ports or secrets: those stay local with your normal shell tool. "
    + "Cody copies the project to the worker (default: the git repository's tracked and untracked-but-not-ignored files, so node_modules and build output are NOT copied: narrow the copy with `include` and install dependencies inside `command`, for example `npm ci && npm test`), "
    + "runs `command` there at low priority from the copy of `cwd`, streams the output, copies the paths in `results` back into the workspace, and deletes the copy. "
    + "Edits you make to files while it runs are not copied. "
    + "A worker that mirrors this server runs the project at the SAME absolute path (for example /data/home/project) with the same toolchains, $HOME and venvs, so absolute paths in configs and scripts work unchanged; a Cargo `target` directory is kept between runs, so the next build is incremental. The output says when a worker could not do this. "
    + "The worker is chosen for you (it must match `arch` and have every tool in `tools`; the one with the most free CPU and memory wins). "
    + "If no worker can take the job right now it runs on this server instead and the result says so; pass fallbackLocal=false to wait in the queue for a worker instead. "
    + "If the worker drops out mid-run, Cody runs the job once more elsewhere and tells you exactly what happened. "
    + "The result starts with the exit code and where it ran, then the last 200 lines of output; the whole output is saved to a file whose path is given. "
    + "Results copied back overwrite files in the workspace but never delete any.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command, run with sh -c from the copy of `cwd` on the worker. Failures are reported through the exit code.",
      },
      cwd: {
        type: "string",
        description: "Directory the command runs in. Default: this chat's workspace (a helper agent: its own directory). Relative paths resolve against the workspace; it must be inside the workspace or inside another git repository.",
      },
      include: {
        type: "array",
        items: { type: "string" },
        description: "Globs, relative to `cwd`, of the files to copy to the worker (for example [\"src/**\", \"package.json\"]). Default: every tracked and untracked-but-not-ignored file of the git repository (the whole repository, not only `cwd`): pass `include` for a big repository.",
      },
      results: {
        type: "array",
        items: { type: "string" },
        description: "Files or directories, relative to `cwd`, to copy back into the workspace when the command finishes, also when it fails (for example [\"dist\", \"target/release/app\"]). Default: none.",
      },
      arch: {
        type: "string",
        enum: ["x86_64", "aarch64"],
        description: "Require a worker of this CPU architecture. Set it when the results are programs that must run on this server.",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Toolchains the worker must have, for example [\"node\", \"rust\", \"zig\"]. Leave it empty unless the job really needs one: a worker without it is skipped.",
      },
      timeoutSeconds: {
        type: "number",
        description: `Stop the command after this many seconds of running (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}).`,
      },
      fallbackLocal: {
        type: "boolean",
        description: "Default true: when no worker can take the job now, run it on this server and say so. false: wait in the queue for a worker (up to 30 minutes) and never run it here.",
      },
    },
    required: ["command"],
  },
};
