import { EdlError } from "./edl-link";

/**
 * A Firehose programmer talks in tiny XML documents:
 *
 *   <?xml version="1.0" encoding="UTF-8" ?><data><log value="INFO: ..." /></data>
 *   <?xml version="1.0" encoding="UTF-8" ?><data><response value="ACK" rawmode="true" /></data>
 *
 * Whatever is on the other end of the cable is not trusted, so this is not a
 * general XML parser. It understands exactly that shape, refuses everything else
 * (DOCTYPE, entity declarations, CDATA, processing instructions other than the
 * prolog, unknown entities), expands nothing but the five predefined entities and
 * numeric references, and every dimension is bounded: bytes per document,
 * elements, attributes, name and value lengths, nesting. A document that exceeds
 * a bound is an error, never a truncation.
 */

export const FIREHOSE_XML_LIMITS = {
  /** Bytes from the first `<` to the closing `</data>`. */
  documentBytes: 256 * 1024,
  elements: 512,
  attributesPerElement: 32,
  nameChars: 64,
  valueChars: 16 * 1024,
  depth: 8,
  /** Non-`<` bytes tolerated before a document (some programmers emit a stray byte or two). */
  leadingJunkBytes: 64,
  /** Whitespace tolerated before the answer that must follow raw sector data. */
  strictLeadingBytes: 8,
} as const;

export interface FirehoseElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly depth: number;
}

export interface FirehoseDocument {
  readonly elements: readonly FirehoseElement[];
  /** Values of every `<log value="..."/>`, cleaned for display. */
  readonly logs: readonly string[];
  /** Attributes of every `<response .../>`. */
  readonly responses: readonly Readonly<Record<string, string>>[];
  /** Non-whitespace text between tags; the commands Cody sends contain none. */
  readonly strayText: boolean;
  /** Comments, processing instructions other than the prolog. */
  readonly extras: number;
}

export type FirehoseFrame =
  | { readonly kind: "incomplete" }
  | { readonly kind: "document"; readonly end: number; readonly document: FirehoseDocument };

const CLOSER = "</data>";
const NAME_START = /[A-Za-z_]/;
const NAME_REST = /[A-Za-z0-9_.:-]/;
const decoder = new TextDecoder("utf-8", { fatal: false });

function malformed(message: string, at?: number): EdlError {
  return new EdlError(`The Firehose programmer sent malformed XML${at === undefined ? "" : ` (at character ${at})`}: ${message}.`);
}

/** Replaces control characters (terminal escapes, NULs) so device-supplied text is safe to show and store. */
export function cleanDeviceText(text: string, maxChars = 1024): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    out += code < 0x20 && code !== 0x09 && code !== 0x0a ? "\uFFFD" : code === 0x7f || (code >= 0x80 && code < 0xa0) ? "\uFFFD" : char;
    if (out.length >= maxChars) return `${out.slice(0, maxChars)} …[cut]`;
  }
  return out;
}

function decodeEntities(raw: string, at: number): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char !== "&") { out += char; continue; }
    const semicolon = raw.indexOf(";", index);
    if (semicolon === -1 || semicolon - index > 12) throw malformed("an entity reference is not terminated", at + index);
    const body = raw.slice(index + 1, semicolon);
    index = semicolon;
    if (body === "amp") out += "&";
    else if (body === "lt") out += "<";
    else if (body === "gt") out += ">";
    else if (body === "quot") out += '"';
    else if (body === "apos") out += "'";
    else {
      const numeric = /^#(?:([0-9]{1,7})|x([0-9a-fA-F]{1,6}))$/.exec(body);
      if (!numeric) throw malformed(`the entity &${body}; is not one of the five predefined ones`, at + index);
      const code = numeric[1] ? Number.parseInt(numeric[1], 10) : Number.parseInt(numeric[2]!, 16);
      const valid = code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
      if (!valid) throw malformed(`the character reference &${body}; is not a legal XML character`, at + index);
      out += String.fromCodePoint(code);
    }
  }
  return out;
}

/** Parses ONE `<data>...</data>` document (optionally with its `<?xml ?>` prolog) under the bounds above. */
export function parseFirehoseDocument(text: string): FirehoseDocument {
  const limits = FIREHOSE_XML_LIMITS;
  const elements: FirehoseElement[] = [];
  const logs: string[] = [];
  const responses: Record<string, string>[] = [];
  const stack: string[] = [];
  let strayText = false;
  let extras = 0;
  let index = 0;
  let sawRoot = false;
  let sawProlog = false;

  while (index < text.length) {
    const lt = text.indexOf("<", index);
    const between = text.slice(index, lt === -1 ? text.length : lt);
    if (/[^\s\u0000]/.test(between)) strayText = true;
    if (lt === -1) break;
    index = lt;

    if (text.startsWith("<?", index)) {
      const close = text.indexOf("?>", index + 2);
      if (close === -1 || close - index > 512) throw malformed("a processing instruction is not terminated", index);
      const isProlog = /^<\?xml[\s?]/.test(text.slice(index, close + 2));
      // One prolog, before the root, is ordinary; any other processing instruction is an extra.
      if (sawRoot || !isProlog || sawProlog) extras += 1;
      if (isProlog) sawProlog = true;
      index = close + 2;
      continue;
    }
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      if (close === -1 || close - index > 4096) throw malformed("a comment is not terminated", index);
      extras += 1;
      index = close + 3;
      continue;
    }
    if (text.startsWith("<!", index)) throw malformed("DOCTYPE, entity and CDATA sections are not accepted", index);

    if (text.startsWith("</", index)) {
      const close = text.indexOf(">", index);
      if (close === -1 || close - index > limits.nameChars + 8) throw malformed("a closing tag is not terminated", index);
      const name = text.slice(index + 2, close).trim();
      if (stack.pop() !== name) throw malformed(`</${cleanDeviceText(name, 32)}> does not close the element that is open`, index);
      index = close + 1;
      continue;
    }

    // An opening tag.
    let cursor = index + 1;
    if (!NAME_START.test(text[cursor] ?? "")) throw malformed("a tag has no valid name", index);
    const nameStart = cursor;
    while (cursor < text.length && NAME_REST.test(text[cursor]!)) {
      cursor += 1;
      if (cursor - nameStart > limits.nameChars) throw malformed("a tag name is too long", index);
    }
    const name = text.slice(nameStart, cursor);
    const attributes: Record<string, string> = {};
    let count = 0;
    let selfClosing = false;
    for (;;) {
      while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
      if (cursor >= text.length) throw malformed(`<${name}> is not terminated`, index);
      if (text[cursor] === ">") { cursor += 1; break; }
      if (text[cursor] === "/" && text[cursor + 1] === ">") { selfClosing = true; cursor += 2; break; }
      if (!NAME_START.test(text[cursor]!)) throw malformed(`an attribute of <${name}> has no valid name`, cursor);
      const attributeStart = cursor;
      while (cursor < text.length && NAME_REST.test(text[cursor]!)) {
        cursor += 1;
        if (cursor - attributeStart > limits.nameChars) throw malformed("an attribute name is too long", attributeStart);
      }
      const attribute = text.slice(attributeStart, cursor);
      while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
      if (text[cursor] !== "=") throw malformed(`attribute ${attribute} has no value`, cursor);
      cursor += 1;
      while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
      const quote = text[cursor];
      if (quote !== '"' && quote !== "'") throw malformed(`attribute ${attribute} is not quoted`, cursor);
      const valueStart = cursor + 1;
      const valueEnd = text.indexOf(quote, valueStart);
      if (valueEnd === -1) throw malformed(`attribute ${attribute} is not terminated`, cursor);
      if (valueEnd - valueStart > limits.valueChars) throw malformed(`attribute ${attribute} is longer than ${limits.valueChars} characters`, cursor);
      const rawValue = text.slice(valueStart, valueEnd);
      if (rawValue.includes("<")) throw malformed(`attribute ${attribute} contains a raw '<'`, valueStart);
      count += 1;
      if (count > limits.attributesPerElement) throw malformed(`<${name}> has more than ${limits.attributesPerElement} attributes`, index);
      if (attribute in attributes) throw malformed(`<${name}> repeats the attribute ${attribute}`, attributeStart);
      attributes[attribute] = cleanDeviceText(decodeEntities(rawValue, valueStart), limits.valueChars);
      cursor = valueEnd + 1;
    }
    if (stack.length >= limits.depth) throw malformed("elements are nested too deeply", index);
    if (elements.length >= limits.elements) throw malformed(`the document has more than ${limits.elements} elements`, index);
    elements.push({ name, attributes, depth: stack.length });
    sawRoot = true;
    if (name === "log" && typeof attributes.value === "string") logs.push(attributes.value);
    if (name === "response") responses.push(attributes);
    if (!selfClosing) stack.push(name);
    index = cursor;
  }
  if (stack.length > 0) throw malformed(`<${stack[stack.length - 1]}> is never closed`);
  if (!sawRoot) throw malformed("the document has no elements");
  return { elements, logs, responses, strayText, extras };
}

function indexOfBytes(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let index = from; index + needle.length <= bytes.length; index += 1) {
    for (let inner = 0; inner < needle.length; inner += 1) if (bytes[index + inner] !== needle[inner]) continue outer;
    return index;
  }
  return -1;
}

const closerBytes = new TextEncoder().encode(CLOSER);

/**
 * Looks for one complete document at the start of `bytes`. `incomplete` means
 * "wait for more"; anything that can never become a document throws.
 * `strict` is for the answer that must follow raw sector data directly: only a
 * few whitespace bytes may precede it, so a data stream that is off by even one
 * byte is reported instead of being silently accepted.
 */
export function scanFirehoseFrame(bytes: Uint8Array, strict = false): FirehoseFrame {
  const limits = FIREHOSE_XML_LIMITS;
  let first = 0;
  while (first < bytes.length && bytes[first] !== 0x3c) first += 1;
  const allowed = strict ? limits.strictLeadingBytes : limits.leadingJunkBytes;
  if (first > allowed) {
    throw new EdlError(strict
      ? `The Firehose programmer's answer did not follow the sector data directly (${first} unexpected byte(s) came first). The data stream is misaligned, so nothing read from it can be trusted.`
      : `Expected Firehose XML but the device sent ${first} bytes of something else first.`);
  }
  if (strict) {
    for (let index = 0; index < first; index += 1) {
      const byte = bytes[index]!;
      if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09) {
        throw new EdlError("The Firehose programmer's answer did not follow the sector data directly (unexpected bytes came first). The data stream is misaligned, so nothing read from it can be trusted.");
      }
    }
  }
  if (first >= bytes.length) return { kind: "incomplete" };
  const close = indexOfBytes(bytes, closerBytes, first);
  if (close === -1) {
    if (bytes.length - first > limits.documentBytes) throw malformed(`a document is longer than ${limits.documentBytes} bytes without ending`);
    return { kind: "incomplete" };
  }
  const end = close + closerBytes.length;
  if (end - first > limits.documentBytes) throw malformed(`a document is longer than ${limits.documentBytes} bytes`);
  return { kind: "document", end, document: parseFirehoseDocument(decoder.decode(bytes.subarray(first, end))) };
}

/** How far back into the sector data an answer that began early can have started. A closing answer is about a hundred bytes. */
const MAX_ANSWER_OVERLAP_BYTES = 1024;
const ANSWER_STARTS = ["<?xml", "<data", "<response", "<log"];

function startsLikeAnswer(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  return ANSWER_STARTS.some((start) => head.startsWith(start));
}

/**
 * Raw sector data and the programmer's closing answer are separate messages, but
 * a byte stream does not show where one ends. A programmer that delivers FEWER
 * bytes than it promised makes the host take the first bytes of its closing
 * answer for the missing data, and when what is swallowed is exactly the XML
 * declaration, what is left still reads as a complete answer.
 *
 * `tail` is the end of the data as received, `answer` the complete document that
 * followed it. Returns the number of bytes at the end of `tail` that are really
 * the start of that document (how short the data came up), or `null` when the
 * answer begins where the data ended. Data that merely looks like the start of an
 * answer does not count: the document has to run on INTO the answer, as a single
 * well-formed document with no second declaration, for the check to fire.
 */
export function answerBeganInsideData(tail: Uint8Array, answer: Uint8Array): number | null {
  const longest = Math.min(tail.length, MAX_ANSWER_OVERLAP_BYTES);
  for (let overlap = 1; overlap <= longest; overlap += 1) {
    const start = tail.length - overlap;
    if (tail[start] !== 0x3c) continue;
    const joined = new Uint8Array(overlap + answer.length);
    joined.set(tail.subarray(start), 0);
    joined.set(answer, overlap);
    if (!startsLikeAnswer(joined)) continue;
    try {
      const frame = scanFirehoseFrame(joined, true);
      if (frame.kind === "document" && frame.end > overlap && frame.document.extras === 0 && !frame.document.strayText) return overlap;
    } catch {
      // Not a document that begins in the data; keep looking.
    }
  }
  return null;
}

const ANSWER_ELEMENTS: readonly string[] = ["data", "log", "response"];

/**
 * Raw sector data that ENDS with a complete message of the programmer's own - a log line or a response, followed by at
 * most white space - came up short by that message: the programmer sent it where the last bytes of data belong, and the
 * host took it for sector bytes. Returns the length of that text in bytes (the data is at least that short), or `null`.
 * The message must have arrived as a transfer of its own: `boundaries` are the distances from the end of the data at which the
 * device ended a USB transfer, and the message has to begin at one of them. Sector data that merely contains such text,
 * even a whole answer, sits inside a data transfer and is still data. Only documents made of `data`, `log` and `response`
 * elements count.
 */
export function dataEndsWithAnswer(tail: Uint8Array, boundaries: readonly number[]): number | null {
  const longest = Math.min(tail.length, MAX_ANSWER_OVERLAP_BYTES);
  for (let length = 1; length <= longest; length += 1) {
    if (!boundaries.includes(length)) continue;
    const candidate = tail.subarray(tail.length - length);
    if (candidate[0] !== 0x3c || !startsLikeAnswer(candidate)) continue;
    try {
      const frame = scanFirehoseFrame(candidate, true);
      if (frame.kind !== "document" || frame.document.extras !== 0 || frame.document.strayText) continue;
      if (!frame.document.elements.every((element) => ANSWER_ELEMENTS.includes(element.name))) continue;
      if (candidate.subarray(frame.end).every((byte) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09)) return length;
    } catch {
      // Not a document that ends the data; keep looking.
    }
  }
  return null;
}
