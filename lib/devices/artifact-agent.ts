/**
 * The page's half of an agent's "save these to the server".
 *
 * The files are in the person's browser, so an agent cannot save them itself: its
 * tool (./artifact-tools.ts) asks the page, the page resolves what was asked for
 * against the files it holds and starts the same save the "Save to server" button
 * starts (it appears in the Devices panel's transfers as the agent's), and answers
 * as soon as the server has accepted the save, with the archive it will become. The
 * upload then runs in the page; the agent reads its progress from the server.
 *
 * Only this chat's own files can be named: the page uses its own session id and the
 * server's routes check that the account can open that chat.
 */

import type { ArtifactSaveAck, ArtifactSaveSelection, DeviceArtifactSaveFrame } from "./protocol";
import type { DeviceArtifact, TransferJob } from "./artifact-model";
import type { SaveBegun } from "./artifact-upload";
import { effectiveSetName, shortArtifactName } from "./artifact-sets";
import { DeviceArtifactError } from "./artifact-model";
import { isRecord } from "../type-guards";

/** The part of the artifact store this needs, so a test can stand in for it. */
export interface AgentSaveStore {
  hydrate(sessionId: string): Promise<readonly DeviceArtifact[]>;
  list(sessionId: string): readonly DeviceArtifact[];
  startServerSave(
    sessionId: string,
    artifactIds: readonly string[],
    options: { label?: string; origin?: TransferJob["origin"] },
  ): { begun: Promise<SaveBegun>; finished: Promise<unknown> };
}

/** How many file names an error lists before it says "and N more". */
const LISTED_NAMES = 12;

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200) ? value : undefined;
}

/** The frame the server sent, or null when it is not one. Never trusts more than the selectors and a label. */
export function parseArtifactSaveFrame(raw: unknown): DeviceArtifactSaveFrame | null {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(payload) || payload.type !== "artifacts.save" || typeof payload.id !== "string" || !isRecord(payload.selection)) return null;
  const operationIds = stringList(payload.selection.operationIds);
  const fileIds = stringList(payload.selection.fileIds);
  const only = stringList(payload.selection.only);
  const set = typeof payload.selection.set === "string" && payload.selection.set.trim() ? payload.selection.set.trim().slice(0, 200) : undefined;
  const selection: ArtifactSaveSelection = {
    ...(operationIds ? { operationIds } : {}),
    ...(fileIds ? { fileIds } : {}),
    ...(payload.selection.all === true ? { all: true } : {}),
    ...(set ? { set } : {}),
    ...(only && only.length > 0 ? { only } : {}),
  };
  const label = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim().slice(0, 120) : undefined;
  return { type: "artifacts.save", id: payload.id, selection, ...(label ? { label } : {}) };
}

function listed(names: readonly string[]): string {
  return names.length > LISTED_NAMES ? `${names.slice(0, LISTED_NAMES).join(", ")}, and ${names.length - LISTED_NAMES} more` : names.join(", ");
}

/**
 * What a selection names, in the order the files were saved, or the reason it names nothing the agent can use. The
 * selectors (`operationIds`, `fileIds`, `set`, `all`) add files; `only` then keeps the files whose name, target or short
 * partition name ("boot_a" for "edl-1a2b3c-set-p12-boot_a.bin") equals one of its entries, and an entry that keeps
 * nothing is an error that lists it, so a misspelt partition is never silently left out of a backup.
 */
export function resolveSelection(artifacts: readonly DeviceArtifact[], selection: ArtifactSaveSelection): DeviceArtifact[] {
  const chosen = new Map<string, DeviceArtifact>();
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const missing: string[] = [];
  for (const operationId of selection.operationIds ?? []) {
    const made = artifacts.filter((artifact) => artifact.provenance?.operationId === operationId);
    if (made.length === 0) missing.push(`operation ${operationId}`);
    for (const artifact of made) chosen.set(artifact.id, artifact);
  }
  for (const fileId of selection.fileIds ?? []) {
    const artifact = byId.get(fileId);
    if (!artifact) missing.push(`file ${fileId}`);
    else chosen.set(artifact.id, artifact);
  }
  if (selection.set !== undefined) {
    const filed = artifacts.filter((artifact) => artifact.kind === "output" && effectiveSetName(artifact) === selection.set);
    if (filed.length === 0) missing.push(`set "${selection.set}"`);
    for (const artifact of filed) chosen.set(artifact.id, artifact);
  }
  if (selection.all) for (const artifact of artifacts) if (artifact.kind === "output") chosen.set(artifact.id, artifact);
  if (missing.length > 0) {
    throw new DeviceArtifactError(`Nothing saved in this chat matches ${missing.join(", ")}. The browser holds the files of operations that ran in this chat and finished; nothing was saved.`, "not-found");
  }
  if (chosen.size === 0) throw new DeviceArtifactError("This chat has no saved device files to save to the server yet.", "not-found");

  if (selection.only && selection.only.length > 0) {
    const wanted = new Set(selection.only);
    const matched = new Set<string>();
    const candidates = [...chosen.values()];
    for (const artifact of candidates) {
      const names = [artifact.name, artifact.provenance?.target, shortArtifactName(artifact.name)].filter((name): name is string => name !== undefined);
      const hits = names.filter((name) => wanted.has(name));
      if (hits.length === 0) chosen.delete(artifact.id);
      for (const hit of hits) matched.add(hit);
    }
    const unmatched = selection.only.filter((name) => !matched.has(name));
    if (unmatched.length > 0) {
      const known = [...new Set([...candidates].sort((left, right) => left.createdAt - right.createdAt).map((artifact) => shortArtifactName(artifact.name)))];
      throw new DeviceArtifactError(`None of the selected files is called ${listed(unmatched)}. Name a file as it was saved, or by its partition. The files selected so far are: ${listed(known)}. Nothing was saved.`, "not-found");
    }
  }
  return [...chosen.values()].sort((left, right) => left.createdAt - right.createdAt);
}

/**
 * The archive's label (its name is `<label>-<date>.zip`) for files an agent chose: the backup name they share, else the
 * device, protocol and command that made them, and "5 of 56" when they are one backup of chosen partitions, as the panel
 * names it, so a partial backup never looks like a whole one in a listing.
 */
function labelFor(files: readonly DeviceArtifact[]): string {
  const first = files[0]?.provenance;
  if (!first || files.some((file) => file.provenance?.operationId === undefined || file.provenance.deviceId !== first.deviceId || file.provenance.protocol !== first.protocol)) return "Device files";
  const names = new Set(files.map((file) => effectiveSetName(file)));
  const name = names.size === 1 ? [...names][0] : undefined;
  const base = name ?? [first.label, first.protocol.toUpperCase(), first.command ?? first.action].filter((part): part is string => Boolean(part)).join(" ");
  const operations = new Set(files.map((file) => file.provenance?.operationId));
  const scope = operations.size === 1 ? files.find((file) => file.provenance?.scope)?.provenance?.scope : undefined;
  return scope && scope.chosen.length < scope.all.length ? `${base} ${scope.chosen.length} of ${scope.all.length}` : base;
}

/**
 * Starts the save an agent asked for and returns once the server has accepted it. The upload and the packing carry on
 * in the page; a failure after this point is shown in the Devices panel and visible to the agent as a save that stops
 * growing or reports why packing failed.
 */
export async function runArtifactSave(store: AgentSaveStore, sessionId: string, frame: DeviceArtifactSaveFrame): Promise<ArtifactSaveAck> {
  await store.hydrate(sessionId);
  const files = resolveSelection(store.list(sessionId), frame.selection);
  const run = store.startServerSave(sessionId, files.map((file) => file.id), { label: frame.label ?? labelFor(files), origin: "agent" });
  run.finished.catch(() => undefined);
  const begun = await run.begun;
  return { saveId: begun.saveId, archive: begun.archive, files: begun.files, bytes: begun.bytes, resumed: begun.resumed, alreadySaved: begun.alreadySaved };
}
