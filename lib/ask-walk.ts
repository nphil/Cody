/**
 * The model's `ask` tool, as a chain of ordinary dialogs (omp 18.18.3 and later).
 *
 * omp turns the model's HTML form into a walk, one field at a time, over plain
 * `select`, `input` and `editor` requests, because RPC has no form screen:
 *
 *   - a radio group or select: one `select` of the option labels, plus a final
 *     "Other (type your own)" row for a typed answer (an `input` follows);
 *   - a checkbox group: the same `select` asked again after every pick. Picking
 *     a label TOGGLES it. The title gains "(N selected) " once N > 0, and a
 *     last "Done selecting" row ends the field (it is missing while a required
 *     field has nothing picked yet);
 *   - a text field: `input` or `editor`.
 *
 * omp 18.20 and later say what their own screen shows. Every prompt's title
 * leads with the text around the field in the form (paragraphs, "- " and "1. "
 * list lines, preformatted text, table rows as "a | b"), a blank line, and then
 * the question, which carries the "(N selected) " count. A `select` also names
 * its `selectionMarker` (radio or checkbox) and its `initialIndex` row; a
 * checkbox group lists its `checkedIndices` on every request and its
 * `markableCount` (the rows after those are actions, Done among them). With
 * those the screen draws the field as it is and nothing has to be guessed.
 *
 * omp 18.18.3 to 18.19 send the question alone and none of those fields, so a
 * frame never says which rows are ticked. For them this module keeps that
 * state on the client: it watches the requests, mirrors the toggles the user
 * makes, and checks the mirror against the count in every title. When the two
 * disagree (preselected boxes it was never told about), it stops claiming to
 * know and the screen shows the count alone.
 *
 * Pure and client-safe: the notification code and the browser both read the
 * row recognisers; only the browser runs the tracker.
 */

/** The row omp's `ask` adds after a radio, select or checkbox group's own options for a typed answer. */
export function isAskOtherRow(option: string): boolean {
  return /^other \(type your own\)/i.test(option);
}

/** The row that ends a multi-choice field: "<tick> Done selecting". */
export function isAskDoneRow(option: string): boolean {
  return /\bdone selecting\b/i.test(option);
}

const SELECTED_PREFIX = /^\((\d+) selected\) /;

/** The last line of a title: the question (omp 18.20 puts the text around the field above it). */
function lastLine(title: string): string {
  return title.slice(title.lastIndexOf("\n") + 1);
}

/** "(2 selected) <question>": a multi-choice field asked again after a tick. */
export function isAskSelectedTitle(title: unknown): boolean {
  return typeof title === "string" && SELECTED_PREFIX.test(lastLine(title));
}

/**
 * Whether a `select` of the ask walk is a multi-choice field: ticked in the chat, never answered by one tap. The
 * marker says so outright (omp 18.20); before that the count in the title or the Done row did.
 */
export function isAskMultiStep(request: { title?: unknown; options?: readonly string[]; selectionMarker?: unknown }): boolean {
  return request.selectionMarker === "checkbox" || isAskSelectedTitle(request.title) || (request.options ?? []).some(isAskDoneRow);
}

/** The parts of an ask prompt's title. */
export interface AskWalkTitle {
  /** The text above the question (empty for engines before 18.20 and for a field with none). */
  context: string;
  /** The field's own question, one line, without the count. */
  question: string;
  /** The count its title announced (0 when it had no prefix). */
  selected: number;
}

/**
 * Split an ask prompt's title. omp 18.20 sends the text around the field first, then a blank line, then the question
 * (with a multi-choice field's count in front); older engines send the question alone. The question is one line, so
 * it is always the last one.
 */
export function parseAskWalkTitle(title: string): AskWalkTitle {
  const cut = title.lastIndexOf("\n");
  const line = title.slice(cut + 1);
  const match = SELECTED_PREFIX.exec(line);
  return {
    context: cut < 0 ? "" : title.slice(0, cut).trimEnd(),
    question: match ? line.slice(match[0].length) : line,
    selected: match ? Number(match[1]) : 0,
  };
}

/** A field's identity across the requests omp sends for it: the text above its question, then the question. */
function fieldKey(parts: Pick<AskWalkTitle, "context" | "question">): string {
  return parts.context === "" ? parts.question : `${parts.context}\n\n${parts.question}`;
}

/**
 * omp's tool approval is a dialog titled "Allow tool: <name>". Over RPC it is a
 * `select`; the `confirm` form is the shape older Cody builds and test fixtures
 * use, and is still understood.
 */
export function isToolApprovalTitle(title: unknown): title is string {
  return typeof title === "string" && /^allow tool\s*:/i.test(title);
}

/**
 * Whether a dialog is the model's own question. The structured `ask` request
 * always is. A plain select, input or editor is one while the `ask` tool runs
 * (it runs alone in its batch, so nothing else is asking), except an approval.
 */
export function dialogBelongsToAsk(request: { method: string; title?: string }, askToolRunning: boolean): boolean {
  if (request.method === "ask") return true;
  if (!askToolRunning) return false;
  if (request.method !== "select" && request.method !== "input" && request.method !== "editor") return false;
  return !isToolApprovalTitle(request.title);
}

/**
 * Whether a tool call is the model's `ask`. omp 18.20 mounts `ask` under `xd://` unless the session turns that off,
 * so the model calls it as `write xd://ask`: the call is named `write` and only its `path` says which tool runs.
 * Engines that offer `ask` as a tool of its own name it directly.
 */
export function isAskToolCall(toolName: unknown, input: unknown): boolean {
  if (toolName === "ask") return true;
  if (toolName !== "write" || typeof input !== "object" || input === null || !("path" in input)) return false;
  return typeof input.path === "string" && input.path.trim().toLowerCase() === "xd://ask";
}

/** The few transcript fields {@link askCallPending} reads; every `AgentMessage` fits. */
interface TranscriptMessage {
  role: string;
  toolCallId?: string;
  content?: unknown;
}

/**
 * Whether the transcript ends on an `ask` call that has no result yet. After a page reload (a phone coming back to its
 * browser does that) while the model's question is open, the live "tool started" event that says `ask` is running was
 * never seen, but the call is in the loaded transcript with nothing after it.
 */
export function askCallPending(messages: readonly TranscriptMessage[]): boolean {
  const answered = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "toolResult" && typeof message.toolCallId === "string") answered.add(message.toolCallId);
    if (message.role !== "assistant") continue;
    return Array.isArray(message.content) && message.content.some((block: unknown) => isUnansweredAskCall(block, answered));
  }
  return false;
}

function isUnansweredAskCall(block: unknown, answered: ReadonlySet<string>): boolean {
  if (typeof block !== "object" || block === null) return false;
  if (!("type" in block) || block.type !== "toolCall" || !("toolName" in block) || !("input" in block)) return false;
  if (!isAskToolCall(block.toolName, block.input)) return false;
  return !("toolCallId" in block && typeof block.toolCallId === "string" && answered.has(block.toolCallId));
}

/**
 * omp 18.14.2 and later withdraw an open `ask` when the user sends a message
 * (the tool then ends with "Ask interrupted by message"). Older engines keep
 * the question open and queue the message behind it. An unreadable version
 * claims nothing.
 */
export function askWithdrawnByMessage(version: string | null | undefined): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  const found = [Number(match[1]), Number(match[2]), Number(match[3])];
  const since = [18, 14, 2];
  for (let index = 0; index < 3; index += 1) {
    if (found[index] !== since[index]) return found[index] > since[index];
  }
  return true;
}

/** One row of a walk step. `ticked` is set only while the screen knows it. */
export interface AskWalkRow {
  /** The exact string omp sent, and the one an answer must send back. */
  label: string;
  /** `action`: a row after the marked ones that is not Done (omp's `markableCount`); a plain button, never a box. */
  kind: "option" | "other" | "done" | "action";
  ticked?: boolean;
  /** What the user typed behind a ticked Other row, while the screen knows it. */
  typed?: string;
}

/** A recognised step of the walk, attached to the `select` request it came from. */
export interface AskWalkView {
  /** The field's own question, without a "(N selected) " prefix or the text above it. */
  question: string;
  /** The text omp showed above the question (the form's paragraphs, lists, preformatted blocks and tables as plain text). */
  context: string;
  /** Several rows can be ticked: a Done row ends the field. */
  multi: boolean;
  /** One row is chosen: a radio group. Only omp 18.20 and later say so; the request's `initialIndex` is the chosen row. */
  radio: boolean;
  /** The count omp announced (in the title, or as the ticked rows it listed); 0 when none. */
  selected: number;
  /** Whether `ticked` on the rows mirrors omp's own state. When false the screen shows `selected` alone. */
  ticksKnown: boolean;
  /** One entry per option omp sent, in the order it sent them. */
  rows: AskWalkRow[];
}

interface WalkRequest {
  id: string;
  method: string;
  title?: string;
  options?: string[];
  /** omp 18.20 and later: what the rows are, which are ticked, and how many carry a marker. */
  selectionMarker?: "radio" | "checkbox";
  checkedIndices?: readonly number[];
  markableCount?: number;
}

type WalkResponse = { value: string } | { confirmed: boolean } | { cancelled: true } | { answers: unknown };

/** The state of the multi-choice field being walked. */
interface Slot {
  /** The field's identity: see `fieldKey`. */
  key: string;
  ticked: Set<string>;
  otherSet: boolean;
  /** The typed answer behind the Other row (blank until one is typed). */
  otherText: string;
  /** `ticked` and `otherSet` are exactly what omp holds. */
  known: boolean;
  /** The Other row was picked without a typed answer behind it: an `input` for the question comes next. */
  otherInputNext: boolean;
}

export interface AskWalkTracker {
  /** The step a `select` request is, or null when it is some other question. Asking twice about one id answers the same. */
  observe(request: WalkRequest): AskWalkView | null;
  /**
   * Record the user's answer to a request. For a toggle of a multi-choice field
   * it returns the screen as it will look once omp asks again, so the dialog can
   * stay up with the new tick instead of vanishing for the round trip. Null for
   * everything else: the dialog goes away as usual.
   */
  reply(request: WalkRequest, response: WalkResponse): AskWalkView | null;
  /** omp withdrew the dialog with this id (a `cancel` frame). When it is the step on screen the ask is over, so the field in progress is forgotten. */
  withdrawn(id: string): void;
}

function renderRows(rows: readonly AskWalkRow[], slot: Slot, known: boolean): AskWalkRow[] {
  return rows.map((row) => {
    if (row.kind === "done" || row.kind === "action") return { label: row.label, kind: row.kind };
    const ticked = row.kind === "other" ? slot.otherSet : slot.ticked.has(row.label);
    if (!known) return { label: row.label, kind: row.kind };
    return row.kind === "other" && ticked && slot.otherText !== ""
      ? { label: row.label, kind: row.kind, ticked, typed: slot.otherText }
      : { label: row.label, kind: row.kind, ticked };
  });
}

export function createAskWalkTracker(): AskWalkTracker {
  let slot: Slot | null = null;
  // The last pick made on a select that did not look multi-choice: a required
  // checkbox group with nothing picked yet shows no Done row, so its first
  // request is indistinguishable from a radio group. Its second says "(1 selected)".
  let plainPick: { key: string; label: string } | null = null;
  let memo: { id: string; view: AskWalkView | null } | null = null;
  // The newest dialog seen, of any kind: a withdrawn input ends the walk as much as a withdrawn select does.
  let latestId: string | null = null;
  // The step answered last: a second answer to it (a double tap) must not toggle twice.
  let repliedId: string | null = null;

  // A select that names its rows (omp 18.20): drawn from the request itself, nothing is inferred or mirrored.
  const computeMarked = (request: WalkRequest, options: readonly string[], parts: AskWalkTitle, key: string): AskWalkView => {
    const { context, question } = parts;
    const checkbox = request.selectionMarker === "checkbox";
    plainPick = null;
    // Only the leading rows carry a marker; the rest are actions. A checkbox group that leaves the count out still ends in its Done row.
    const doneLast = checkbox && options.length > 0 && isAskDoneRow(options[options.length - 1]);
    const markable = Math.max(0, Math.min(options.length, request.markableCount ?? options.length - (doneLast ? 1 : 0)));
    const rows = options.map((label, index): AskWalkRow => {
      if (index >= markable) return { label, kind: isAskDoneRow(label) ? "done" : "action" };
      return { label, kind: index === markable - 1 && isAskOtherRow(label) ? "other" : "option" };
    });
    if (!checkbox) {
      slot = null;
      return { question, context, multi: false, radio: true, selected: 0, ticksKnown: false, rows };
    }
    const checked = new Set(request.checkedIndices ?? []);
    // The text typed behind Other is only ever known here; omp reports the box, not the words.
    const typed = slot !== null && slot.key === key ? slot.otherText : "";
    const next: Slot = { key, ticked: new Set(), otherSet: false, otherText: "", known: true, otherInputNext: false };
    for (const [index, row] of rows.entries()) {
      if (!checked.has(index)) continue;
      if (row.kind === "other") {
        next.otherSet = true;
        next.otherText = typed;
      } else if (row.kind === "option") {
        next.ticked.add(row.label);
      }
    }
    slot = next;
    const selected = next.ticked.size + (next.otherSet ? 1 : 0);
    return { question, context, multi: true, radio: false, selected, ticksKnown: true, rows: renderRows(rows, next, true) };
  };

  const compute = (request: WalkRequest): AskWalkView | null => {
    const options = request.options ?? [];
    const parts = parseAskWalkTitle(request.title ?? "");
    const key = fieldKey(parts);
    if (request.selectionMarker !== undefined) return computeMarked(request, options, parts, key);
    const { context, question, selected } = parts;
    const doneAt = options.length > 0 && isAskDoneRow(options[options.length - 1]) ? options.length - 1 : -1;
    const continues = slot !== null && slot.key === key;
    const multi = doneAt >= 0 || selected > 0 || continues;
    const rowsOf = (): AskWalkRow[] => options.map((label, index): AskWalkRow => {
      if (index === doneAt) return { label, kind: "done" };
      return { label, kind: isAskOtherRow(label) ? "other" : "option" };
    });

    if (!multi) {
      slot = null;
      plainPick = null;
      // A radio group or select: the only mark is the typed-answer row at its end.
      if (options.length > 0 && isAskOtherRow(options[options.length - 1])) {
        return { question, context, multi: false, radio: false, selected: 0, ticksKnown: false, rows: rowsOf() };
      }
      return null;
    }

    if (!continues || slot === null) {
      const pick = plainPick !== null && plainPick.key === key ? plainPick.label : null;
      slot = { key, ticked: new Set(), otherSet: false, otherText: "", known: selected === 0, otherInputNext: false };
      // Preselected boxes count in the title without being named. One pick on a
      // field that had none is the exception: the count of 1 is that pick.
      if (selected === 1 && pick !== null && options.includes(pick) && !isAskOtherRow(pick) && !isAskDoneRow(pick)) {
        slot.ticked.add(pick);
        slot.known = true;
      }
    } else {
      slot.otherInputNext = false;
      if (selected === 0) {
        slot.ticked.clear();
        slot.otherSet = false;
        slot.otherText = "";
        slot.known = true;
      } else if (slot.known && slot.ticked.size + (slot.otherSet ? 1 : 0) !== selected) {
        slot.known = false;
      }
    }
    plainPick = null;

    const rows = rowsOf();
    // A tick on a label the engine no longer lists cannot be trusted.
    if (slot.known && [...slot.ticked].some((label) => !options.includes(label))) slot.known = false;
    return { question, context, multi: true, radio: false, selected, ticksKnown: slot.known, rows: renderRows(rows, slot, slot.known) };
  };

  return {
    observe(request) {
      latestId = request.id;
      if (request.method !== "select") return null;
      if (memo !== null && memo.id === request.id) return memo.view;
      const view = compute(request);
      memo = { id: request.id, view };
      return view;
    },

    reply(request, response) {
      if (request.method === "input") {
        if (slot !== null && slot.otherInputNext && fieldKey(parseAskWalkTitle(request.title ?? "")) === slot.key) {
          slot.otherInputNext = false;
          // A blank or cancelled answer leaves Other unset, exactly as omp does.
          const typed = "value" in response && typeof response.value === "string" ? response.value.trim() : "";
          if (typed !== "" && slot.known) {
            slot.otherSet = true;
            slot.otherText = typed;
          }
        }
        return null;
      }
      if (request.method !== "select" || repliedId === request.id) return null;
      repliedId = request.id;

      const view = memo !== null && memo.id === request.id ? memo.view : null;
      const picked = "value" in response && typeof response.value === "string" ? response.value : null;
      if (view === null || !view.multi || slot === null) {
        // A plain select. Cancelling any step of the walk withdraws the whole ask.
        if (picked !== null && !view?.radio && !isAskOtherRow(picked) && !isAskDoneRow(picked)) {
          plainPick = { key: fieldKey(parseAskWalkTitle(request.title ?? "")), label: picked };
        }
        return null;
      }
      if (picked === null) {
        slot = null;
        return null;
      }
      const row = view.rows.find((candidate) => candidate.label === picked);
      if (!row) return null;
      if (row.kind === "done") {
        slot = null;
        return null;
      }
      // A row past the marked ones that is not Done: omp acts on it, whatever it is. The screen claims nothing.
      if (row.kind === "action") return null;
      if (row.kind === "other") {
        if (slot.known && slot.otherSet) {
          // The row clears a typed answer it already holds; omp asks the same select again.
          slot.otherSet = false;
          slot.otherText = "";
          return { ...view, selected: Math.max(0, view.selected - 1), rows: renderRows(view.rows, slot, true) };
        }
        slot.otherInputNext = true;
        return null;
      }
      if (!slot.known) return { ...view };
      if (slot.ticked.has(picked)) slot.ticked.delete(picked);
      else slot.ticked.add(picked);
      return { ...view, selected: slot.ticked.size + (slot.otherSet ? 1 : 0), rows: renderRows(view.rows, slot, true) };
    },

    withdrawn(id) {
      if (id !== latestId) return;
      slot = null;
      plainPick = null;
      memo = null;
      latestId = null;
    },
  };
}
