/**
 * Agent tools: save the files this chat's browser holds to the server as ONE compressed zip, and follow the save.
 *
 * A backup's partitions live in the person's browser, so the tool cannot copy them: it asks the page
 * (DeviceBridge.requestArtifactSave), the page starts the upload (./artifact-agent.ts) and answers once the server
 * accepted it, and from then on the save is read from the SERVER's own record of it (./artifact-vault.ts): how many
 * files are verified, how many bytes are stored, how far the server has got packing them into the zip and, when it is
 * done, the zip, how much smaller it is and how to check it.
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

function count(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"}`;
}

/** A file's name inside the archive's folder. */
function insideFolder(entry: string): string {
  return entry.slice(entry.indexOf("/") + 1);
}

function names(status: SaveStatus): string {
  const shown = status.files.slice(0, LISTED_FILES).map((file) => insideFolder(file.entry)).join(", ");
  return status.files.length > LISTED_FILES ? `${shown}, and ${status.files.length - LISTED_FILES} more` : shown;
}

function describeComplete(status: SaveStatus): string {
  const folder = status.files[0] ? status.files[0].entry.slice(0, status.files[0].entry.indexOf("/")) : "";
  const packed = status.archiveBytes ?? 0;
  const saved = status.totalBytes > 0 && packed < status.totalBytes ? ` (${Math.round((1 - packed / status.totalBytes) * 100)}% smaller)` : "";
  return [
    `Saved to the server as ONE zip file: ${status.archive}`,
    `${count(status.files.length)} inside: ${formatBytes(status.totalBytes)} before packing, ${formatBytes(packed)} in the zip${saved}.`,
    "The server re-read the finished zip from its own disk, and every file in it matched its SHA-256 and CRC-32.",
    `Check it yourself with: unzip -t ${quoted(status.archive)}. Inside, the folder ${folder ? `"${folder}"` : "of the save"} holds the files, SHA256SUMS and manifest.json (after unzipping: cd into the folder and run sha256sum -c SHA256SUMS).`,
    `Files: ${names(status)}.`,
  ].join("\n");
}

/** Every file is on the server and the server is writing the zip. */
function describeBuilding(status: SaveStatus): string {
  const packed = Math.min(status.packedBytes ?? 0, status.totalBytes);
  const percent = status.totalBytes > 0 ? Math.floor((packed / status.totalBytes) * 100) : 100;
  return [
    `Save ${status.saveId}: all ${count(status.files.length)} are on the server and verified, and the server is packing the archive: ${percent} % (${formatBytes(packed)} of ${formatBytes(status.totalBytes)}).`,
    `The zip appears at ${status.archive} only when it is finished and the server has re-read it.`,
    `Check again with device_artifacts_status (saveId ${status.saveId}).`,
  ].join("\n");
}

/** Packing the zip stopped: what happened, and that nothing has to be uploaded again. */
function describeFailed(status: SaveStatus): string {
  return [
    `Save ${status.saveId} stopped before the zip was finished: ${status.buildError?.message ?? "the server could not write it."}`,
    `The ${count(status.files.filter((file) => file.verified).length)} that were uploaded are still on the server, so nothing needs uploading again. To try again call device_artifacts_save again with the same selection (or ask the user to press Save to server): the browser asks the server to pack them again.`,
  ].join("\n");
}

function describeRunning(status: SaveStatus): string {
  const verified = status.files.filter((file) => file.verified).length;
  if (verified === status.files.length) {
    return [
      `Save ${status.saveId}: all ${count(status.files.length)} are on the server and verified, but the server is not packing the zip right now.`,
      "That last step is asked for by the Cody tab in the user's browser. If this does not change, ask the user to open Cody, then call device_artifacts_save with the same selection: it starts the packing without uploading anything again.",
      `Check again with device_artifacts_status (saveId ${status.saveId}).`,
    ].join("\n");
  }
  return [
    `Save ${status.saveId} is still uploading: ${verified} of ${status.files.length} files verified, ${formatBytes(status.receivedBytes)} of ${formatBytes(status.totalBytes)} stored.`,
    `The zip appears at ${status.archive} only once every file has been verified and packed.`,
    `The upload runs in the user's browser, so it goes on only while the Cody tab stays open. If the stored size stops growing between your checks, ask the user to open Cody, then call device_artifacts_save with the same selection: it carries on from what is already stored.`,
    `Check again with device_artifacts_status (saveId ${status.saveId}).`,
  ].join("\n");
}

/** What a save that is not finished says: why it stopped, how far the packing is, or how far the upload is. */
function describeUnfinished(status: SaveStatus): string {
  if (status.buildError) return describeFailed(status);
  return status.state === "building" ? describeBuilding(status) : describeRunning(status);
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
  const only = list(args.files, "files");
  if (typeof operationIds === "string") return operationIds;
  if (typeof fileIds === "string") return fileIds;
  if (typeof only === "string") return only;
  const operationId = stringArg(args, "operationId")?.trim();
  if (operationId) operationIds.push(operationId);
  const set = stringArg(args, "set")?.trim();
  const selection: ArtifactSaveSelection = {
    ...(operationIds.length > 0 ? { operationIds } : {}),
    ...(fileIds.length > 0 ? { fileIds } : {}),
    ...(args.all === true ? { all: true } : {}),
    ...(set ? { set } : {}),
    ...(only.length > 0 ? { only } : {}),
  };
  if (!selection.operationIds && !selection.fileIds && !selection.all && !selection.set) {
    return "Say what to save: operationId (every file that operation made), set (every file filed under that backup name), fileIds (specific files), or all: true (every device output of this chat). Add files to keep only some of them by name or partition.";
  }
  const wait = Math.min(Math.max(Math.floor(numberArg(args, "waitSeconds") ?? DEFAULT_WAIT_SECONDS), 0), MAX_WAIT_SECONDS);
  const label = stringArg(args, "label")?.trim();
  let ack;
  try {
    ack = await bridge.requestArtifactSave(selection, label || undefined);
  } catch (error) {
    return `Could not start the save: ${error instanceof Error ? error.message : String(error)}`;
  }
  const intro = `Save ${ack.saveId} ${ack.alreadySaved ? "was already on the server" : ack.resumed ? "was resumed" : "was started"}: ${count(ack.files)}, ${formatBytes(ack.bytes)}.`;
  const config = vaultConfig();
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const status = await saveStatus(config, ack.saveId);
    if (status?.state === "complete") return `${intro}\n${describeComplete(status)}`;
    if (!status) return `${intro}\nThe server no longer has this save (it may have been deleted or cleaned up). Call device_artifacts_save again to start it afresh.`;
    // A failed build does not mend by waiting: say so now.
    if (status.buildError || Date.now() >= deadline) return `${intro}\n${describeUnfinished(status)}`;
    await sleep(Math.min(POLL_MS, Math.max(deadline - Date.now(), 0)));
  }
};

const statusHandler: DeviceOperationToolHandler = async (args, { bridge }) => {
  const saveId = stringArg(args, "saveId")?.trim() || bridge.latestArtifactSave();
  if (!saveId) return "No save has been started from this chat yet. Use device_artifacts_save.";
  if (!bridge.startedArtifactSave(saveId)) return `Save ${saveId} was not started by this chat's agent, so it cannot be read from here.`;
  const status = await saveStatus(vaultConfig(), saveId);
  if (!status) return `The server has no save ${saveId}: it may have been deleted or cleaned up.`;
  return status.state === "complete" ? describeComplete(status) : describeUnfinished(status);
};

export const DEVICE_ARTIFACT_TOOLS: DeviceOperationToolDefinition[] = [
  {
    name: "device_artifacts_save",
    description:
      "Save files this chat's browser holds (a backup's partitions, dumps, pulls) to the Cody server as ONE compressed .zip file, where you and the NAS can read it. The browser uploads them in 4 MiB slices, the server re-reads every file from its own disk and checks its SHA-256, packs them (with SHA256SUMS and manifest.json) into a single zip, re-reads that zip and checks every file again, and only then gives it its final name <label>-<date>.zip in one step, so a zip you can see is a finished, checked one. Name what to save: operationId or operationIds (every file those operations made), set (every file filed under that backup name, the `set` you gave the operations), fileIds (specific files), or all: true (every device output of this chat); add files to keep only some of them, by file name or partition (for example [\"boot_a\", \"userdata\"]): a name that matches nothing is an error that lists it. It waits up to waitSeconds (default 60) and returns the zip's path, its size packed and unpacked, and how to check it (unzip -t), or tells you to follow it with device_artifacts_status. The upload runs in the user's browser and goes on only while the tab stays open. If packing fails, the uploaded files stay on the server and calling this again with the same selection packs them again without uploading anything twice.",
    parameters: {
      type: "object",
      properties: {
        operationId: { type: "string", description: "Save every file this operation made (the id device_operation_status shows)." },
        operationIds: { type: "array", items: { type: "string" }, description: "Save every file these operations made." },
        set: { type: "string", description: "Save every file filed under this backup name: the `set` you gave the operations that made them." },
        fileIds: { type: "array", items: { type: "string" }, description: "Save these session artifacts by id." },
        all: { type: "boolean", description: "Save every device output of this chat." },
        files: { type: "array", items: { type: "string" }, description: "Keep only files whose name, target or partition (for example boot_a) is one of these, on top of the other selectors. A name that matches nothing is an error." },
        label: { type: "string", description: "Names the zip: it is created as <label>-<date>.zip. Defaults to the backup name, or the device and what ran." },
        waitSeconds: { type: "number", description: "How long to wait for the save to finish before answering, 0 to 110 (default 60)." },
      },
      required: [],
    },
    handler: saveHandler,
  },
  {
    name: "device_artifacts_status",
    description:
      "Follow a save started with device_artifacts_save: files verified, bytes stored, \"packing the archive: N %\" while the server writes the zip, and once it is done the zip's path, its size and how to check it (unzip -t). Says why packing stopped when it did, and that the uploaded files are still on the server. Defaults to the latest save of this chat.",
    parameters: { type: "object", properties: { saveId: { type: "string", description: "The save id device_artifacts_save returned." } }, required: [] },
    handler: statusHandler,
  },
];
