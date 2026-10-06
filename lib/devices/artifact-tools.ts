/**
 * Agent tools: save the files this chat's browser holds to the server, and follow the save.
 *
 * A backup's partitions live in the person's browser, so the tool cannot copy them: it asks the page
 * (DeviceBridge.requestArtifactSave), the page starts the upload (./artifact-agent.ts) and answers once the server
 * accepted it, and from then on the save is read from the SERVER's own record of it (./artifact-vault.ts): how many
 * files are verified, how many bytes are stored, and, when it is done, the folder, the manifest and how to check it.
 *
 * Needs no device and no device trust: it moves files the person already holds to a folder only the server's owner can
 * read. Only saves this chat's agent started can be asked about, and only this chat's own files can be named.
 */

import { formatBytes } from "../format-bytes";
import { numberArg, stringArg } from "../session-tools";
import { saveStatus, vaultConfig, type SaveStatus } from "./artifact-vault";
import type { ArtifactSaveSelection } from "./protocol";
import type { DeviceOperationToolDefinition, DeviceOperationToolHandler } from "./operation-tools";

const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 110;
const POLL_MS = 1000;
const LISTED_FILES = 12;

function quoted(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function names(status: SaveStatus): string {
  const shown = status.files.slice(0, LISTED_FILES).map((file) => file.path).join(", ");
  return status.files.length > LISTED_FILES ? `${shown}, and ${status.files.length - LISTED_FILES} more` : shown;
}

function describeComplete(status: SaveStatus): string {
  return [
    `Saved to the server: ${status.folder}`,
    `${status.files.length} files, ${formatBytes(status.totalBytes)}. The server re-read every file from its own disk and each SHA-256 matched what the browser recorded.`,
    `Manifest: ${status.manifestPath}${status.manifestSha256 ? ` (its SHA-256 is ${status.manifestSha256})` : ""}. Checksums: ${status.sums}.`,
    `Check it yourself with: cd ${quoted(status.folder)} && sha256sum -c SHA256SUMS`,
    `Files: ${names(status)}.`,
  ].join("\n");
}

function describeRunning(status: SaveStatus): string {
  const verified = status.files.filter((file) => file.verified).length;
  return [
    `Save ${status.saveId} is still uploading: ${verified} of ${status.files.length} files verified, ${formatBytes(status.receivedBytes)} of ${formatBytes(status.totalBytes)} stored.`,
    `The folder appears at ${status.folder} only once every file has been verified.`,
    `The upload runs in the user's browser, so it goes on only while the Cody tab stays open. If the stored size stops growing between your checks, ask the user to open Cody, then call device_artifacts_save with the same selection: it carries on from what is already stored.`,
    `Check again with device_artifacts_status (saveId ${status.saveId}).`,
  ].join("\n");
}

function list(value: unknown, name: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) return `${name} must be a list of non-empty strings.`;
  return value.map((item: string) => item.trim());
}

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

const saveHandler: DeviceOperationToolHandler = async (args, { bridge }) => {
  const operationIds = list(args.operationIds, "operationIds");
  const fileIds = list(args.fileIds, "fileIds");
  if (typeof operationIds === "string") return operationIds;
  if (typeof fileIds === "string") return fileIds;
  const operationId = stringArg(args, "operationId")?.trim();
  if (operationId) operationIds.push(operationId);
  const selection: ArtifactSaveSelection = {
    ...(operationIds.length > 0 ? { operationIds } : {}),
    ...(fileIds.length > 0 ? { fileIds } : {}),
    ...(args.all === true ? { all: true } : {}),
  };
  if (!selection.operationIds && !selection.fileIds && !selection.all) {
    return "Say what to save: operationId (every file that operation made), fileIds (specific files), or all: true (every device output of this chat).";
  }
  const wait = Math.min(Math.max(Math.floor(numberArg(args, "waitSeconds") ?? DEFAULT_WAIT_SECONDS), 0), MAX_WAIT_SECONDS);
  const label = stringArg(args, "label")?.trim();
  let ack;
  try {
    ack = await bridge.requestArtifactSave(selection, label || undefined);
  } catch (error) {
    return `Could not start the save: ${error instanceof Error ? error.message : String(error)}`;
  }
  const intro = `Save ${ack.saveId} ${ack.alreadySaved ? "was already on the server" : ack.resumed ? "was resumed" : "was started"}: ${ack.files} files, ${formatBytes(ack.bytes)}.`;
  const config = vaultConfig();
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const status = await saveStatus(config, ack.saveId);
    if (status?.state === "complete") return `${intro}\n${describeComplete(status)}`;
    if (!status) return `${intro}\nThe server no longer has this save (it may have been deleted or cleaned up). Call device_artifacts_save again to start it afresh.`;
    if (Date.now() >= deadline) return `${intro}\n${describeRunning(status)}`;
    await sleep(Math.min(POLL_MS, Math.max(deadline - Date.now(), 0)));
  }
};

const statusHandler: DeviceOperationToolHandler = async (args, { bridge }) => {
  const saveId = stringArg(args, "saveId")?.trim() || bridge.latestArtifactSave();
  if (!saveId) return "No save has been started from this chat yet. Use device_artifacts_save.";
  if (!bridge.startedArtifactSave(saveId)) return `Save ${saveId} was not started by this chat's agent, so it cannot be read from here.`;
  const status = await saveStatus(vaultConfig(), saveId);
  if (!status) return `The server has no save ${saveId}: it may have been deleted or cleaned up.`;
  return status.state === "complete" ? describeComplete(status) : describeRunning(status);
};

export const DEVICE_ARTIFACT_TOOLS: DeviceOperationToolDefinition[] = [
  {
    name: "device_artifacts_save",
    description: "Save files this chat's browser holds (a backup's partitions, dumps, pulls) to the Cody server, where you and the NAS can read them. The browser uploads them in 4 MiB slices, the server re-reads every file from its own disk and checks its SHA-256, then writes manifest.json and SHA256SUMS and gives the folder its final name in one step, so a folder you can see is a finished one. Name what to save: operationId or operationIds (every file those operations made), fileIds (specific files), or all: true (every device output of this chat). It waits up to waitSeconds (default 60) and returns the folder path with how to check it, or tells you to follow it with device_artifacts_status. The upload runs in the user's browser and goes on only while the tab stays open. Saving the same files again finds the existing save instead of copying them again.",
    parameters: {
      type: "object",
      properties: {
        operationId: { type: "string", description: "Save every file this operation made (the id device_operation_status shows)." },
        operationIds: { type: "array", items: { type: "string" }, description: "Save every file these operations made." },
        fileIds: { type: "array", items: { type: "string" }, description: "Save these session artifacts by id." },
        all: { type: "boolean", description: "Save every device output of this chat." },
        label: { type: "string", description: "Names the folder: it is created as <date>-<label>. Defaults to the device and what ran." },
        waitSeconds: { type: "number", description: "How long to wait for the save to finish before answering, 0 to 110 (default 60)." },
      },
      required: [],
    },
    handler: saveHandler,
  },
  {
    name: "device_artifacts_status",
    description: "Follow a save started with device_artifacts_save: files verified, bytes stored, and once it is done the folder, manifest and checksum file to check. Defaults to the latest save of this chat.",
    parameters: { type: "object", properties: { saveId: { type: "string", description: "The save id device_artifacts_save returned." } }, required: [] },
    handler: statusHandler,
  },
];
