import * as os from "node:os";
import * as path from "node:path";
import { ensureSessionScratch } from "../disk/scratch";
import { estimateKey, gigabytes, killedForMemory } from "../machines/memory";
import type { WorkerArch } from "../machines/types";
import { DEFAULT_EXECUTE_TIMING, executeOnWorker, type ExecuteTiming } from "./execute";
import { checkResultPaths, findOutsideDirs, listTreeFiles, relativeToCwd, resolveTree, type FileList, type OutsideDirs, type Tree } from "./files";
import { describeReason, formatBytes, formatCount, formatDuration, lastLines } from "./format";
import type { LocalFit, LocalRunOptions, LocalRunResult } from "./local";
import { OutputSink, TAIL_LINES } from "./output";
import { Progress } from "./progress";
import { buildCleanupCommand, buildExecCommand, jobDirectory, mountableExternal, newJobId, newToken, type ExecMap } from "./remote";
import type { Acquired, WorkerScheduler } from "./scheduler";
import { describeRemoteFailure, runRemote, type RemoteShell } from "./shell";
import { copyBack, copyIn, DEFAULT_STALL_MS, type CopyBackResult } from "./transfer";
import type { WorkerMachine } from "./types";

/**
 * One `run_on_worker` call from start to result.
 *
 * Order of events: check the arguments and list the files that would be copied
 * (the same answers whatever the load), with the Cargo crates the project
 * builds from outside itself, ask the scheduler for a worker, then run the job
 * there (copy in, those crates beside it when the worker can show them at
 * their own paths, run, copy results back, delete the copy) or, when the
 * scheduler says so, on this server. A worker that fails BEFORE the command
 * started (unreachable, the copy failed) is skipped and the next one is asked
 * for; one that goes away AFTER it started, or whose kernel stopped the
 * command for lack of memory, gets the job run once more somewhere else (after
 * running out of memory: only on a machine with more of it, this server
 * included); that one re-run is all a job gets, whatever the second loss is.
 * The only proof that a command ended is its exit marker: nothing else is
 * ever reported as success. What each run needed is remembered, so the next
 * run of the same command goes where that much memory is free.
 */

/** The result shows at most this much output; the file has all of it. */
const MAX_TAIL_BYTES = 48 * 1024;

export interface JobRequest {
  command: string;
  /** The agent's `cwd`, relative to the workspace. */
  cwd?: string;
  /** The agent's `include` globs; omitted: the default copy. */
  include?: string[];
  /** Paths (relative to `cwd`) to bring back. */
  results: string[];
  arch: WorkerArch | null;
  tools: string[];
  /** Stop the command after it has run this long. */
  timeoutMs: number;
  fallbackLocal: boolean;
}

export interface JobContext {
  /** The chat's workspace. */
  cwd: string;
  sessionId: string;
  scratchDir?: string | null;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface JobResult {
  text: string;
  /** The command failed or the job could not be completed. */
  isError: boolean;
}

export interface JobTiming extends ExecuteTiming {
  /** No data for this long while copying: the connection is stuck. */
  stallMs: number;
  /** The cleanup of a job directory gets this long. */
  cleanupTimeoutMs: number;
}

export const DEFAULT_JOB_TIMING: JobTiming = { ...DEFAULT_EXECUTE_TIMING, stallMs: DEFAULT_STALL_MS, cleanupTimeoutMs: 45_000 };

/** Everything the job touches outside itself, so a test can put a fake in each place. */
export interface JobDeps {
  scheduler: Pick<WorkerScheduler, "acquire">;
  shell: RemoteShell;
  /** Where jobs live on a worker. */
  workRoot: string;
  /** Could this server run the job instead of a worker? */
  localFit(request: { arch: WorkerArch | null; tools: readonly string[] }): LocalFit;
  runLocal(options: LocalRunOptions): Promise<LocalRunResult>;
  timing: JobTiming;
  now(): number;
  memory?: JobMemoryDeps;
}

/** What a job learns and reads about memory (memory-store.ts and memory-watch.ts in the server). */
export interface JobMemoryDeps {
  /** What the command needed lately, with a margin, MB; null when it has not run lately. */
  needMB(key: string): number | null;
  /** A run ended: its peak, and whether the kernel stopped it for lack of memory (with the memory of the machine it ran on). */
  recordRun(run: { key: string; machine: string; label: string; peakBytes: number | null; oom: boolean; capBytes: number | null; text?: string }): void;
  /** A run started on a machine (`local` for this server). */
  countJob(place: string): void;
  /** Memory a job may use on this server now, MB, with what Cody keeps for itself taken off; null when unknown. */
  localSpareMB(): number | null;
}

type WorkerAcquired = Extract<Acquired, { kind: "worker" }>;

/**
 * What one attempt came to: the final answer, or "try again" (excluding the machine that failed).
 * The answer is built by a function that runs AFTER the attempt's cleanup, so that a copy that
 * could not be deleted is in it.
 */
type Step =
  | { kind: "done"; build: () => JobResult }
  /** `rerun`: the command had started there and its run was lost (the job's one re-run); `minCapMB`: it ran out of memory there, so only a machine with more may take it. */
  | { kind: "again"; machineId: string; note: string; rerun: boolean; minCapMB?: number };

/** What went to a worker for one attempt: files and their size (the project and what it builds from outside itself), and how long it took. */
interface Copied {
  ms: number;
  files: number;
  bytes: number;
}

const MIB = 1024 * 1024;

/** The line the job wrapper prints when it could not show the project at its server path. */
const NOT_MAPPED = /^\[cody\] not run at \S+ \((.+?)\): it runs in .+ on the worker, so paths under (\S+) do not resolve here$/m;

function workerName(machine: WorkerMachine): string {
  const { facts } = machine;
  return facts ? `worker "${machine.label}" (${facts.arch}, ${formatCount(facts.cpus, "core")})` : `worker "${machine.label}"`;
}

function failure(text: string): JobResult {
  return { text, isError: true };
}

class JobRun {
  private readonly jobId: string;
  private readonly startedAt: number;
  private readonly excluded = new Set<string>();
  /** What happened in earlier attempts, in order. */
  private readonly notes: string[] = [];
  /** Things that went wrong around the job (a copy that could not be deleted). */
  private readonly problems: string[] = [];
  private readonly localFit: LocalFit;
  /** Runs started so far (each has its own output file). */
  private runs = 0;
  /** The newest output belongs to a run that was lost and is not the final one. */
  private lostRun = false;
  /** Lost runs that were run again: one at most, whether the connection went or the memory ran out. */
  private reruns = 0;
  /** After running out of memory: only a machine with more than this, MB, may take the job. */
  private minCapMB: number | null = null;
  /** The command's entry in the memory ledger, and what it needed lately (MB). */
  private readonly memoryKey: string;
  private readonly needMB: number | null;
  private sink: OutputSink | null = null;
  private scratch: string | null | undefined;
  /** What the newest attempt on a worker did with the directories the project builds from outside itself. */
  private outsideLines: string[] = [];
  readonly progress: Progress;

  constructor(
    private readonly request: JobRequest,
    private readonly ctx: JobContext,
    private readonly deps: JobDeps,
    private readonly tree: Tree,
    private readonly files: FileList,
    private readonly resultPaths: string[],
    private readonly outside: OutsideDirs,
  ) {
    this.startedAt = deps.now();
    this.jobId = newJobId(Math.max(0, Math.floor(this.startedAt)));
    this.localFit = request.fallbackLocal ? deps.localFit(request) : { ok: false, why: "fallbackLocal is off" };
    this.memoryKey = estimateKey(tree.root, request.command);
    this.needMB = deps.memory?.needMB(this.memoryKey) ?? null;
    this.progress = new Progress({ emit: ctx.onProgress, tail: (count) => this.sink?.tail(count) ?? [] });
  }

  private elapsed(since: number): string {
    return formatDuration(this.deps.now() - since);
  }

  private logDirectory(): string {
    if (this.scratch === undefined) this.scratch = this.ctx.scratchDir ?? ensureSessionScratch(this.ctx.sessionId);
    return this.scratch ? path.join(this.scratch, "workers") : path.join(os.tmpdir(), "cody-worker-logs");
  }

  private newSink(): OutputSink {
    this.runs += 1;
    this.lostRun = false;
    const suffix = this.runs > 1 ? `-${this.runs}` : "";
    const sink = new OutputSink({ logPath: path.join(this.logDirectory(), `${this.jobId}${suffix}.log`) });
    this.sink = sink;
    return sink;
  }

  async run(): Promise<JobResult> {
    const { request, ctx, deps } = this;
    for (;;) {
      this.progress.setStatus("Choosing a worker…");
      const acquired = await deps.scheduler.acquire(
        { arch: request.arch, tools: request.tools, excluded: this.excluded, local: this.localAllowed(), needMB: this.needMB, minCapMB: this.minCapMB },
        {
          signal: ctx.signal,
          onWaiting: (info) => {
            this.progress.setStatus(`Waiting for a worker (${info.position} of ${info.waiting}, ${formatDuration(info.waitedMs)}): ${info.why}`);
          },
        },
      );
      if (acquired.kind === "aborted") return this.cancelled("waiting");
      if (acquired.kind === "refused") return this.refused(acquired.why);
      const step = acquired.kind === "local" ? await this.runHere(acquired.why, acquired.waitedMs) : await this.runOnWorker(acquired);
      if (step.kind === "done") return step.build();
      this.excluded.add(step.machineId);
      this.notes.push(step.note);
      if (step.minCapMB !== undefined) this.minCapMB = Math.max(this.minCapMB ?? 0, step.minCapMB);
      if (step.rerun) {
        this.lostRun = true;
        this.reruns += 1;
        if (this.reruns > 1) return this.cutOffTwice();
      }
    }
  }

  /** This server may take the job: it fits, and after the job ran out of memory somewhere it has more than that to spare (unknown counts as enough). */
  private localAllowed(): boolean {
    if (!this.localFit.ok || this.minCapMB === null) return this.localFit.ok;
    const spare = this.deps.memory?.localSpareMB() ?? null;
    return spare === null || spare >= this.minCapMB;
  }

  // ── On a worker ────────────────────────────────────────────────────────────

  private async runOnWorker(acquired: WorkerAcquired): Promise<Step> {
    const { lease } = acquired;
    const { machine } = lease;
    if (acquired.caveat) this.notes.push(`Memory: ${acquired.caveat}.`);
    let directory = "";
    let reached = false;
    try {
      directory = jobDirectory(this.deps.workRoot, this.jobId);
      return await this.attemptOnWorker(acquired, directory, () => {
        reached = true;
      });
    } finally {
      if (directory) {
        this.progress.setStatus(`Cleaning up on ${machine.label}…`);
        const problem = await this.cleanup(machine, directory);
        // A machine that never took the project has nothing worth reporting.
        if (problem && reached) this.problems.push(`The copy of the project on ${workerName(machine)} could not be deleted (${problem}); it stays in ${directory} on that machine until someone removes it.`);
      }
      lease.release();
    }
  }

  private async attemptOnWorker(acquired: WorkerAcquired, directory: string, reached: () => void): Promise<Step> {
    const { request, ctx, deps, tree, files } = this;
    const { machine } = acquired.lease;
    const name = workerName(machine);
    const label = machine.label;

    this.progress.setStatus(`Copying ${formatCount(files.files.length, "file")} (${formatBytes(files.bytes)}) to ${label}…`);
    const copy = await copyIn({
      shell: deps.shell,
      destination: machine.destination,
      directory,
      tree,
      files: files.files,
      signal: ctx.signal,
      stallMs: deps.timing.stallMs,
      onMoved: (bytes) => {
        this.progress.setStatus(`Copying ${formatCount(files.files.length, "file")} (${formatBytes(files.bytes)}) to ${label}… ${formatBytes(bytes)} sent`);
      },
    });
    if (!copy.ok) {
      if (copy.fault === "cancelled") return { kind: "done", build: () => this.cancelled("copying", name) };
      if (copy.fault === "local") return { kind: "done", build: () => failure(`The project could not be packed for ${name}: ${copy.message}`) };
      return { kind: "again", machineId: machine.id, rerun: false, note: `${name} could not take the project: ${describeReason(copy.reason, copy.detail)}.` };
    }
    reached();
    this.deps.memory?.countJob(machine.id);
    const map: ExecMap | undefined = machine.facts && machine.facts.mapPaths.length > 0 ? { project: tree.root, anchors: machine.facts.mapPaths } : undefined;
    const copied: Copied = { ms: copy.ms, files: this.files.files.length, bytes: this.files.bytes };
    const outside = await this.copyOutside(machine, directory, map, copied);
    if ("step" in outside) return outside.step;

    const token = newToken();
    const sink = this.newSink();
    // The wrapper's first line says when it could not show the project at its server path (see JOB_WRAPPER in remote.ts).
    let head = "";
    let runStartedAt = deps.now();
    const execution = await executeOnWorker({
      shell: deps.shell,
      destination: machine.destination,
      command: buildExecCommand({
        directory,
        cwdRel: tree.cwdRel,
        command: request.command,
        token,
        ...(map ? { map } : {}),
        ...(outside.mounted.length > 0 ? { external: outside.mounted } : {}),
        ...(ctx.scratchDir ? { scratch: path.basename(ctx.scratchDir) } : {}),
      }),
      token,
      timeoutMs: request.timeoutMs,
      signal: ctx.signal,
      timing: deps.timing,
      onStarted: () => {
        runStartedAt = deps.now();
        this.progress.setStatus(() => `Running on ${label} · ${this.elapsed(runStartedAt)}`);
      },
      onOutput: (text) => {
        if (head.length < 4096) head += text;
        sink.write(text);
        this.progress.poke();
      },
    });
    sink.end();
    const ranMs = deps.now() - runStartedAt;
    const refused = map ? NOT_MAPPED.exec(head) : null;
    if (refused && (execution.kind === "exited" || execution.kind === "timeout")) {
      this.notes.push(`${name} did not show the project at its server path (${refused[1]}), so the command ran in a plain copy and paths under ${refused[2]} did not resolve there: a "not found" or "no such file" failure may come from that, not from the command.`);
    }

    if (execution.kind === "cancelled") return { kind: "done", build: () => this.cancelled("running", name) };
    if (execution.kind === "no_start") {
      return { kind: "again", machineId: machine.id, rerun: false, note: `${name} did not start the command: ${describeReason(execution.reason, execution.detail)}.` };
    }
    if (execution.kind === "dropped") {
      const saved = sink.hasLog && sink.logPath ? ` Its output until then (${formatCount(sink.lineCount, "line")}) is in ${sink.logPath}.` : "";
      return {
        kind: "again",
        machineId: machine.id,
        rerun: true,
        note: `${name} went away while the command was running, after ${formatDuration(ranMs)} (${describeReason(execution.reason, execution.detail)}), so that run was lost and no result files were copied.${saved} Cody ran the command again from the start.`,
      };
    }
    if (execution.kind === "timeout") {
      const ended = execution.code === null ? "" : ` It ended with exit code ${execution.code}.`;
      return {
        kind: "done",
        build: () =>
          this.compose(
            `Stopped after ${formatDuration(ranMs)}: the command was still running when its time limit (${Math.round(request.timeoutMs / 1000)} s) ran out, so Cody ended it on ${name}.${ended} No result files were copied back.`,
            true,
            [...this.outsideLines, this.timingLine(acquired.waitedMs, copied, ranMs, null)],
            sink,
          ),
      };
    }

    // The command ended by itself with `execution.code`. What it needed is remembered (a run cut short says less, so it is not).
    const capMB = machine.facts?.memMB ?? null;
    const peak = execution.memory?.peakBytes ?? null;
    const oom = killedForMemory(execution.code, execution.memory);
    const oomText = `${label} ran out of memory: its kernel stopped the command after ${formatDuration(ranMs)} (the worker has ${capMB !== null ? `${gigabytes(capMB * MIB)} GB of` : "an unknown amount of"} memory${peak !== null ? `; the command's processes held ${gigabytes(peak)} GB at the last reading` : ""})`;
    deps.memory?.recordRun({ key: this.memoryKey, machine: machine.id, label, peakBytes: peak, oom, capBytes: capMB !== null ? capMB * MIB : null, ...(oom ? { text: `${oomText}.` } : {}) });
    if (oom) {
      if (this.reruns === 0) {
        const saved = sink.hasLog && sink.logPath ? ` Its output (${formatCount(sink.lineCount, "line")}) is in ${sink.logPath}.` : "";
        return {
          kind: "again",
          machineId: machine.id,
          rerun: true,
          ...(capMB !== null ? { minCapMB: capMB } : {}),
          note: `${oomText}, so that run was lost and no result files were copied.${saved} Cody looked for ${capMB !== null ? `a machine with more than ${gigabytes(capMB * MIB)} GB of memory` : "another machine"} to run it again.`,
        };
      }
      return { kind: "done", build: () => this.finished(name, execution.code, ranMs, acquired.waitedMs, copied, null, sink, [`${oomText}. This was already its second run, so Cody did not run it again; no result files were copied.`]) };
    }
    const back = this.resultPaths.length > 0 ? await this.bringBack(machine, directory, token) : null;
    return { kind: "done", build: () => this.finished(name, execution.code, ranMs, acquired.waitedMs, copied, back, sink) };
  }

  /**
   * Copy the directories the project builds from outside itself next to the
   * job directory, the ones this worker can show at their own paths. One that
   * cannot be packed here is left out (the job runs as it would have without
   * it); a worker that fails takes the attempt with it, as with the project.
   */
  private async copyOutside(machine: WorkerMachine, directory: string, map: ExecMap | undefined, total: Copied): Promise<{ step: Step } | { mounted: string[] }> {
    const { deps, ctx } = this;
    const name = workerName(machine);
    const lines: string[] = [];
    const usable = new Set(mountableExternal(map, this.outside.dirs.map((dir) => dir.path)));
    const mounted: string[] = [];
    const left: string[] = [];
    for (const dir of this.outside.dirs) {
      if (!usable.has(dir.path)) {
        left.push(dir.path);
        continue;
      }
      const sizes = `${formatCount(dir.files.length, "file")} (${formatBytes(dir.bytes)})`;
      this.progress.setStatus(`Copying ${dir.path}, ${sizes}, to ${machine.label}…`);
      const copy = await copyIn({
        shell: deps.shell,
        destination: machine.destination,
        directory: `${directory}-ext${dir.path}`,
        tree: { root: dir.path, cwd: dir.path, cwdRel: "", isGit: false },
        files: dir.files,
        signal: ctx.signal,
        stallMs: deps.timing.stallMs,
      });
      if (!copy.ok) {
        if (copy.fault === "cancelled") return { step: { kind: "done", build: () => this.cancelled("copying", name) } };
        if (copy.fault === "worker") {
          return { step: { kind: "again", machineId: machine.id, rerun: false, note: `${name} could not take ${dir.path}, which the project builds from: ${describeReason(copy.reason, copy.detail)}.` } };
        }
        lines.push(`${dir.path}, which the project builds from, could not be packed (${copy.message}), so the job ran without it.`);
        continue;
      }
      total.ms += copy.ms;
      total.files += dir.files.length;
      total.bytes += dir.bytes;
      mounted.push(dir.path);
      lines.push(`Also copied ${dir.path}, ${sizes}, which the project builds from (a Cargo path dependency outside it), to the same path for the job.`);
    }
    if (left.length > 0) {
      const one = left.length === 1;
      lines.push(`${left.join(", ")}, which the project builds from, ${one ? "was" : "were"} not copied: this worker cannot show ${one ? "it" : "them"} at the same path, so the build may not find ${one ? "it" : "them"}.`);
    }
    if (this.outside.note) lines.push(`${this.outside.note}.`);
    this.outsideLines = lines;
    return { mounted };
  }

  private async bringBack(machine: WorkerMachine, directory: string, token: string): Promise<CopyBackResult> {
    const { deps, ctx, tree } = this;
    const run = () => copyBack({ shell: deps.shell, destination: machine.destination, directory, token, tree, paths: this.resultPaths, signal: ctx.signal, stallMs: deps.timing.stallMs });
    this.progress.setStatus(`Copying results back from ${machine.label}…`);
    let back = await run();
    if (!back.ok && !back.cancelled) {
      this.notes.push(`Copying the results back failed once (${back.message}); Cody tried again.`);
      back = await run();
    }
    return back;
  }

  private async cleanup(machine: WorkerMachine, directory: string): Promise<string | null> {
    try {
      const result = await runRemote(this.deps.shell, machine.destination, buildCleanupCommand(directory, this.deps.workRoot), { timeoutMs: this.deps.timing.cleanupTimeoutMs });
      if (result.code === 0) return null;
      if (result.timedOut) return "the cleanup did not finish in time";
      const failed = describeRemoteFailure(result);
      return describeReason(failed.reason, failed.detail);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  // ── On this server ─────────────────────────────────────────────────────────

  private async runHere(why: string, waitedMs: number): Promise<Step> {
    const { request, ctx, deps, tree } = this;
    const sink = this.newSink();
    const runStartedAt = deps.now();
    deps.memory?.countJob("local");
    this.progress.setStatus(() => `Running on this server · ${this.elapsed(runStartedAt)}`);
    const outcome = await deps.runLocal({
      command: request.command,
      cwd: tree.cwd,
      scratchDir: this.ctx.scratchDir ?? null,
      timeoutMs: request.timeoutMs,
      signal: ctx.signal,
      onOutput: (text) => {
        sink.write(text);
        this.progress.poke();
      },
    });
    sink.end();
    const ranMs = deps.now() - runStartedAt;
    const where = `this server instead of a worker (${why})`;
    const timing = `Timing: ${waitedMs >= 1000 ? `waited ${formatDuration(waitedMs)}, ` : ""}ran ${formatDuration(ranMs)}; ${this.elapsed(this.startedAt)} in all.`;
    const inPlace = `Nothing was copied: the command ran in ${tree.cwd}, so its files are already in the workspace.`;

    if (outcome.startError) return { kind: "done", build: () => failure(`The command could not be started on this server: ${outcome.startError}`) };
    // What a run that ended by itself needed is remembered (a run cut short says less, so it is not).
    const ended = !outcome.timedOut && !outcome.aborted;
    const oom = ended && killedForMemory(outcome.code, outcome.memory);
    const peak = outcome.memory.peakBytes;
    const oomText = `This server ran out of memory and its kernel stopped the command after ${formatDuration(ranMs)}${peak !== null ? ` (its processes held ${gigabytes(peak)} GB at the last reading)` : ""}; Cody's own processes are stopped last, so Cody kept running.`;
    if (ended) deps.memory?.recordRun({ key: this.memoryKey, machine: "local", label: "this server", peakBytes: peak, oom, capBytes: null, ...(oom ? { text: oomText } : {}) });
    if (outcome.aborted) return { kind: "done", build: () => this.cancelled("running", "this server") };
    if (outcome.timedOut) {
      return {
        kind: "done",
        build: () =>
          this.compose(
            `Stopped after ${formatDuration(ranMs)}: the command was still running when its time limit (${Math.round(request.timeoutMs / 1000)} s) ran out, so Cody ended it on ${where}.`,
            true,
            [timing],
            sink,
          ),
      };
    }
    if (outcome.code === null) {
      return { kind: "done", build: () => this.compose(`The command was stopped by signal ${outcome.signal ?? "unknown"} on ${where}.`, true, oom ? [oomText, inPlace, timing] : [inPlace, timing], sink) };
    }
    const details = oom ? [oomText, inPlace, timing] : [inPlace, timing];
    if (this.resultPaths.length > 0) details.push("The `results` paths were not copied: the command ran in place, so they are already in the workspace.");
    const headline = outcome.code === 0
      ? `Exit code 0: the command succeeded on ${where}.`
      : `Exit code ${outcome.code}: the command failed on ${where}.`;
    return { kind: "done", build: () => this.compose(headline, outcome.code !== 0, details, sink) };
  }

  // ── Answers ────────────────────────────────────────────────────────────────

  private timingLine(waitedMs: number, copy: Copied | null, ranMs: number | null, back: { ms: number } | null): string {
    const parts: string[] = [];
    if (waitedMs >= 1000) parts.push(`waited ${formatDuration(waitedMs)} for a worker`);
    if (copy) parts.push(`copied ${formatCount(copy.files, "file")} (${formatBytes(copy.bytes)}) to the worker in ${formatDuration(copy.ms)}`);
    if (ranMs !== null) parts.push(`ran ${formatDuration(ranMs)}`);
    if (back) parts.push(`copied the results back in ${formatDuration(back.ms)}`);
    return `Timing: ${parts.join(", ")}; ${this.elapsed(this.startedAt)} in all.`;
  }

  private finished(
    name: string,
    code: number,
    ranMs: number,
    waitedMs: number,
    copy: Copied,
    back: CopyBackResult | null,
    sink: OutputSink,
    first: readonly string[] = [],
  ): JobResult {
    const details: string[] = [...first];
    if (this.files.skipped > 0) details.push(`${formatCount(this.files.skipped, "entry", "entries")} were not copied to the worker (names that are not valid UTF-8, sockets, devices).`);
    details.push(...this.outsideLines);
    details.push(this.timingLine(waitedMs, copy, ranMs, back?.ok ? back : null));

    let incomplete: string | null = null;
    if (back?.ok) {
      const shown = back.missing.map((entry) => relativeToCwd(entry, this.tree.cwdRel));
      const sizes = `${formatCount(back.report.files, "file")} (${formatBytes(back.report.bytes)})`;
      const skipped = back.report.skippedCount > 0 ? ` ${formatCount(back.report.skippedCount, "link or special file", "links or special files")} in the results were not copied.` : "";
      if (shown.length === this.resultPaths.length) details.push(`Results: none of the requested paths exist on the worker (${shown.join(", ")}); nothing was copied back.`);
      else details.push(`Results: ${sizes} copied back into the workspace.${shown.length > 0 ? ` Not found on the worker: ${shown.join(", ")}.` : ""}${skipped}`);
      if (shown.length > 0) incomplete = `these requested result paths were not produced: ${shown.join(", ")}`;
    } else if (back) {
      const arrived = back.report && back.report.files > 0 ? ` ${formatCount(back.report.files, "file")} arrived before it failed and stay in the workspace; treat the results as incomplete.` : "";
      details.push(`Results: copying them back FAILED${back.cancelled ? " (cancelled)" : `: ${back.message}`}.${arrived}`);
      incomplete = "the result files could not be copied back";
    }

    let headline: string;
    if (code !== 0) headline = `Exit code ${code}: the command failed on ${name} after ${formatDuration(ranMs)}.`;
    else if (incomplete) headline = `Exit code 0, but the job is NOT complete: ${incomplete}. The command succeeded on ${name} in ${formatDuration(ranMs)}.`;
    else headline = `Exit code 0: the command succeeded on ${name} in ${formatDuration(ranMs)}.`;
    return this.compose(headline, code !== 0 || incomplete !== null, details, sink);
  }

  private cancelled(phase: "waiting" | "copying" | "running", where: string = ""): JobResult {
    let text: string;
    if (phase === "waiting") text = "Cancelled while waiting for a worker: the command was never started.";
    else if (phase === "copying") text = `Cancelled while the project was being copied to ${where}: the command was never started.`;
    else if (where === "this server") text = "Cancelled on this server: the command was stopped. Files it had already written stay in the workspace.";
    else text = `Cancelled on ${where}: the command was stopped (or had not started yet) and nothing was copied back.`;
    return this.compose(text, true, [], this.sink);
  }

  private refused(why: string): JobResult {
    const { request } = this;
    const headline = this.reruns > 0
      ? `Failed: the first run was lost (see below) and no worker could take the job again: ${why}.`
      : `No worker could take this job, and it was not run: ${why}.`;
    const lines: string[] = [];
    if (!request.fallbackLocal) lines.push("fallbackLocal is false, so it was not run on this server either.");
    else if (!this.localFit.ok) lines.push(`It could not run on this server instead: ${this.localFit.why}.`);
    else if (this.minCapMB !== null) {
      const spare = this.deps.memory?.localSpareMB() ?? null;
      if (spare !== null) lines.push(`It could not run on this server instead: it has ${gigabytes(spare * MIB)} GB to spare after what Cody keeps for itself, not more than the ${gigabytes(this.minCapMB * MIB)} GB the job already ran out of.`);
    }
    return this.compose(headline, true, lines, this.sink);
  }

  private cutOffTwice(): JobResult {
    return this.compose(
      "Failed: the command was cut off before it finished twice (see below), so Cody did not run it a third time. Nothing here is a result of the command.",
      true,
      [],
      this.sink,
    );
  }

  private compose(headline: string, isError: boolean, details: string[], sink: OutputSink | null): JobResult {
    const lines = [headline, ...this.notes, ...details, ...this.problems];
    const output = sink ? this.outputBlock(sink) : [];
    return { text: output.length > 0 ? `${lines.join("\n")}\n\n${output.join("\n")}` : lines.join("\n"), isError };
  }

  private outputBlock(sink: OutputSink): string[] {
    const total = sink.lineCount;
    const lost = this.lostRun && sink === this.sink;
    if (total === 0) return [lost ? "The lost run printed nothing." : "The command printed nothing."];
    const tail = lastLines(sink.tail(TAIL_LINES), MAX_TAIL_BYTES);
    const lines: string[] = [];
    if (sink.hasLog && sink.logPath) lines.push(`Whole output: ${sink.logPath}${sink.logTruncated ? " (cut off at 32 MB)" : ""}`);
    const whose = lost ? " of the lost run" : "";
    lines.push(tail.shown < total ? `Last ${formatCount(tail.shown, "line")}${whose} (of ${total.toLocaleString("en-US")}):` : `Output${whose} (${formatCount(total, "line")}):`);
    lines.push(tail.text);
    return lines;
  }
}

/** Run one `run_on_worker` call. Never rejects: whatever went wrong is the answer. */
export async function runWorkerJob(request: JobRequest, ctx: JobContext, deps: JobDeps): Promise<JobResult> {
  const { signal } = ctx;
  try {
    const tree = await resolveTree(ctx.cwd, request.cwd, signal);
    if (!tree.ok) return failure(tree.message);
    const results = checkResultPaths(request.results, tree.value.cwdRel);
    if (!results.ok) return failure(results.message);
    const files = await listTreeFiles(tree.value, request.include, signal);
    if (signal?.aborted) return failure("Cancelled before the command started.");
    if (!files.ok) return failure(files.message);
    const outside = await findOutsideDirs(tree.value, files.value, signal);
    if (signal?.aborted) return failure("Cancelled before the command started.");

    const run = new JobRun(request, ctx, deps, tree.value, files.value, results.value, outside);
    try {
      return await run.run();
    } finally {
      run.progress.stop();
    }
  } catch (error) {
    return failure(`The job could not be run: ${error instanceof Error ? error.message : String(error)}`);
  }
}
