import type { AskAnswer } from "@/lib/ask-dialog";
import type { AskWalkView } from "@/lib/ask-walk";
import type { DeviceTrustRequest } from "@/lib/devices/trust";
import type { AgentPermissionRequest } from "@/lib/permission-request";
import type { OutboxImage } from "@/lib/outbox";
import type { ExtensionUiRequest } from "@/lib/types";
import type { OmpExtensionUiRequest, RefusalDecision } from "@/lib/pi-types";
export type { RefusalDecision } from "@/lib/pi-types";

/** omp >= 18.4's multi-question `ask` dialog (after `set_ask_dialog`). */
export type ExtensionAskRequest = Extract<OmpExtensionUiRequest, { method: "ask" }>;

/**
 * A `select`, as omp sent it plus two fields only the browser adds while omp's
 * `ask` tool walks a form one field at a time (see lib/ask-walk.ts).
 */
export type ExtensionSelectRequest = Extract<OmpExtensionUiRequest, { method: "select" }> & {
  /** This select is one step of that walk; the rows know what is ticked. */
  walk?: AskWalkView;
  /** The pick was sent and omp has not asked its next question yet: the tick shows, the rows wait. */
  settling?: boolean;
};

export type ExtensionDialogRequest =
  | Extract<ExtensionUiRequest, { method: "confirm" | "input" | "editor" }>
  | ExtensionSelectRequest
  | ExtensionAskRequest;

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { answers: AskAnswer[] }
  | { cancelled: true };


export type PendingInput =
  | { kind: "extension"; request: ExtensionDialogRequest; fromAsk?: boolean }
  | { kind: "permission"; request: AgentPermissionRequest }
  | { kind: "refusal"; decision: RefusalDecision }
  | { kind: "device-trust"; request: DeviceTrustRequest };

export type PendingInputResponse =
  | { kind: "extension"; response: ExtensionDialogResponse }
  | { kind: "permission"; optionId: string }
  | { kind: "refusal"; choice: "rewind" | "continue" | "keep"; remember?: boolean }
  | { kind: "device-trust"; allow: boolean; remember?: boolean };

/** A message handed back to the composer: a rewound (declined) message, or
 *  queued messages taken back for editing or returned by Stop. */
export interface RewoundDraft {
  text: string;
  images: OutboxImage[];
  source?: "refusal" | "queue";
}
