/**
 * Stop with messages still queued. omp 18.7's `abort_and_restore_queue`
 * withdraws every user-authored message from its queues, aborts the run, and
 * answers with what it took out; this module reads that answer and works out
 * which of Cody's delivery-ledger rows it accounts for. Pure, so the matching
 * is testable without an engine.
 *
 * What goes back to the composer is always what omp returned (its text, its
 * images): the ledger row only says WHICH row to settle as withdrawn.
 */
import { isRecord } from "./type-guards";

export interface RestoredImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** One message omp handed back (`RestoredQueuedMessage`). Its `text` is the
 *  text as submitted — whitespace included — or "[Image]" for a message that
 *  was only pictures. */
export interface RestoredEntry {
  text: string;
  images: RestoredImage[];
}

export interface QueueRestore {
  /** Oldest first. omp lists first anything the run had already taken from
   *  the queue but not yet recorded. */
  steering: RestoredEntry[];
  followUp: RestoredEntry[];
  /** omp left pictures out so the answer fit in one frame; every text is here. */
  imagesDropped: boolean;
  /** omp left the newest messages out so the answer fit in one frame. */
  truncated: boolean;
}

/** The part of a delivery-ledger row the matching reads. */
export interface QueueRow {
  clientMessageId: string;
  /** The ledger's `behavior`: "steer" for a steer (or a promoted follow-up),
   *  anything else sits in omp's follow-up queue. */
  behavior: string;
  /** The ledger's trimmed text. */
  text: string;
  imageCount: number;
  acceptedAt: number;
  /** The message exactly as it was handed to omp. */
  submittedText?: string;
}

/** A message going back to the composer. `clientMessageId` is absent when no
 *  ledger row accounts for it: it still comes back. `images` are omp's own
 *  (RestoredImage) or, for a message Cody held, the ones it was sent with. */
export interface ReturnedMessage {
  clientMessageId?: string;
  text: string;
  images: unknown[];
  /** When it was sent, when a ledger row says. */
  acceptedAt?: number;
}

/** What a Stop that asked omp to restore its queue ended up with: the messages
 *  for the composer, and omp's own answer (its `truncated` / `imagesDropped`). */
export interface StopRestoreOutcome {
  messages: ReturnedMessage[];
  restore: QueueRestore;
}

/** omp's chip text for a message that was only pictures. */
const IMAGE_ONLY_TEXT = "[Image]";

/** The pictures in an omp answer; anything malformed is left out. */
export function readRestoredImages(value: unknown): RestoredImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image): RestoredImage[] => (
    isRecord(image) && typeof image.data === "string" && typeof image.mimeType === "string"
      ? [{ type: "image", data: image.data, mimeType: image.mimeType }]
      : []
  ));
}

function readEntries(value: unknown): RestoredEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RestoredEntry[] => (
    isRecord(entry) && typeof entry.text === "string"
      ? [{ text: entry.text, images: readRestoredImages(entry.images) }]
      : []
  ));
}

/** Read an `abort_and_restore_queue` answer. Anything malformed reads as
 *  "nothing came back" rather than throwing: the abort itself has happened. */
export function parseQueueRestore(data: unknown): QueueRestore {
  const source = isRecord(data) ? data : {};
  return {
    steering: readEntries(source.steering),
    followUp: readEntries(source.followUp),
    imagesDropped: source.imagesDropped === true,
    truncated: source.truncated === true,
  };
}

function sameMessage(row: QueueRow, entry: RestoredEntry): boolean {
  if (row.submittedText !== undefined && row.submittedText === entry.text) return true;
  if (row.text === entry.text.trim()) return true;
  return entry.text === IMAGE_ONLY_TEXT && row.text === "" && row.imageCount > 0;
}

/**
 * Pair each message omp returned with the ledger row it came from, steering
 * first, each row at most once. The row in the same queue wins; another queue
 * is a fallback, because a follow-up omp promoted to a steer is listed as one.
 * A message no row accounts for is still returned.
 */
export function matchRestoredQueue(
  restore: QueueRestore,
  rows: readonly QueueRow[],
): { messages: ReturnedMessage[]; unclaimed: QueueRow[] } {
  const free = [...rows];
  const claim = (entry: RestoredEntry, queue: "steering" | "followUp"): QueueRow | undefined => {
    const sameQueue = free.findIndex((row) => (row.behavior === "steer") === (queue === "steering") && sameMessage(row, entry));
    const index = sameQueue !== -1 ? sameQueue : free.findIndex((row) => sameMessage(row, entry));
    return index === -1 ? undefined : free.splice(index, 1)[0];
  };
  const messages: ReturnedMessage[] = [];
  for (const [queue, entries] of [["steering", restore.steering], ["followUp", restore.followUp]] as const) {
    for (const entry of entries) {
      const row = claim(entry, queue);
      messages.push({
        ...(row ? { clientMessageId: row.clientMessageId, acceptedAt: row.acceptedAt } : {}),
        text: entry.text,
        images: entry.images,
      });
    }
  }
  return { messages, unclaimed: free };
}

/**
 * One list, oldest send first, from groups that are each already in send
 * order (omp's queue, Cody's own hold). A message no ledger row dates sits
 * right behind the one before it in its group, so omp's own order survives.
 */
export function inSendOrder(groups: readonly (readonly ReturnedMessage[])[]): ReturnedMessage[] {
  const keyed: Array<{ message: ReturnedMessage; key: number; index: number }> = [];
  for (const group of groups) {
    let key = Number.NEGATIVE_INFINITY;
    for (const message of group) {
      if (message.acceptedAt !== undefined) key = message.acceptedAt;
      keyed.push({ message, key, index: keyed.length });
    }
  }
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
  return keyed.map(({ message }) => message);
}
