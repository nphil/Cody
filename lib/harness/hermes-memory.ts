import { readFileSync, statSync } from "fs";
import { join } from "path";
import type { MemoryDocument } from "./types";

/**
 * Hermes' built-in memory, as documents to read.
 *
 * Hermes keeps two markdown files under `$HERMES_HOME/memories/` and edits
 * them itself as it works. `hermes memory` is NOT the way in — despite the
 * name it only configures an optional external provider (honcho, mem0,
 * hindsight, …) and has no list or show subcommand. The built-in files are
 * always active regardless of that setting, and they are plain markdown, so
 * reading them directly is both the simplest and the only complete answer.
 *
 * Read-only by design (see HarnessAdapter.readMemory). These are the agent's
 * own notes; Cody shows them rather than owning them.
 */

/** Bytes of one memory file Cody will read into a response. Memory grows
 * unbounded across sessions, and a panel is not a file editor: past this the
 * content is truncated with a note pointing at the path on disk. */
const MAX_MEMORY_BYTES = 256 * 1024;

interface MemoryFileSpec {
  id: string;
  file: string;
  label: string;
  description: string;
}

/** The two files Hermes maintains. Descriptions are Hermes' own, from
 * `tools/memory_tool.py`, rather than Cody's guess at what they hold. */
const MEMORY_FILES: MemoryFileSpec[] = [
  {
    id: "memory",
    file: "MEMORY.md",
    label: "Agent memory",
    description: "The agent's own notes and observations — environment facts, project details, things it learned while working.",
  },
  {
    id: "user",
    file: "USER.md",
    label: "What it knows about you",
    description: "What the agent has recorded about you: preferences, communication style, how you like to work.",
  },
];

/** Hermes' memory directory. Profile-scoped, like the rest of its home. */
export function hermesMemoryDir(hermesHome: string): string {
  return join(hermesHome, "memories");
}

/**
 * Read one memory file. A missing file is the normal state of a fresh
 * install, so it comes back as an empty document rather than an error — the
 * panel then says the agent has not written anything yet, which is true and
 * useful, where an error would read as a broken engine.
 */
export function readMemoryDocument(dir: string, spec: MemoryFileSpec): MemoryDocument {
  const path = join(dir, spec.file);
  const base = { id: spec.id, label: spec.label, description: spec.description, path };
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { ...base, content: "", exists: false };
  }
  try {
    if (size <= MAX_MEMORY_BYTES) {
      return { ...base, content: readFileSync(path, "utf8"), exists: true };
    }
    // The TAIL, not the head: memory accretes, so the newest entries — the
    // ones a user is looking for after a session — are at the end.
    const buffer = readFileSync(path);
    const tail = buffer.subarray(buffer.length - MAX_MEMORY_BYTES).toString("utf8");
    return {
      ...base,
      content: `…truncated — showing the last ${Math.round(MAX_MEMORY_BYTES / 1024)} KB of ${path}\n\n${tail}`,
      exists: true,
    };
  } catch {
    // Readable by stat but not by read: a permissions problem on the host,
    // which the empty document plus the visible path lets the user diagnose.
    return { ...base, content: "", exists: false };
  }
}

/** Every memory document Hermes maintains, in the order worth reading. */
export function readHermesMemory(hermesHome: string): MemoryDocument[] {
  const dir = hermesMemoryDir(hermesHome);
  return MEMORY_FILES.map((spec) => readMemoryDocument(dir, spec));
}
