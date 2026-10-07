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
import { effectiveSetName, groupArtifactSets, selectionLabel, setFileLabel, shortArtifactName } from "./artifact-sets";
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

const MAX_NAME_CHARS = 200;

/** The names in a list, or what is wrong with it: a list with one bad entry is refused whole, never used without that entry (which could widen the save). */
function nameList(value: unknown, field: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be a list of names.`;
  for (const [position, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_NAME_CHARS) return `${field}[${position}] must be a name of 1 to ${MAX_NAME_CHARS} characters.`;
  }
  return value as string[];
}

/** A save frame whose selection could not be read: the agent is told why instead of getting a wider save than it asked for. */
export interface RefusedArtifactSaveFrame {
  type: "artifacts.save";
  id: string;
  refused: string;
}

/** The frame the server sent, null when it is not one, or the reason its selection is refused. Never trusts more than the selectors and a label. */
export function parseArtifactSaveFrame(raw: unknown): DeviceArtifactSaveFrame | RefusedArtifactSaveFrame | null {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(payload) || payload.type !== "artifacts.save" || typeof payload.id !== "string" || !isRecord(payload.selection)) return null;
  const operationIds = nameList(payload.selection.operationIds, "operationIds");
  if (typeof operationIds === "string") return { type: "artifacts.save", id: payload.id, refused: `${operationIds} Nothing was saved.` };
  const fileIds = nameList(payload.selection.fileIds, "fileIds");
  if (typeof fileIds === "string") return { type: "artifacts.save", id: payload.id, refused: `${fileIds} Nothing was saved.` };
  const only = nameList(payload.selection.only, "files");
  if (typeof only === "string") return { type: "artifacts.save", id: payload.id, refused: `${only} Nothing was saved.` };
  const set = typeof payload.selection.set === "string" && payload.selection.set.trim() ? payload.selection.set.trim().slice(0, MAX_NAME_CHARS) : undefined;
  const selection: ArtifactSaveSelection = {
    ...(operationIds.length > 0 ? { operationIds } : {}),
    ...(fileIds.length > 0 ? { fileIds } : {}),
    ...(payload.selection.all === true ? { all: true } : {}),
    ...(set ? { set } : {}),
    ...(only.length > 0 ? { only } : {}),
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
    // A name is one backup per DEVICE (the panel shows one card per device under it): two devices' files under one name are two backups, never one zip.
    const devices = new Map<string | undefined, string>();
    for (const artifact of filed) devices.set(artifact.provenance?.deviceId, artifact.provenance?.label ?? artifact.provenance?.deviceId ?? "a device without a record of which");
    if (devices.size > 1) {
      throw new DeviceArtifactError(`"${selection.set}" names a backup on ${devices.size} devices (${[...devices.values()].join(", ")}), and a save is one device's. Name the operations of one of them with operationIds, or save them one device at a time. Nothing was saved.`, "not-found");
    }
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
 * The archive's label (its name is `<label>-<date>.zip`) for files an agent chose, as the panel names the same files:
 * the card they are on, with "5 of 56" or "incomplete" where the card says so and "(N files)" when they are only some
 * of it, so a partial, unfinished or trimmed backup never looks like a whole one in a listing. Files off several cards
 * get a plain name that claims nothing. A name a person's Combine made up is never used: no card shows it either.
 */
function labelFor(artifacts: readonly DeviceArtifact[], files: readonly DeviceArtifact[]): string {
  const chosen = new Set(files.map((file) => file.id));
  const sets = groupArtifactSets(artifacts).filter((set) => set.artifactIds.some((id) => chosen.has(id)));
  const set = sets.length === 1 ? sets[0] : undefined;
  if (set) {
    const onCard = files.filter((file) => set.artifactIds.includes(file.id)).length;
    return onCard === set.count && onCard === files.length ? setFileLabel(set) : selectionLabel(set, files.length);
  }
  const first = files[0]?.provenance;
  if (!first || files.some((file) => !file.provenance || file.provenance.deviceId !== first.deviceId || file.provenance.protocol !== first.protocol)) return "Device files";
  return [first.label, first.protocol.toUpperCase(), "files"].filter((part): part is string => Boolean(part)).join(" ");
}

/**
 * Starts the save an agent asked for and returns once the server has accepted it. The upload and the packing carry on
 * in the page; a failure after this point is shown in the Devices panel and visible to the agent as a save that stops
 * growing or reports why packing failed.
 */
export async function runArtifactSave(store: AgentSaveStore, sessionId: string, frame: DeviceArtifactSaveFrame): Promise<ArtifactSaveAck> {
  await store.hydrate(sessionId);
  const artifacts = store.list(sessionId);
  const files = resolveSelection(artifacts, frame.selection);
  const run = store.startServerSave(sessionId, files.map((file) => file.id), { label: frame.label ?? labelFor(artifacts, files), origin: "agent" });
  run.finished.catch(() => undefined);
  const begun = await run.begun;
  return { saveId: begun.saveId, archive: begun.archive, files: begun.files, bytes: begun.bytes, resumed: begun.resumed, alreadySaved: begun.alreadySaved };
}
