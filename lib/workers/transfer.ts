import { pipeline } from "node:stream/promises";
import { firstStderrLine } from "../machines/ssh";
import type { MachineReason } from "../machines/types";
import type { Tree } from "./files";
import { buildCopyBackCommand, buildCopyInCommand, copyBackMarker } from "./remote";
import { describeRemoteFailure, type RemoteExit, type RemoteShell } from "./shell";
import { createArchive, HeadSplitter, TarExtractor, TarProtocolError, type ExtractReport } from "./tarball";

/**
 * The two trips of a job's files: the project out to the worker (`tar` here,
 * `tar -x` there, through ssh's stdin) and the results back into the workspace
 * (`tar` there, a checking reader here). Neither one writes anything on this
 * side except through {@link TarExtractor}, which refuses every path outside
 * the result paths the agent named.
 */

/** Nothing moved for this long: the connection is alive but stuck. */
export const DEFAULT_STALL_MS = 90_000;

function watchdog(stallMs: number, check: () => void): NodeJS.Timeout {
  return setInterval(check, Math.min(5_000, Math.max(50, Math.floor(stallMs / 4))));
}

/** What a failed remote command says, in words that do not blame the connection for a tar that failed. */
function remoteFault(exit: RemoteExit, what: string): { reason: MachineReason; detail: string } {
  if (!exit.noSsh && exit.code !== null && exit.code !== 255) {
    return { reason: "failed", detail: firstStderrLine(exit.stderr) || `${what} exited with status ${exit.code}` };
  }
  return describeRemoteFailure(exit);
}

// ── Out ──────────────────────────────────────────────────────────────────────

export interface CopyInOptions {
  shell: RemoteShell;
  destination: string;
  /** The job directory on the worker. */
  directory: string;
  tree: Tree;
  /** Root-relative files from {@link listTreeFiles}. */
  files: readonly string[];
  signal?: AbortSignal;
  stallMs?: number;
  /** Bytes of the archive sent so far. */
  onMoved?: (bytes: number) => void;
}

export type CopyInResult =
  | { ok: true; ms: number; bytes: number }
  /** The worker (or the way to it) failed: another one may do. */
  | { ok: false; fault: "worker"; reason: MachineReason; detail: string }
  /** This side could not pack the project: another worker would fail the same way. */
  | { ok: false; fault: "local"; message: string }
  | { ok: false; fault: "cancelled" };

/** Create the job directory on the worker and unpack the project into it. */
export async function copyIn(options: CopyInOptions): Promise<CopyInResult> {
  const { shell, destination, directory, tree, files, signal } = options;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  if (signal?.aborted) return { ok: false, fault: "cancelled" };
  let command: string;
  try {
    command = buildCopyInCommand(directory, tree.cwdRel, files.length > 0);
  } catch (error) {
    return { ok: false, fault: "local", message: error instanceof Error ? error.message : String(error) };
  }

  const startedAt = Date.now();
  const proc = shell.start(destination, command);
  const archive = files.length > 0 ? createArchive(tree.root, files) : null;
  let moved = 0;
  let lastMoveAt = Date.now();
  let stalled = false;
  let cancelled = false;
  const stop = () => {
    proc.kill();
    archive?.kill();
  };
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = watchdog(stallMs, () => {
    if (Date.now() - lastMoveAt <= stallMs) return;
    stalled = true;
    stop();
  });

  let piped: Promise<Error | null>;
  if (archive) {
    archive.stdout.on("data", (chunk: Buffer) => {
      moved += chunk.length;
      lastMoveAt = Date.now();
      options.onMoved?.(moved);
    });
    piped = pipeline(archive.stdout, proc.stdin).then(() => null, (error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  } else {
    proc.stdin.end();
    piped = Promise.resolve(null);
  }
  const [pipeError, exit, tar] = await Promise.all([piped, proc.exited, archive ? archive.done : Promise.resolve(null)]);
  clearInterval(timer);
  signal?.removeEventListener("abort", onAbort);

  if (cancelled) return { ok: false, fault: "cancelled" };
  // tar ending on its own with an error status and a message is a problem with the files here;
  // tar killed because ssh went away says nothing.
  if (tar && !tar.ok && tar.code !== null && tar.stderr.trim()) {
    return { ok: false, fault: "local", message: `tar could not pack the project: ${firstStderrLine(tar.stderr)}` };
  }
  if (stalled) {
    return { ok: false, fault: "worker", reason: "unreachable", detail: `nothing was transferred for ${Math.round(stallMs / 1000)} s` };
  }
  if (exit.code !== 0) return { ok: false, fault: "worker", ...remoteFault(exit, "tar") };
  if (pipeError) return { ok: false, fault: "worker", reason: "dropped", detail: pipeError.message };
  return { ok: true, ms: Date.now() - startedAt, bytes: moved };
}

// ── Back ─────────────────────────────────────────────────────────────────────

export interface CopyBackOptions {
  shell: RemoteShell;
  destination: string;
  directory: string;
  token: string;
  tree: Tree;
  /** Root-relative result paths, already checked by {@link checkResultPaths}. */
  paths: readonly string[];
  signal?: AbortSignal;
  stallMs?: number;
}

export type CopyBackResult =
  | {
    ok: true;
    ms: number;
    report: ExtractReport;
    /** Result paths (root-relative) that do not exist on the worker. */
    missing: string[];
  }
  | { ok: false; message: string; cancelled: boolean; report: ExtractReport | null };

/** Bring the result paths home. Files that arrived before a failure stay where they were written. */
export async function copyBack(options: CopyBackOptions): Promise<CopyBackResult> {
  const { shell, destination, directory, token, tree, paths, signal } = options;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  if (signal?.aborted) return { ok: false, message: "cancelled", cancelled: true, report: null };
  let command: string;
  try {
    command = buildCopyBackCommand({ directory, paths, token });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), cancelled: false, report: null };
  }

  const startedAt = Date.now();
  const proc = shell.start(destination, command);
  const splitter = new HeadSplitter(copyBackMarker(token));
  const extractor = new TarExtractor({ root: tree.root, allowed: paths });
  let lastDataAt = Date.now();
  let stalled = false;
  let cancelled = false;
  proc.stdout.on("data", () => {
    lastDataAt = Date.now();
  });
  const onAbort = () => {
    cancelled = true;
    proc.kill();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = watchdog(stallMs, () => {
    if (Date.now() - lastDataAt <= stallMs) return;
    stalled = true;
    proc.kill();
  });

  const pipeError = await pipeline(proc.stdout, splitter, extractor).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  // A reader that refused something leaves ssh with nobody reading it.
  if (pipeError) proc.kill();
  const exit = await proc.exited;
  clearInterval(timer);
  signal?.removeEventListener("abort", onAbort);
  proc.stdin.end();

  const report = extractor.report;
  const fail = (message: string): CopyBackResult => ({ ok: false, message, cancelled: false, report });
  if (cancelled) return { ok: false, message: "cancelled", cancelled: true, report };
  if (pipeError) return fail(pipeError instanceof TarProtocolError ? pipeError.message : `the transfer failed: ${pipeError.message}`);
  if (stalled) return fail(`nothing was transferred for ${Math.round(stallMs / 1000)} s`);
  if (splitter.head.includes(`@@cody-${token}-nodir`)) return fail("the job's directory is already gone on the worker");
  if (!splitter.found) {
    const failure = remoteFault(exit, "the copy-back command");
    return fail(failure.detail ? failure.detail : "the worker's answer had no results section");
  }
  // tar says 1 when a file changed while it was read: the archive is whole.
  if (exit.code !== 0 && exit.code !== 1) {
    const failure = remoteFault(exit, "tar");
    return fail(failure.detail);
  }
  const missing: string[] = [];
  for (const line of splitter.head.split("\n")) {
    const match = /^missing:(\d+)$/.exec(line.trim());
    const index = match ? Number.parseInt(match[1], 10) : -1;
    if (index >= 0 && index < paths.length) missing.push(paths[index]);
  }
  return { ok: true, ms: Date.now() - startedAt, report, missing };
}
