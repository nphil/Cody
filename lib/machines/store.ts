import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import {
  checkMachineDestination,
  checkMachineName,
  checkWorkerFacts,
  DEFAULT_LOCAL_MACHINE_NAME,
  LOCAL_MACHINE_ID,
  MAX_SSH_MACHINES,
  type MachineConfig,
  type MachineFieldCode,
  type MachinesUpdate,
  type WorkerFacts,
} from "./types";

/**
 * Which machines the top bar shows meters for.
 *
 * One small file in the instance data dir, beside the other Cody-level state
 * (`cody-forge.json`, `cody-engine.json`): the same install may switch engines
 * or accounts, and the list must survive both. It holds only names and ssh
 * destinations (an alias or `user@host`): key material never touches Cody, ssh
 * reads it from the person's own `~/.ssh`. Still written 0600 and atomically,
 * because a half-written file would take the whole list with it.
 *
 * The local server is always present. With no file on disk the list is just
 * that one entry, called "This server": a fresh install shows nothing of
 * anyone's network.
 */

const FILE_NAME = "cody-machines.json";

export function getMachinesConfigPath(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

interface StoredMachine {
  id: string;
  name: string;
  destination: string;
  /** Set only for a machine switched on as a worker. */
  worker?: true;
  /** The last good reading of the worker's own description; only with `worker`. */
  workerFacts?: WorkerFacts;
}

interface MachinesDocument {
  version: 1;
  localName: string;
  machines: StoredMachine[];
}

function emptyDocument(): MachinesDocument {
  return { version: 1, localName: DEFAULT_LOCAL_MACHINE_NAME, machines: [] };
}

/** The stored document. A missing or damaged file reads as "nothing
 * configured", and any entry that no longer passes the rules is skipped rather
 * than trusted: this runs before every sampler start, and a hand-edited file
 * must never reach `ssh`. */
function readDocument(): MachinesDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getMachinesConfigPath(), "utf8"));
  } catch {
    return emptyDocument();
  }
  if (!isRecord(parsed)) return emptyDocument();
  const document = emptyDocument();
  const localName = checkMachineName(parsed.localName);
  if (localName.ok) document.localName = localName.value;
  if (Array.isArray(parsed.machines)) {
    for (const entry of parsed.machines) {
      if (!isRecord(entry) || document.machines.length >= MAX_SSH_MACHINES) continue;
      const id = typeof entry.id === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(entry.id) ? entry.id : null;
      const name = checkMachineName(entry.name);
      const destination = checkMachineDestination(entry.destination);
      if (!id || !name.ok || !destination.ok || id === LOCAL_MACHINE_ID) continue;
      if (document.machines.some((existing) => existing.id === id)) continue;
      const stored: StoredMachine = { id, name: name.value, destination: destination.value };
      if (entry.worker === true) {
        stored.worker = true;
        const facts = checkWorkerFacts(entry.workerFacts);
        if (facts.ok) stored.workerFacts = facts.facts;
      }
      document.machines.push(stored);
    }
  }
  return document;
}

function writeDocument(document: MachinesDocument): void {
  const target = getMachinesConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Every machine, this server first. Destinations included: server side only. */
export function listMachineConfigs(): MachineConfig[] {
  const document = readDocument();
  return [
    { id: LOCAL_MACHINE_ID, kind: "local", name: document.localName },
    ...document.machines.map((machine): MachineConfig => ({
      id: machine.id,
      kind: "ssh",
      name: machine.name,
      destination: machine.destination,
      worker: machine.worker === true,
      ...(machine.worker ? { workerFacts: machine.workerFacts ?? null } : {}),
    })),
  ];
}

export type MachinesConfigCode =
  | MachineFieldCode
  | "invalid_request"
  | "machine_duplicate_name"
  | "machine_duplicate_destination"
  | "too_many_machines";

export class MachinesConfigError extends Error {
  constructor(readonly code: MachinesConfigCode, message: string) {
    super(message);
    this.name = "MachinesConfigError";
  }
}

export const MACHINE_FIELD_MESSAGES: Record<MachineFieldCode, string> = {
  machine_name_required: "A name is required",
  machine_name_too_long: "That name is too long",
  machine_name_invalid: "That name has characters that are not allowed",
  machine_destination_required: "An address is required",
  machine_destination_too_long: "That address is too long",
  machine_destination_invalid: "An address is a name from your SSH config, or user@host",
};

function failField(code: MachineFieldCode): never {
  throw new MachinesConfigError(code, MACHINE_FIELD_MESSAGES[code]);
}

/** Never reuse an id a removed machine had: an id someone still holds (an open
 * tab) must not silently start meaning a different machine. */
function mintId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `m-${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Apply an update and save it. All-or-nothing: every field is checked before
 * anything is written, and the first problem is thrown as a
 * {@link MachinesConfigError} with a stable code.
 */
export function updateMachinesConfig(update: MachinesUpdate): MachineConfig[] {
  const current = readDocument();
  const next: MachinesDocument = { version: 1, localName: current.localName, machines: [] };

  if (update.localName !== undefined) {
    const name = checkMachineName(update.localName);
    if (!name.ok) failField(name.code);
    next.localName = name.value;
  }

  if (update.machines !== undefined) {
    if (!Array.isArray(update.machines)) throw new MachinesConfigError("invalid_request", "machines must be a list");
    if (update.machines.length > MAX_SSH_MACHINES) {
      throw new MachinesConfigError("too_many_machines", `At most ${MAX_SSH_MACHINES + 1} machines can be shown`);
    }
    const knownMachines = new Map(current.machines.map((machine) => [machine.id, machine]));
    const taken = new Set<string>(knownMachines.keys());
    for (const entry of update.machines) {
      if (!isRecord(entry)) throw new MachinesConfigError("invalid_request", "Each machine needs a name and an address");
      const name = checkMachineName(entry.name);
      if (!name.ok) failField(name.code);
      const destination = checkMachineDestination(entry.destination);
      if (!destination.ok) failField(destination.code);
      if (entry.worker !== undefined && typeof entry.worker !== "boolean") {
        throw new MachinesConfigError("invalid_request", "worker must be true or false");
      }
      const requested = typeof entry.id === "string" ? entry.id : "";
      // An id is kept only for a machine that exists and is not already used by
      // an earlier entry in this list; anything else is a new machine.
      const before = knownMachines.get(requested);
      const reuse = before !== undefined && !next.machines.some((machine) => machine.id === requested);
      const id = reuse ? requested : mintId(taken);
      taken.add(id);
      const stored: StoredMachine = { id, name: name.value, destination: destination.value };
      // `worker` left out keeps the machine's setting. Facts describe one
      // machine at one address, so they stay only while both still hold.
      const worker = entry.worker ?? (reuse && before.worker === true);
      if (worker) {
        stored.worker = true;
        if (reuse && before.workerFacts && before.destination === destination.value) stored.workerFacts = before.workerFacts;
      }
      next.machines.push(stored);
    }
  } else {
    next.machines = current.machines;
  }

  const names = new Set<string>();
  const destinations = new Set<string>();
  for (const label of [next.localName, ...next.machines.map((machine) => machine.name)]) {
    const key = label.toLocaleLowerCase();
    if (names.has(key)) throw new MachinesConfigError("machine_duplicate_name", "Two machines have the same name");
    names.add(key);
  }
  for (const machine of next.machines) {
    const key = machine.destination.toLowerCase();
    if (destinations.has(key)) throw new MachinesConfigError("machine_duplicate_destination", "That address is already in the list");
    destinations.add(key);
  }

  writeDocument(next);
  return listMachineConfigs();
}

/** Remember what a check of a worker read. Written only while the machine
 * still exists, is still a worker and still points at `destination` (a check
 * that raced with an edit in Settings must not pin the old address's facts on
 * the new one), and only when it differs from what is saved, so the periodic
 * check does not rewrite the file every minute. */
export function saveWorkerFacts(id: string, destination: string, facts: WorkerFacts): void {
  const document = readDocument();
  const machine = document.machines.find((candidate) => candidate.id === id);
  if (!machine || machine.worker !== true || machine.destination !== destination) return;
  if (JSON.stringify(machine.workerFacts) === JSON.stringify(facts)) return;
  machine.workerFacts = facts;
  writeDocument(document);
}
