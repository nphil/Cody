// Loaded by omp itself (Bun), not by Cody's bundler: keep this file free of
// Cody imports so it resolves from any install location. lib/omp/agent-switch.ts
// writes the file this reads; lib/omp/agent-switch.test.mjs runs the two
// against each other so the format cannot drift.
//
// When the person moves a running helper to another model from Cody's helper
// window, Cody stops that helper, tells the main agent to start it again, and
// leaves a one-shot entry in the chat's scratch folder. omp announces every
// helper just before it starts (`before_subagent_spawn`) and lets an extension
// name the model: the next helper of that kind gets the chosen one, once.
// Nothing else changes, so no setting is touched. It registers no tool_call or
// tool_result handler on purpose: any such handler switches off omp's
// speculative launch of tool calls.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** lib/omp/agent-switch.ts SWITCH_FILE: kept in the chat's scratch folder, so it goes away with the chat. */
const SWITCH_FILE = "cody-agent-switch.json";

export interface PendingSwitch {
  id: string;
  /** The kind of helper that was moved, as omp names it (`deep-task`). */
  agent: string;
  /** The id of the helper that was stopped: a restart that reuses its name is matched first. */
  helper: string;
  /** A role alias (`@slow`) or one `provider/model`. */
  model: string;
  /** What omp shows beside the helper. */
  note: string;
  /** Epoch milliseconds: the entry is dropped after this. */
  expiresAt: number;
}

type SpawnEvent = { agent?: unknown; spawnKey?: unknown };
type SpawnAnswer = { model: string; note: string };

type OmpApi = {
  on(event: "before_subagent_spawn", handler: (event: SpawnEvent) => SpawnAnswer | undefined): void;
};

export interface SwitchDeps {
  /** The file's parsed JSON, or undefined when there is none. */
  read(): unknown;
  write(entries: PendingSwitch[]): void;
  now(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entries of a parsed file; anything malformed is dropped. */
export function readSwitches(raw: unknown): PendingSwitch[] {
  const list: unknown[] = isRecord(raw) && Array.isArray(raw.switches) ? raw.switches : [];
  return list.flatMap((item): PendingSwitch[] => {
    if (!isRecord(item)) return [];
    const { id, agent, helper, model, note, expiresAt } = item;
    if (typeof id !== "string" || typeof agent !== "string" || typeof helper !== "string") return [];
    if (typeof model !== "string" || model.trim() === "" || typeof note !== "string" || typeof expiresAt !== "number") return [];
    return [{ id, agent, helper, model, note, expiresAt }];
  });
}

/** `DbHealth-2` and `parent.DbHealth` both name the helper "DbHealth": omp adds a number to a name already taken, and a prefix inside a helper's own helpers. */
function helperStem(id: string): string {
  return id.slice(id.lastIndexOf(".") + 1).replace(/-\d+$/, "");
}

/**
 * The entry for a helper about to start, and the entries left. A helper of the
 * moved kind that reuses the stopped one's name wins; otherwise the oldest
 * entry of that kind does. Expired entries are gone either way.
 */
export function takeSwitch(entries: readonly PendingSwitch[], event: SpawnEvent, now: number): { chosen: PendingSwitch | null; rest: PendingSwitch[] } {
  const live = entries.filter((entry) => entry.expiresAt > now);
  const agent = typeof event.agent === "string" ? event.agent : "";
  const stem = typeof event.spawnKey === "string" ? helperStem(event.spawnKey) : "";
  const ofKind = live.filter((entry) => entry.agent === agent);
  const chosen = ofKind.find((entry) => stem !== "" && helperStem(entry.helper) === stem) ?? ofKind[0] ?? null;
  return { chosen, rest: live.filter((entry) => entry !== chosen) };
}

export function createAgentSwitch(deps: SwitchDeps): (pi: OmpApi) => void {
  return (pi) => {
    pi.on("before_subagent_spawn", (event) => {
      let entries: PendingSwitch[];
      try {
        entries = readSwitches(deps.read());
      } catch {
        return undefined;
      }
      if (entries.length === 0) return undefined;
      const { chosen, rest } = takeSwitch(entries, event, deps.now());
      // Taken (and expired) entries are removed so a second helper of the kind starts on its own model; a failed write must not stop this one.
      if (rest.length !== entries.length) {
        try {
          deps.write(rest);
        } catch {
          // The entry stays until it expires.
        }
      }
      return chosen ? { model: chosen.model, note: chosen.note } : undefined;
    });
  };
}

function switchPath(): string | null {
  const dir = process.env.CODY_SCRATCH;
  return dir ? join(dir, SWITCH_FILE) : null;
}

export default createAgentSwitch({
  read() {
    const path = switchPath();
    if (path === null) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  },
  write(entries) {
    const path = switchPath();
    if (path === null) return;
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, switches: entries }));
    renameSync(temp, path);
  },
  now: () => Date.now(),
});
