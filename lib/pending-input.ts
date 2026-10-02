import type { AskAnswer } from "@/lib/ask-dialog";
import type { AgentPermissionRequest } from "@/lib/permission-request";
import type { OutboxImage } from "@/lib/outbox";
import type { ExtensionUiRequest } from "@/lib/types";
import type { OmpExtensionUiRequest, RefusalDecision } from "@/lib/pi-types";
export type { RefusalDecision } from "@/lib/pi-types";

/** omp >= 18.4's multi-question `ask` dialog (after `set_ask_dialog`). */
export type ExtensionAskRequest = Extract<OmpExtensionUiRequest, { method: "ask" }>;

export type ExtensionDialogRequest =
  | Extract<ExtensionUiRequest, { method: "confirm" | "input" | "editor" }>
  | Extract<OmpExtensionUiRequest, { method: "select" }>
  | ExtensionAskRequest;

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { answers: AskAnswer[] }
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
