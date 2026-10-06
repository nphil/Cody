/**
 * The page's half of an agent's "save these to the server".
 *
 * The files are in the person's browser, so an agent cannot save them itself: its
 * tool (./artifact-tools.ts) asks the page, the page resolves what was asked for
 * against the files it holds and starts the same save the "Save to server" button
 * starts (it appears in the Devices panel's transfers as the agent's), and answers
 * as soon as the server has accepted the save, with the folder it will be in. The
 * upload then runs in the page; the agent reads its progress from the server.
 *
 * Only this chat's own files can be named: the page uses its own session id and the
 * server's routes check that the account can open that chat.
 */

import type { ArtifactSaveAck, ArtifactSaveSelection, DeviceArtifactSaveFrame } from "./protocol";
import type { DeviceArtifact, TransferJob } from "./artifact-model";
import type { SaveBegun } from "./artifact-upload";
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

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200) ? value : undefined;
}

/** The frame the server sent, or null when it is not one. Never trusts more than the three selectors and a label. */
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
  const selection: ArtifactSaveSelection = {
    ...(operationIds ? { operationIds } : {}),
    ...(fileIds ? { fileIds } : {}),
    ...(payload.selection.all === true ? { all: true } : {}),
  };
  const label = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim().slice(0, 120) : undefined;
  return { type: "artifacts.save", id: payload.id, selection, ...(label ? { label } : {}) };
}

/** What a selection names, in the order the files were saved, or the reason it names nothing the agent can use. */
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
  if (selection.all) for (const artifact of artifacts) if (artifact.kind === "output") chosen.set(artifact.id, artifact);
  if (missing.length > 0) {
    throw new DeviceArtifactError(`Nothing saved in this chat matches ${missing.join(", ")}. The browser holds the files of operations that ran in this chat and finished; nothing was saved.`, "not-found");
  }
  if (chosen.size === 0) throw new DeviceArtifactError("This chat has no saved device files to save to the server yet.", "not-found");
  return [...chosen.values()].sort((left, right) => left.createdAt - right.createdAt);
}

/** A folder label for files an agent chose: the device, protocol and command that made them when they all share one. */
function labelFor(files: readonly DeviceArtifact[]): string {
  const first = files[0]?.provenance;
  if (!first || files.some((file) => file.provenance?.operationId === undefined || file.provenance.deviceId !== first.deviceId || file.provenance.protocol !== first.protocol)) return "Device files";
  return [first.label, first.protocol.toUpperCase(), first.command ?? first.action].filter((part): part is string => Boolean(part)).join(" ");
}

/**
 * Starts the save an agent asked for and returns once the server has accepted it. The upload carries on in the page; a
 * failure after this point is shown in the Devices panel and visible to the agent as a save that stops growing.
 */
export async function runArtifactSave(store: AgentSaveStore, sessionId: string, frame: DeviceArtifactSaveFrame): Promise<ArtifactSaveAck> {
  await store.hydrate(sessionId);
  const files = resolveSelection(store.list(sessionId), frame.selection);
  const run = store.startServerSave(sessionId, files.map((file) => file.id), { label: frame.label ?? labelFor(files), origin: "agent" });
  run.finished.catch(() => undefined);
  const begun = await run.begun;
  return { saveId: begun.saveId, folder: begun.folder, files: begun.files, bytes: begun.bytes, resumed: begun.resumed, alreadySaved: begun.alreadySaved };
}
