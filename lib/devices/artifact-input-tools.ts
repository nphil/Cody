import type { DeviceOperationToolDefinition } from "./operation-tools";
import { withWorkspaceImage } from "./artifact-input-source";
import { validArtifactPath, type DeviceArtifactInfo } from "./protocol";

function metadata({ id, name, size, sha256, kind, source }: DeviceArtifactInfo) {
  return { fileId: id, name, size, sha256, kind, source };
}

export const DEVICE_ARTIFACT_INPUT_TOOLS: DeviceOperationToolDefinition[] = [
  {
    name: "device_artifacts_import",
    description: "Import a non-empty image from this chat's workspace into this chat's browser escrow. Use a relative path, not a URL, hidden path or link. Supply sha256 if you have a known digest. Returns fileId, SHA-256 and byte size only after the browser independently checks the bytes and stores them. Does not touch any device.",
    parameters: { type: "object", properties: { path: { type: "string" }, sha256: { type: "string" } }, required: ["path"] },
    async handler(args, { bridge, cwd, sessionId }) {
      if (!sessionId || !cwd) return "Cannot import: this tool has no authorized session workspace.";
      if (!validArtifactPath(args.path)) return "Use a workspace-relative path to a regular file; no links, hidden paths, URLs or '..'.";
      const expected = args.sha256;
      if (expected !== undefined && (typeof expected !== "string" || !/^[\da-f]{64}$/i.test(expected))) return "sha256 must be a 64-character hexadecimal SHA-256 digest.";
      if (!bridge.attached) return "No browser is attached to this chat. Open the chat in Cody and keep the tab open for the import.";
      try {
        const file = await withWorkspaceImage(sessionId, cwd, args.path, expected, (image, remainingMs) => bridge.requestArtifactImport(image, remainingMs));
        return JSON.stringify(metadata(file));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT") return "Workspace image not found. Check the path relative to this chat's workspace.";
        if (code === "ENOTDIR" || code === "ELOOP") return "The workspace path crosses a link or a component that is not a directory. Use the real file in this project.";
        return `Could not import the workspace image: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  },
  {
    name: "device_artifacts_list",
    description: "List this chat's browser escrow files, newest first, with fileId, name, size in bytes, SHA-256, kind (input/output) and source. No device needed. Pass nextOffset as offset for another page.",
    parameters: { type: "object", properties: { offset: { type: "number", description: "Zero-based first artifact (default 0)." } }, required: [] },
    async handler(args, { bridge, sessionId }) {
      if (!sessionId) return "Cannot list artifacts without an authorized session.";
      const offset = args.offset === undefined ? 0 : args.offset;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return "offset must be a nonnegative whole number.";
      try {
        const { artifacts, total } = await bridge.requestArtifactList(offset);
        const end = offset + artifacts.length;
        return JSON.stringify({ artifacts: artifacts.map(metadata), total, nextOffset: end < total ? end : null });
      } catch (error) { return `Could not list session artifacts: ${error instanceof Error ? error.message : String(error)}`; }
    },
  },
];
