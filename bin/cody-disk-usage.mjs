#!/usr/bin/env node
/**
 * Disk usage scan for Settings › System › Disk space › "What is using space".
 *
 * Run as its own low-priority process (`nice` + `ionice`, started by
 * lib/disk/usage.ts), never inside the Cody server: a full walk of a 176 GB
 * home takes minutes and would stall every chat's file reads.
 *
 *   node bin/cody-disk-usage.mjs scan --spec '<json>' --out <file> --partial <file>
 *   node bin/cody-disk-usage.mjs measure <path>
 *
 * `scan` walks each root in the spec, lstat only (a link is never followed, a
 * folder on another device is never entered, file CONTENTS are never read),
 * and keeps a pruned tree: the biggest few entries per level a few levels
 * deep, the rest folded into "other". It also lists build-output candidates
 * (folders whose NAME is in the spec) anywhere in the walk, with the marker
 * files that sit next to and inside them, so the server can decide what they
 * are without a second walk. Sizes are ALLOCATED bytes (blocks x 512, like
 * `du`), which is what a full disk is made of.
 *
 * Progress is written atomically to `--partial` every few seconds (the top
 * level folders finished so far); the finished result goes to `--out` and the
 * partial file is removed. `measure` prints one JSON line for one path.
 */
import fs from "node:fs";
import path from "node:path";

const IO_LIMIT = 12;
const LSTAT_BATCH = 64;
const FLUSH_MS = 4_000;
const DEFAULT_DEADLINE_MS = 45 * 60_000;
const MAX_LINKED_TRACKED = 1_000_000;

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const flags = new Map();
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index].startsWith("--")) flags.set(rest[index].slice(2), rest[++index]);
    else positional.push(rest[index]);
  }
  return { mode, flags, positional };
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

let ioActive = 0;
const ioQueue = [];
/** At most IO_LIMIT file-system calls in flight, so the walk never floods the libuv pool. */
function io(call) {
  return new Promise((resolve, reject) => {
    const run = () => {
      ioActive += 1;
      call().then(resolve, reject).finally(() => {
        ioActive -= 1;
        ioQueue.shift()?.();
      });
    };
    if (ioActive < IO_LIMIT) run();
    else ioQueue.push(run);
  });
}

function writeAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** One walk: `spec` says what to keep; `state` collects what it saw. */
function createWalker(spec, state) {
  const markers = new Set(spec.markers ?? []);
  const candidateNames = new Set(spec.candidates ?? []);
  const levels = spec.levels ?? [];
  const minBytes = spec.minBytes ?? 0;
  const maxCandidates = spec.maxCandidates ?? 0;
  const linked = new Set();

  const keepTop = (kids, depth) => {
    kids.sort((a, b) => b.bytes - a.bytes);
    const limit = levels[depth] ?? 0;
    const kept = kids.slice(0, limit);
    let otherBytes = 0;
    let otherCount = 0;
    for (const dropped of kids.slice(limit)) {
      otherBytes += dropped.bytes;
      otherCount += 1;
    }
    return { kept, otherBytes, otherCount };
  };

  /** Size and newest change of everything beneath `dir`; `node` is the pruned tree when `depth` is within `levels`. */
  async function walkDir(dir, depth, insideCandidate, onTopChild) {
    const empty = { bytes: 0, entries: 0, changedMs: 0, newestMs: 0, marks: [], kids: [] };
    if (state.stopped) {
      state.complete = false;
      return empty;
    }
    let names;
    try {
      names = await io(() => fs.promises.readdir(dir));
    } catch (error) {
      if (!isMissing(error)) state.complete = false;
      return empty;
    }
    const result = { bytes: 0, entries: 0, changedMs: 0, newestMs: 0, marks: names.filter((name) => markers.has(name)), kids: [] };
    let smallBytes = 0;
    let smallCount = 0;
    const dirs = [];

    for (let from = 0; from < names.length; from += LSTAT_BATCH) {
      if (state.stopped) {
        state.complete = false;
        break;
      }
      const batch = names.slice(from, from + LSTAT_BATCH);
      const stats = await Promise.all(batch.map((name) => io(() => fs.promises.lstat(path.join(dir, name))).then(
        (stat) => ({ name, stat }),
        (error) => {
          if (!isMissing(error)) state.complete = false;
          return null;
        },
      )));
      for (const item of stats) {
        if (!item) continue;
        const { name, stat } = item;
        state.entries += 1;
        result.entries += 1;
        result.changedMs = Math.max(result.changedMs, stat.mtimeMs);
        result.newestMs = Math.max(result.newestMs, stat.mtimeMs, stat.ctimeMs);
        if (stat.isDirectory()) {
          if (stat.dev !== state.rootDev) {
            state.crossedDevice = true;
            continue;
          }
          const own = stat.blocks * 512;
          result.bytes += own;
          state.bytes += own;
          dirs.push({ name, own });
          continue;
        }
        let size = stat.blocks * 512;
        if (stat.nlink > 1) {
          const key = `${stat.dev}:${stat.ino}`;
          if (linked.has(key)) size = 0;
          else if (linked.size < MAX_LINKED_TRACKED) linked.add(key);
        }
        result.bytes += size;
        state.bytes += size;
        if (depth < levels.length && size >= Math.max(minBytes, 1)) {
          result.kids.push({ name, bytes: size, changedMs: stat.mtimeMs, dir: false });
        } else {
          smallBytes += size;
          smallCount += 1;
        }
      }
    }

    const children = await Promise.all(dirs.map(async ({ name, own }) => {
      const full = path.join(dir, name);
      const candidate = !insideCandidate && candidateNames.has(name);
      const sub = await walkDir(full, depth + 1, insideCandidate || candidate, undefined);
      const bytes = sub.bytes + own;
      result.bytes += sub.bytes;
      result.entries += sub.entries;
      result.changedMs = Math.max(result.changedMs, sub.changedMs);
      result.newestMs = Math.max(result.newestMs, sub.newestMs);
      if (candidate && maxCandidates > 0) {
        state.candidates.push({ path: full, bytes, mtimeMs: sub.changedMs, marks: sub.marks, parentMarks: result.marks });
        if (state.candidates.length > maxCandidates * 2) {
          state.candidates.sort((a, b) => b.bytes - a.bytes);
          state.candidates.length = maxCandidates;
        }
      }
      const node = { name, bytes, changedMs: sub.changedMs, dir: true, marks: sub.marks, entries: sub.entries };
      if (depth + 1 < levels.length && sub.kids.length > 0) {
        const pruned = keepTop(sub.kids, depth + 1);
        node.children = pruned.kept;
        node.otherBytes = pruned.otherBytes + sub.smallBytes;
        node.otherCount = pruned.otherCount + sub.smallCount;
      } else if (depth + 1 < levels.length) {
        node.otherBytes = sub.smallBytes;
        node.otherCount = sub.smallCount;
      }
      if (onTopChild) onTopChild(node);
      return node;
    }));

    for (const child of children) {
      if (child.bytes >= minBytes && depth < levels.length) result.kids.push(child);
      else {
        smallBytes += child.bytes;
        smallCount += 1;
      }
    }
    result.smallBytes = smallBytes;
    result.smallCount = smallCount;
    return result;
  }

  return { walkDir, keepTop };
}

async function runScan(flags) {
  const spec = JSON.parse(flags.get("spec") ?? "{}");
  const out = flags.get("out");
  const partialFile = flags.get("partial");
  if (!out || !partialFile || !Array.isArray(spec.roots)) {
    console.error("scan needs --spec (with roots), --out and --partial");
    process.exit(2);
  }
  const startedAt = Date.now();
  const state = {
    stopped: false,
    stopReason: null,
    complete: true,
    crossedDevice: false,
    entries: 0,
    bytes: 0,
    rootDev: 0,
    candidates: [],
  };
  const { walkDir, keepTop } = createWalker(spec, state);
  const roots = spec.roots.map((root) => ({ path: root.path, label: root.label, done: [], doneBytes: 0, node: null }));

  const snapshot = (finished) => ({
    version: 1,
    volume: spec.volume,
    startedAt,
    finishedAt: finished ? Date.now() : null,
    complete: finished ? state.complete : false,
    reason: state.stopReason ?? undefined,
    entries: state.entries,
    scannedBytes: state.bytes,
    roots: roots.map((root) => {
      if (root.node) return { path: root.path, label: root.label, node: root.node };
      const pruned = keepTop([...root.done], 0);
      return {
        path: root.path,
        label: root.label,
        node: { name: root.path, bytes: root.doneBytes, changedMs: 0, dir: true, children: pruned.kept, otherBytes: pruned.otherBytes, otherCount: pruned.otherCount },
      };
    }),
    rebuildable: [...state.candidates].sort((a, b) => b.bytes - a.bytes).slice(0, spec.maxCandidates ?? 0),
  });

  const flush = () => {
    try {
      writeAtomic(partialFile, snapshot(false));
    } catch {
      // A full disk must not kill the scan; the next tick tries again.
    }
  };
  const timer = setInterval(flush, FLUSH_MS);
  const deadline = setTimeout(() => {
    state.stopped = true;
    state.stopReason ??= "time";
  }, spec.deadlineMs ?? DEFAULT_DEADLINE_MS);
  process.on("SIGTERM", () => {
    state.stopped = true;
    state.stopReason = "cancelled";
  });
  flush();

  for (const root of roots) {
    let top;
    try {
      top = await fs.promises.lstat(root.path);
    } catch {
      continue;
    }
    if (!top.isDirectory()) continue;
    state.rootDev = top.dev;
    const result = await walkDir(root.path, 0, false, (node) => {
      root.done.push(node);
      root.doneBytes += node.bytes;
    });
    const pruned = keepTop(result.kids, 0);
    root.node = {
      name: root.path,
      bytes: result.bytes + top.blocks * 512,
      changedMs: result.changedMs,
      dir: true,
      marks: result.marks,
      children: pruned.kept,
      otherBytes: pruned.otherBytes + (result.smallBytes ?? 0),
      otherCount: pruned.otherCount + (result.smallCount ?? 0),
    };
  }
  clearInterval(timer);
  clearTimeout(deadline);

  if (state.stopReason === "cancelled") {
    fs.rmSync(partialFile, { force: true });
    return;
  }
  writeAtomic(out, snapshot(true));
  fs.rmSync(partialFile, { force: true });
}

async function runMeasure(target) {
  const state = { stopped: false, complete: true, crossedDevice: false, entries: 0, bytes: 0, rootDev: 0, candidates: [] };
  const answer = (extra) => process.stdout.write(`${JSON.stringify({ bytes: 0, entries: 0, newestMs: 0, changedMs: 0, ...extra })}\n`);
  let top;
  try {
    top = await fs.promises.lstat(target);
  } catch (error) {
    answer({ complete: isMissing(error), missing: isMissing(error), crossedDevice: false });
    return;
  }
  state.rootDev = top.dev;
  if (!top.isDirectory()) {
    answer({ bytes: top.blocks * 512, entries: 1, newestMs: Math.max(top.mtimeMs, top.ctimeMs), changedMs: top.mtimeMs, complete: true, crossedDevice: false });
    return;
  }
  const { walkDir } = createWalker({}, state);
  const result = await walkDir(target, 0, false, undefined);
  answer({
    bytes: result.bytes + top.blocks * 512,
    entries: result.entries + 1,
    newestMs: Math.max(result.newestMs, top.mtimeMs, top.ctimeMs),
    changedMs: Math.max(result.changedMs, top.mtimeMs),
    complete: state.complete,
    crossedDevice: state.crossedDevice,
  });
}

const { mode, flags, positional } = parseArgs(process.argv.slice(2));
if (mode === "scan") await runScan(flags);
else if (mode === "measure" && positional[0]) await runMeasure(positional[0]);
else {
  console.error("usage: cody-disk-usage.mjs scan --spec <json> --out <file> --partial <file> | measure <path>");
  process.exit(2);
}
