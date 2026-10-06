/**
 * Which files belong together. A backup of 58 partitions is one thing the
 * person did, not 58 things, so the panel lists SETS: everything one operation
 * saved, plus the operations of one burst on one device (an agent that dumps
 * partition after partition is still making one backup).
 *
 * Pure and browser-safe, and computed from the artifacts alone: after a reload
 * there are no operation snapshots, only each file's recorded provenance.
 */

import type { ArtifactServerCopy, ArtifactSet, DeviceArtifact, SetSaveState } from "./artifact-model";

export type { ArtifactSet, SetSaveState } from "./artifact-model";

/**
 * Two runs of the same kind on one device further apart than this are two sets. It is the same two minutes the
 * activity feed folds routine commands over (activity-groups.ts); each file keeps its own constant so neither
 * imports the other.
 */
export const SET_BURST_GAP_MS = 2 * 60_000;

/**
 * Files of a backup saved before provenance existed: each partition is read twice and only the first read is kept, so
 * they sit further apart than single dumps do. Their names say they belong together.
 */
const LEGACY_BACKUP_GAP_MS = 10 * 60_000;

interface Group {
  members: DeviceArtifact[];
  operationIds: string[];
  deviceId?: string;
  protocol?: string;
  action?: string;
  command?: string;
  label?: string;
  start: number;
  end: number;
}

function byAge(left: DeviceArtifact, right: DeviceArtifact): number {
  return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function sameKind(group: Group, other: Group): boolean {
  return group.protocol === other.protocol && group.action === other.action && (group.command ?? "") === (other.command ?? "");
}

function join(group: Group, other: Group): void {
  group.members.push(...other.members);
  for (const id of other.operationIds) if (!group.operationIds.includes(id)) group.operationIds.push(id);
  group.start = Math.min(group.start, other.start);
  group.end = Math.max(group.end, other.end);
  group.label ??= other.label;
}

const EDL_NAME = /^edl-([A-Za-z0-9_.]+)-(.+)$/;

/** What a file saved before provenance existed was, as far as its name says; same key + a small gap = one set. */
function legacyFamily(name: string): { key: string; gap: number; protocol?: string; action?: string; command?: string } {
  const match = EDL_NAME.exec(name);
  if (!match) return { key: "device", gap: SET_BURST_GAP_MS };
  const [, unit, rest] = match as unknown as [string, string, string];
  if (rest.startsWith("set-")) return { key: `edl:${unit}:set`, gap: LEGACY_BACKUP_GAP_MS, protocol: "edl", action: "exec", command: "backup" };
  if (rest.startsWith("restore-")) return { key: `edl:${unit}:restore`, gap: LEGACY_BACKUP_GAP_MS, protocol: "edl", action: "exec", command: "restore" };
  return { key: `edl:${unit}`, gap: SET_BURST_GAP_MS, protocol: "edl", action: "dump" };
}

function finish(group: Group, legacy: boolean): ArtifactSet {
  const members = [...group.members].sort(byAge);
  const artifactIds = members.map((member) => member.id);
  return {
    id: `set:${artifactIds[0]}`,
    ...(group.deviceId === undefined ? {} : { deviceId: group.deviceId }),
    ...(group.protocol === undefined ? {} : { protocol: group.protocol }),
    ...(group.action === undefined ? {} : { action: group.action }),
    ...(group.command === undefined ? {} : { command: group.command }),
    ...(group.label === undefined ? {} : { label: group.label }),
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
 * - An operation's files are one run. Consecutive runs on one device with the same protocol, action and command, no
 *   more than SET_BURST_GAP_MS apart, are one set; a different kind of run on that device in between ends it.
 * - Files with no provenance are grouped by what their names say (one EDL unit's backup, its restore copies, its other
 *   dumps) and by time, and the set says `legacy`.
 */
export function groupArtifactSets(artifacts: readonly DeviceArtifact[]): ArtifactSet[] {
  const runs = new Map<string, Group>();
  const legacy: DeviceArtifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "output") continue;
    const provenance = artifact.provenance;
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
        start: artifact.createdAt,
        end: artifact.createdAt,
      };
      runs.set(provenance.operationId, run);
    }
    run.members.push(artifact);
    run.start = Math.min(run.start, artifact.createdAt);
    run.end = Math.max(run.end, artifact.createdAt);
  }

  const sets: ArtifactSet[] = [];
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
      gap: family.gap,
    });
  }
  for (const group of families.values()) sets.push(finish(group, true));

  return sets.sort((left, right) => right.endedAt - left.endedAt || right.startedAt - left.startedAt || (left.id < right.id ? -1 : 1));
}

/** Whether the server holds the set, read off each member's `server` copy (see ArtifactServerCopy). */
export function setSaveState(set: ArtifactSet, artifacts: readonly DeviceArtifact[]): SetSaveState {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  let saved = 0;
  let verified = true;
  let newest: ArtifactServerCopy | undefined;
  for (const id of set.artifactIds) {
    const copy = byId.get(id)?.server;
    if (!copy) continue;
    saved += 1;
    verified = verified && copy.verified;
    if (!newest || copy.savedAt > newest.savedAt) newest = copy;
  }
  if (!newest) return { state: "none" };
  if (saved < set.artifactIds.length) return { state: "partial", saved, total: set.artifactIds.length };
  return { state: "saved", path: newest.folder, savedAt: newest.savedAt, verified, files: set.artifactIds.length, bytes: set.totalBytes };
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
