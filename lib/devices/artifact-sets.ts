/**
 * Which files belong together. A backup of 58 partitions is one thing the
 * person did, not 58 things, so the panel lists SETS: everything one operation
 * saved, plus the operations of one burst on one device (an agent that dumps
 * partition after partition is still making one backup), plus everything an
 * agent filed under one name (`set`) or a person joined by hand.
 *
 * Pure and browser-safe, and computed from the artifacts alone: after a reload
 * there are no operation snapshots, only each file's recorded provenance.
 */

import type { ArtifactServerCopy, ArtifactSet, BackupScope, DeviceArtifact, SetSaveState } from "./artifact-model";

export type { ArtifactSet, SetSaveState } from "./artifact-model";

/**
 * Two runs of the same kind on one device with more quiet time between them than this are two sets. The quiet time is
 * measured from the END of the earlier run (its last file) to the START of the next (when its operation began, see
 * `estimatedStart`), so a read that takes ten minutes never splits a backup. It is the same two minutes the activity feed
 * folds routine commands over (activity-groups.ts); each file keeps its own constant so neither imports the other.
 */
export const SET_BURST_GAP_MS = 2 * 60_000;

/**
 * How fast a read is assumed to have gone for a file saved before the operation's start was recorded: one MiB a second, a
 * slow read over a USB cable to a flash chip. A file's read began about `size / rate` before the file was saved.
 */
export const ESTIMATED_READ_BYTES_PER_SECOND = 1024 * 1024;

/**
 * Files of a backup saved before provenance existed: each partition is read twice and only the first read is kept, so
 * they sit further apart than single dumps do. Their names say they belong together.
 */
const LEGACY_BACKUP_GAP_MS = 10 * 60_000;

/**
 * A name made up when a person combines sets none of which had one. It starts with a control character, which no agent's
 * `set` can contain, so it can never be mistaken for one and a card never shows it.
 */
const COMBINED_PREFIX = "\u0001combined-";

export function combinedSetName(token: string): string {
  return `${COMBINED_PREFIX}${token}`;
}

/** The set name a file is filed under, if any: a person's own filing wins over the name the agent gave. */
export function effectiveSetName(artifact: Pick<DeviceArtifact, "setName" | "provenance">): string | undefined {
  return artifact.setName ?? artifact.provenance?.set;
}

/**
 * When the work that made this file began: what the operation recorded, or, for a file saved before that was recorded,
 * its save time minus the time a read of its size would have taken.
 */
export function estimatedStart(artifact: DeviceArtifact): number {
  const recorded = artifact.provenance?.startedAt;
  if (recorded !== undefined) return Math.min(recorded, artifact.createdAt);
  return Math.floor(artifact.createdAt - (artifact.size / ESTIMATED_READ_BYTES_PER_SECOND) * 1000);
}

interface Kind {
  protocol?: string;
  action?: string;
  command?: string;
}

interface Group extends Kind {
  members: DeviceArtifact[];
  operationIds: string[];
  deviceId?: string;
  label?: string;
  name?: string;
  start: number;
  end: number;
  /** The scope each operation declared, by operation id. */
  scopes: Map<string, BackupScope>;
}

function byAge(left: DeviceArtifact, right: DeviceArtifact): number {
  return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function sameKind(group: Kind, other: Kind): boolean {
  return group.protocol === other.protocol && group.action === other.action && (group.command ?? "") === (other.command ?? "");
}

function join(group: Group, other: Group): void {
  group.members.push(...other.members);
  for (const id of other.operationIds) if (!group.operationIds.includes(id)) group.operationIds.push(id);
  for (const [id, scope] of other.scopes) if (!group.scopes.has(id)) group.scopes.set(id, scope);
  group.start = Math.min(group.start, other.start);
  group.end = Math.max(group.end, other.end);
  group.label ??= other.label;
}

const EDL_NAME = /^edl-([A-Za-z0-9_.]+)-(.+)$/;

/** What a file saved before provenance existed was, as far as its name says; same key + a small gap = one set. */
function legacyFamily(name: string): Kind & { key: string; gap: number } {
  const match = EDL_NAME.exec(name);
  if (!match) return { key: "device", gap: SET_BURST_GAP_MS };
  const [, unit, rest] = match as unknown as [string, string, string];
  if (rest.startsWith("set-")) return { key: `edl:${unit}:set`, gap: LEGACY_BACKUP_GAP_MS, protocol: "edl", action: "exec", command: "backup" };
  if (rest.startsWith("restore-")) return { key: `edl:${unit}:restore`, gap: LEGACY_BACKUP_GAP_MS, protocol: "edl", action: "exec", command: "restore" };
  return { key: `edl:${unit}`, gap: SET_BURST_GAP_MS, protocol: "edl", action: "dump" };
}

function kindOf(artifact: DeviceArtifact): Kind {
  const provenance = artifact.provenance;
  if (provenance) return { protocol: provenance.protocol, action: provenance.action, ...(provenance.command === undefined ? {} : { command: provenance.command }) };
  const { protocol, action, command } = legacyFamily(artifact.name);
  return { ...(protocol === undefined ? {} : { protocol }), ...(action === undefined ? {} : { action }), ...(command === undefined ? {} : { command }) };
}

/** What every one of these files was made by, or nothing where they differ: a set filed under one name may hold runs of many kinds. */
function commonKind(members: readonly DeviceArtifact[]): Kind {
  const [first, ...rest] = members.map(kindOf);
  const common: Kind = { ...first };
  for (const kind of rest) {
    if (common.protocol !== kind.protocol) delete common.protocol;
    if (common.action !== kind.action) delete common.action;
    if (common.command !== kind.command) delete common.command;
  }
  return common;
}

function finish(group: Group, legacy: boolean): ArtifactSet {
  const members = [...group.members].sort(byAge);
  const artifactIds = members.map((member) => member.id);
  // "5 of 56 partitions" is only true of a set that IS one backup: any other run in it (a dump of one more partition, say)
  // could hold partitions the backup did not, so a set of several operations makes no claim about partitions.
  const scopes = [...group.scopes.values()];
  const only = group.operationIds.length === 1 && scopes.length === 1 ? scopes[0]! : undefined;
  return {
    id: `set:${artifactIds[0]}`,
    ...(group.deviceId === undefined ? {} : { deviceId: group.deviceId }),
    ...(group.protocol === undefined ? {} : { protocol: group.protocol }),
    ...(group.action === undefined ? {} : { action: group.action }),
    ...(group.command === undefined ? {} : { command: group.command }),
    ...(group.label === undefined ? {} : { label: group.label }),
    ...(group.name === undefined || group.name.startsWith(COMBINED_PREFIX) ? {} : { name: group.name }),
    ...(only ? { scope: { chosen: only.chosen.length, total: only.all.length } } : {}),
    startedAt: group.start,
    endedAt: group.end,
    artifactIds,
    count: members.length,
    totalBytes: members.reduce((total, member) => total + member.size, 0),
    operationIds: group.operationIds,
    legacy,
  };
}

/**
 * The outputs of a session, grouped into sets, newest set first. Inputs (firmware the person added) are not sets.
 *
 * - Files filed under one NAME on one device (the agent's `set`, or the name a person's Combine gave them) are one set,
 *   whenever and with whatever command they were made.
 * - Otherwise an operation's files are one run. Consecutive runs on one device with the same protocol, action and command are one
 *   set when no more than SET_BURST_GAP_MS passes between the end of one (its last file) and the start of the next (when its
 *   operation began; estimated from the file's size for a file saved before that was recorded). A different kind of run on
 *   that device in between ends the set.
 * - Files with no provenance and no name are grouped by what their file names say (one EDL unit's backup, its restore copies,
 *   its other dumps) and by time, and the set says `legacy`.
 */
export function groupArtifactSets(artifacts: readonly DeviceArtifact[]): ArtifactSet[] {
  const runs = new Map<string, Group>();
  const named = new Map<string, DeviceArtifact[]>();
  const legacy: DeviceArtifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "output") continue;
    const provenance = artifact.provenance;
    const name = effectiveSetName(artifact);
    if (name !== undefined) {
      const key = `${provenance?.deviceId ?? ""}\u0000${name}`;
      named.set(key, [...(named.get(key) ?? []), artifact]);
      continue;
    }
    if (!provenance) {
      legacy.push(artifact);
      continue;
    }
    let run = runs.get(provenance.operationId);
    if (!run) {
      run = {
        members: [],
        operationIds: [provenance.operationId],
        deviceId: provenance.deviceId,
        protocol: provenance.protocol,
        action: provenance.action,
        ...(provenance.command === undefined ? {} : { command: provenance.command }),
        ...(provenance.label === undefined ? {} : { label: provenance.label }),
        start: estimatedStart(artifact),
        end: artifact.createdAt,
        scopes: new Map(),
      };
      runs.set(provenance.operationId, run);
    }
    run.members.push(artifact);
    run.start = Math.min(run.start, estimatedStart(artifact));
    run.end = Math.max(run.end, artifact.createdAt);
    if (provenance.scope && !run.scopes.has(provenance.operationId)) run.scopes.set(provenance.operationId, provenance.scope);
  }

  const sets: ArtifactSet[] = [];

  for (const members of named.values()) {
    const operationIds: string[] = [];
    const scopes = new Map<string, BackupScope>();
    let label: string | undefined;
    for (const member of members) {
      const provenance = member.provenance;
      if (!provenance) continue;
      if (!operationIds.includes(provenance.operationId)) operationIds.push(provenance.operationId);
      if (provenance.scope && !scopes.has(provenance.operationId)) scopes.set(provenance.operationId, provenance.scope);
      label ??= provenance.label;
    }
    const first = members[0]!;
    const deviceId = first.provenance?.deviceId;
    sets.push(finish({
      members,
      operationIds,
      ...commonKind(members),
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(label === undefined ? {} : { label }),
      name: effectiveSetName(first)!,
      start: Math.min(...members.map(estimatedStart)),
      end: Math.max(...members.map((member) => member.createdAt)),
      scopes,
    }, members.every((member) => !member.provenance)));
  }

  const open = new Map<string, Group>();
  for (const run of [...runs.values()].sort((left, right) => left.start - right.start || (left.operationIds[0]! < right.operationIds[0]! ? -1 : 1))) {
    const current = open.get(run.deviceId!);
    if (current && sameKind(current, run) && run.start - current.end <= SET_BURST_GAP_MS) {
      join(current, run);
      continue;
    }
    if (current) sets.push(finish(current, false));
    open.set(run.deviceId!, run);
  }
  for (const group of open.values()) sets.push(finish(group, false));

  const families = new Map<string, Group & { gap: number }>();
  for (const artifact of legacy.sort(byAge)) {
    const family = legacyFamily(artifact.name);
    const current = families.get(family.key);
    if (current && artifact.createdAt - current.end <= family.gap) {
      current.members.push(artifact);
      current.end = Math.max(current.end, artifact.createdAt);
      continue;
    }
    if (current) sets.push(finish(current, true));
    families.set(family.key, {
      members: [artifact],
      operationIds: [],
      ...(family.protocol === undefined ? {} : { protocol: family.protocol }),
      ...(family.action === undefined ? {} : { action: family.action }),
      ...(family.command === undefined ? {} : { command: family.command }),
      start: artifact.createdAt,
      end: artifact.createdAt,
      scopes: new Map(),
      gap: family.gap,
    });
  }
  for (const group of families.values()) sets.push(finish(group, true));

  return sets.sort((left, right) => right.endedAt - left.endedAt || right.startedAt - left.startedAt || (left.id < right.id ? -1 : 1));
}

/**
 * The next older set of the same device, which is what "Combine with the older backup" joins this one to; undefined when
 * there is none. `sets` is the list `groupArtifactSets` returned (newest first).
 */
export function olderSetOf(sets: readonly ArtifactSet[], set: ArtifactSet): ArtifactSet | undefined {
  let past = false;
  for (const candidate of sets) {
    if (candidate.id === set.id) {
      past = true;
      continue;
    }
    if (past && candidate.deviceId === set.deviceId) return candidate;
  }
  return undefined;
}

/** Whether the server holds the set, read off each member's `server` copy (see ArtifactServerCopy). */
export function setSaveState(set: ArtifactSet, artifacts: readonly DeviceArtifact[]): SetSaveState {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  let saved = 0;
  let verified = true;
  let newest: ArtifactServerCopy | undefined;
  const archives = new Map<string, ArtifactServerCopy>();
  for (const id of set.artifactIds) {
    const copy = byId.get(id)?.server;
    if (!copy) continue;
    saved += 1;
    verified = verified && copy.verified;
    archives.set(copy.archive, copy);
    if (!newest || copy.savedAt > newest.savedAt) newest = copy;
  }
  if (!newest) return { state: "none" };
  if (saved < set.artifactIds.length) return { state: "partial", saved, total: set.artifactIds.length };
  // The numbers are those of the archives that hold the set: normally one, the whole set packed into it.
  let bytes = 0;
  let archiveBytes = 0;
  for (const copy of archives.values()) {
    bytes += copy.originalBytes;
    archiveBytes += copy.archiveBytes;
  }
  return { state: "saved", path: newest.archive, savedAt: newest.savedAt, verified, files: set.artifactIds.length, bytes, archiveBytes, archives: archives.size };
}

/**
 * The part of an artifact's name a person reads: "edl-1a2b3c-set-p12-boot_a.bin" is "boot_a". The Qualcomm names carry
 * the unit and the kind of run before the partition; other protocols name their files themselves, and those are kept.
 */
export function shortArtifactName(name: string): string {
  const match = EDL_NAME.exec(name);
  if (!match) return name;
  const rest = match[2]!;
  const partition = /^set-p\d+-(.+)\.bin$/.exec(rest);
  if (partition) return partition[1]!;
  const table = /^set-(gpt-(?:primary|backup))\.bin$/.exec(rest);
  if (table) return table[1]!;
  if (/^set-[0-9a-f]+\.manifest\.json$/.test(rest)) return "manifest.json";
  const before = /^restore-[0-9a-f]+-(.+)\.pre\.bin$/.exec(rest);
  if (before) return `${before[1]}.pre`;
  const dump = /^(.+?)\.bin$/.exec(rest);
  return dump ? dump[1]! : rest;
}

/**
 * What a set is called in a file name, a folder name and a save's label: the name an agent gave it, else its device,
 * protocol and command ("Lenovo QUSB__BULK EDL backup"); a backup of chosen partitions adds "5 of 56" so a partial one
 * never looks like a full one in a file listing.
 */
export function setFileLabel(set: ArtifactSet): string {
  const base = set.name ?? ([set.label, set.protocol?.toUpperCase(), set.command ?? set.action].filter((part): part is string => Boolean(part)).join(" ") || "Device files");
  return set.scope && set.scope.chosen < set.scope.total ? `${base} ${set.scope.chosen} of ${set.scope.total}` : base;
}
