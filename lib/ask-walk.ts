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
 * omp's RPC `select` frame carries only the title, the options and a timeout,
 * so it never says which rows are ticked. This module keeps that state on the
 * client: it watches the requests, mirrors the toggles the user makes, and
 * checks the mirror against the count in every title. When the two disagree
 * (preselected boxes it was never told about), it stops claiming to know and
 * the screen shows the count alone.
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

/** "(2 selected) <question>": a multi-choice field asked again after a tick. */
export function isAskSelectedTitle(title: unknown): boolean {
  return typeof title === "string" && SELECTED_PREFIX.test(title);
}

/** A field's own question and the count its title announced (0 when it had no prefix). */
export function parseAskWalkTitle(title: string): { question: string; selected: number } {
  const match = SELECTED_PREFIX.exec(title);
  if (!match) return { question: title, selected: 0 };
  return { question: title.slice(match[0].length), selected: Number(match[1]) };
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
  kind: "option" | "other" | "done";
  ticked?: boolean;
  /** What the user typed behind a ticked Other row, while the screen knows it. */
  typed?: string;
}

/** A recognised step of the walk, attached to the `select` request it came from. */
export interface AskWalkView {
  /** The field's own question, without a "(N selected) " prefix. */
  question: string;
  /** Several rows can be ticked: a Done row ends the field. */
  multi: boolean;
  /** The count omp announced in the title (0 when it showed none). */
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
}

type WalkResponse = { value: string } | { confirmed: boolean } | { cancelled: true } | { answers: unknown };

/** The state of the multi-choice field being walked. */
interface Slot {
  question: string;
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
    if (row.kind === "done") return { label: row.label, kind: "done" };
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
  let plainPick: { question: string; label: string } | null = null;
  let memo: { id: string; view: AskWalkView | null } | null = null;
  // The newest dialog seen, of any kind: a withdrawn input ends the walk as much as a withdrawn select does.
  let latestId: string | null = null;
  // The step answered last: a second answer to it (a double tap) must not toggle twice.
  let repliedId: string | null = null;

  const compute = (request: WalkRequest): AskWalkView | null => {
    const options = request.options ?? [];
    const { question, selected } = parseAskWalkTitle(request.title ?? "");
    const doneAt = options.length > 0 && isAskDoneRow(options[options.length - 1]) ? options.length - 1 : -1;
    const continues = slot !== null && slot.question === question;
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
        return { question, multi: false, selected: 0, ticksKnown: false, rows: rowsOf() };
      }
      return null;
    }

    if (!continues || slot === null) {
      const pick = plainPick !== null && plainPick.question === question ? plainPick.label : null;
      slot = { question, ticked: new Set(), otherSet: false, otherText: "", known: selected === 0, otherInputNext: false };
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
    return { question, multi: true, selected, ticksKnown: slot.known, rows: renderRows(rows, slot, slot.known) };
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
        if (slot !== null && slot.otherInputNext && request.title === slot.question) {
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
        if (picked !== null && !isAskOtherRow(picked) && !isAskDoneRow(picked)) {
          plainPick = { question: parseAskWalkTitle(request.title ?? "").question, label: picked };
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
