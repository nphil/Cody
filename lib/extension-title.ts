import { parseAskWalkTitle } from "./ask-walk";

/**
 * Engine prompts put the question on line 1 and the details after it (omp's
 * saved-reset consent lists one line per account). The dock header is a single
 * ellipsized line, so it keeps the first line and the card body shows the rest.
 */
export function splitExtensionTitle(title: string): { headline: string; details: string } {
  const text = title.replace(/\r\n?/g, "\n").trim();
  const at = text.indexOf("\n");
  if (at < 0) return { headline: text, details: "" };
  return { headline: text.slice(0, at).trim(), details: text.slice(at + 1).trim() };
}

/** What a dialog says, split for the dock: the header's question and the card body. */
export interface ExtensionPrompt {
  /** The question. */
  headline: string;
  /** Everything else the prompt says, for the card body. */
  details: string;
  /** The model's `ask` tool is asking, so the card shows the text around the field as an explanation. */
  ask: boolean;
  /**
   * The card body repeats the question under the explanation: an ask with text around its field, or a question too
   * long for the header's two lines. A short question with nothing around it is left to the header.
   */
  inBody: boolean;
}

/** What one header line holds at phone width, in Latin characters; a CJK character is about twice as wide. */
const HEADER_LINE_CHARS = 34;

function headerWeight(text: string): number {
  let weight = 0;
  for (const char of text) weight += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
  return weight;
}

function askPrompt(question: string, context: string): ExtensionPrompt {
  const headline = question.trim();
  return { headline, details: context, ask: true, inBody: headline !== "" && (context !== "" || headerWeight(headline) > HEADER_LINE_CHARS) };
}

/**
 * The prompt of a `select`, `input`, `editor` or `confirm` dialog. The model's `ask` tool puts the question LAST,
 * under the text around the field (omp 18.20, lib/ask-walk.ts); every other engine prompt puts it on line 1.
 * A step of the ask walk has been split already, by the tracker that recognised it.
 */
export function extensionPrompt(request: { title: string; walk?: { question: string; context: string } }, fromAsk: boolean): ExtensionPrompt {
  if (request.walk) return askPrompt(request.walk.question, request.walk.context);
  if (fromAsk) {
    const { context, question } = parseAskWalkTitle(request.title.replace(/\r\n?/g, "\n").trim());
    return askPrompt(question, context);
  }
  return { ...splitExtensionTitle(request.title), ask: false, inBody: false };
}
