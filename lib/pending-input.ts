import type { AgentPermissionRequest } from "@/lib/permission-request";
import type { OutboxImage } from "@/lib/outbox";
import type { ExtensionUiRequest } from "@/lib/types";
import type { RefusalDecision } from "@/lib/pi-types";
export type { RefusalDecision } from "@/lib/pi-types";

export type ExtensionDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };


export type PendingInput =
  | { kind: "extension"; request: ExtensionDialogRequest }
  | { kind: "permission"; request: AgentPermissionRequest }
  | { kind: "refusal"; decision: RefusalDecision };

export type PendingInputResponse =
  | { kind: "extension"; response: ExtensionDialogResponse }
  | { kind: "permission"; optionId: string }
  | { kind: "refusal"; choice: "rewind" | "continue" | "keep"; remember?: boolean };

/** A message handed back to the composer: a rewound (declined) message, or
 *  queued messages taken back for editing or returned by Stop. */
export interface RewoundDraft {
  text: string;
  images: OutboxImage[];
  source?: "refusal" | "queue";
}
