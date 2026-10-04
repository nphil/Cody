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

/** White space: all a strict read tolerates before a document, and what pads one. */
function isWhiteSpaceByte(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/** Padding around a document: white space, and the NUL bytes some programmers fill a transfer out with. */
export function isPaddingByte(byte: number): boolean {
  return byte === 0x00 || isWhiteSpaceByte(byte);
}

export type LeadBeforeDocument =
  /** The document's `<` stands after `length` tolerated bytes. */
  | { readonly kind: "found"; readonly length: number }
  /** Only tolerated bytes so far, and no `<` yet: more may come. */
  | { readonly kind: "waiting" }
  /** More than the allowed number of bytes come before the `<`. */
  | { readonly kind: "too-long"; readonly length: number }
  /** A strict read met a byte that is not white space before the `<`. */
  | { readonly kind: "not-white-space" };

/**
 * THE rule for what may stand before a document's `<`, used by the reader (`scanFirehoseFrame`) and by everything that must
 * recognise what the reader would read as a message (`RawMessageWatch`), so that the two cannot disagree. A `strict` read, of
 * the answer that must follow raw sector data, tolerates a few bytes of white space; any other read tolerates a stray byte
 * or two (anything but `<`, up to `leadingJunkBytes`).
 */
export function leadBeforeDocument(bytes: Uint8Array, strict: boolean): LeadBeforeDocument {
  const allowed = strict ? FIREHOSE_XML_LIMITS.strictLeadingBytes : FIREHOSE_XML_LIMITS.leadingJunkBytes;
  let first = 0;
  while (first < bytes.length && bytes[first] !== 0x3c) first += 1;
  if (first > allowed) return { kind: "too-long", length: first };
  if (strict) {
    for (let index = 0; index < first; index += 1) {
      if (!isWhiteSpaceByte(bytes[index]!)) return { kind: "not-white-space" };
    }
  }
  return first >= bytes.length ? { kind: "waiting" } : { kind: "found", length: first };
}

/**
 * Looks for one complete document at the start of `bytes`. `incomplete` means
 * "wait for more"; anything that can never become a document throws.
 * `strict` is for the answer that must follow raw sector data directly: only a
 * few whitespace bytes may precede it, so a data stream that is off by even one
 * byte is reported instead of being silently accepted.
 */
export function scanFirehoseFrame(bytes: Uint8Array, strict = false): FirehoseFrame {
  const limits = FIREHOSE_XML_LIMITS;
  const lead = leadBeforeDocument(bytes, strict);
  if (lead.kind === "too-long") {
    throw new EdlError(strict
      ? `The Firehose programmer's answer did not follow the sector data directly (${lead.length} unexpected byte(s) came first). The data stream is misaligned, so nothing read from it can be trusted.`
      : `Expected Firehose XML but the device sent ${lead.length} bytes of something else first.`);
  }
  if (lead.kind === "not-white-space") {
    throw new EdlError("The Firehose programmer's answer did not follow the sector data directly (unexpected bytes came first). The data stream is misaligned, so nothing read from it can be trusted.");
  }
  if (lead.kind === "waiting") return { kind: "incomplete" };
  const first = lead.length;
  const close = indexOfBytes(bytes, closerBytes, first);
  if (close === -1) {
    if (bytes.length - first > limits.documentBytes) throw malformed(`a document is longer than ${limits.documentBytes} bytes without ending`);
    return { kind: "incomplete" };
  }
  const end = close + closerBytes.length;
  if (end - first > limits.documentBytes) throw malformed(`a document is longer than ${limits.documentBytes} bytes`);
  return { kind: "document", end, document: parseFirehoseDocument(decoder.decode(bytes.subarray(first, end))) };
}

/** How a programmer's documents begin. */
const ANSWER_STARTS = ["<?xml", "<data", "<response", "<log"];

const ANSWER_ELEMENTS: readonly string[] = ["data", "log", "response"];
/** The most data one stretch may hold to be examined: a few exchanges' worth of the programmer's own text. A longer stretch is not a message. */
const MAX_STRETCH_BYTES = 2 * 1024 * 1024;
/** How much of the start of a stretch settles whether it can be a message: the lead a reader tolerates, then the start of a document. */
const HEAD_BYTES = FIREHOSE_XML_LIMITS.leadingJunkBytes + Math.max(...ANSWER_STARTS.map((start) => start.length));
const latin1 = new TextDecoder("latin1");

/**
 * Whether a stretch that begins with `head` has a `<` within what the reader tolerates in front of a document
 * (`leadBeforeDocument`, the reader's own rule), followed by the start of one of the programmer's documents.
 */
function opensAMessage(head: Uint8Array): boolean {
  const lead = leadBeforeDocument(head, false);
  if (lead.kind !== "found") return false;
  const text = latin1.decode(head.subarray(lead.length, lead.length + HEAD_BYTES));
  return ANSWER_STARTS.some((start) => {
    const shared = Math.min(start.length, text.length);
    return text.slice(0, shared) === start.slice(0, shared);
  });
}

/** Whether a stretch that begins with `head` can still be a message: it opens one, or has so far only what the reader tolerates in front of one. Undecided counts as yes. */
function canOpenAMessage(head: Uint8Array): boolean {
  return leadBeforeDocument(head, false).kind === "waiting" || opensAMessage(head);
}

/** Whether `bytes` is nothing but complete programmer documents - log lines and answers - each read as the reader reads it, with only padding after the last. */
function onlyProgrammerMessages(bytes: Uint8Array): boolean {
  let at = 0;
  let documents = 0;
  for (;;) {
    let rest = at;
    while (rest < bytes.length && isPaddingByte(bytes[rest]!)) rest += 1;
    if (rest >= bytes.length) return documents > 0;
    try {
      const frame = scanFirehoseFrame(bytes.subarray(at), false);
      if (frame.kind !== "document" || frame.document.extras !== 0 || frame.document.strayText) return false;
      if (!frame.document.elements.every((element) => ANSWER_ELEMENTS.includes(element.name))) return false;
      documents += 1;
      at += frame.end;
    } catch {
      return false;
    }
  }
}

/** What a stretch of the data turned out to be: a whole message, only white space, or the beginning of a message. */
export type SwallowedKind = "message" | "padding" | "opening";

/** A stretch of raw data that is the programmer's own text and not the disk's. */
export interface SwallowedMessage {
  /** Bytes from the start of the data to where it begins. */
  readonly at: number;
  /** Bytes of text it is. */
  readonly length: number;
  readonly kind: SwallowedKind;
}

/**
 * Raw sector data and the programmer's own text (log lines, answers, the white space it puts in front of them) are separate
 * USB transfers, but the host counts bytes, so text that arrives while data is still owed is taken for sector bytes - and a
 * programmer that is short of data by exactly that much looks complete. What the bytes say cannot tell the two apart (a disk
 * may hold any text, even a whole answer); how they arrived can: the programmer sends each piece of its own text as a transfer
 * of its own, so text that was delivered as data fills exactly one stretch between two ends of the device's transfers.
 *
 * The raw data of one read is fed in order, with the offsets (within each chunk) at which the device ended a transfer. The
 * start of the data counts as the start of a stretch - the announcing answer was a transfer of its own - and the end of the
 * data as the end of one, so a message that is ALL the data (not one disk byte arrived) is found too. Three things are
 * refused, wherever they sit:
 *
 *  - `message`: a stretch of any size that is nothing but complete `data`, `log` and `response` documents, read the way the
 *    reader reads them (including what it tolerates in front of a document and the padding after one);
 *  - `padding`: a stretch shorter than one sector that is nothing but white space - what the reader skips in front of an
 *    answer, so a programmer that is short by that lead and sends it as a transfer of its own would otherwise pass;
 *  - `opening`: a stretch shorter than one sector that begins like one of the programmer's documents (an XML declaration,
 *    a tag) - the first part of an answer sent as a transfer of its own.
 *
 * The last two rest on one fact: disk data arrives in whole sectors, so a transfer of the device's own that is shorter than a
 * sector is not disk data when it is text the reader would skip or open. They apply only to a stretch whose END the device
 * marked (a short packet or a zero-length packet): a sub-sector piece of a longer transfer is the alignment rule's to judge.
 * NUL and 0xFF stretches are never refused, so erased flash is data whatever size the programmer's transfers are; a sector of
 * white space is a sector of blanks, and so is any stretch longer than that. Text that is only part of a transfer of data is
 * data, and so is a stretch longer than 2 MiB. What cannot be seen is text that shares a USB transfer with real data.
 *
 * This is not the alignment rule's job and cannot be: text that is a transfer of its own and completes the byte count ends
 * exactly where a transfer ends, so the data looks aligned (and it can repeat on every read, so a second read agrees).
 */
export class RawMessageWatch {
  private offset = 0;
  private begun = 0;
  private parts: Uint8Array[] = [];
  private held = 0;
  private alive = true;
  private judged = false;
  /** Every byte of the stretch so far is white space. */
  private white = true;

  /** `sectorSize` is the unit the disk's data comes in: a transfer shorter than that is not disk data when it is the programmer's padding or the start of its text. */
  constructor(private readonly sectorSize: number) {}

  /** `ends` are offsets within `chunk` (0 to its length) at which the device ended a transfer; `last` marks the end of the data. */
  feed(chunk: Uint8Array, ends: readonly number[], last: boolean): SwallowedMessage | null {
    let cursor = 0;
    for (const end of ends) {
      if (end < cursor || end > chunk.length) continue;
      this.extend(chunk.subarray(cursor, end));
      cursor = end;
      const found = this.close(true);
      if (found) return found;
    }
    this.extend(chunk.subarray(cursor));
    return last ? this.close(false) : null;
  }

  private extend(bytes: Uint8Array): void {
    if (bytes.length > 0 && this.white && !bytes.every(isWhiteSpaceByte)) this.white = false;
    if (this.alive && bytes.length > 0) {
      if (this.held + bytes.length > MAX_STRETCH_BYTES) this.alive = false;
      else {
        if (!this.judged) {
          const head = this.held === 0 ? bytes.subarray(0, HEAD_BYTES) : this.head(bytes);
          if (!canOpenAMessage(head)) this.alive = false;
          else if (this.held + bytes.length >= HEAD_BYTES) this.judged = true;
        }
        if (this.alive) {
          this.parts.push(Uint8Array.from(bytes));
          this.held += bytes.length;
        }
      }
      if (!this.alive) {
        this.parts = [];
        this.held = 0;
      }
    }
    this.offset += bytes.length;
  }

  /** The first bytes of the stretch so far followed by `next`, as many as settle whether it can be a message. */
  private head(next: Uint8Array): Uint8Array {
    const out = new Uint8Array(Math.min(HEAD_BYTES, this.held + next.length));
    let at = 0;
    for (const part of [...this.parts, next]) {
      if (at >= out.length) break;
      const take = Math.min(part.length, out.length - at);
      out.set(part.subarray(0, take), at);
      at += take;
    }
    return out;
  }

  private text(): Uint8Array {
    const out = new Uint8Array(this.held);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /** Ends the stretch. `endSeen`: the device marked its end there (a short packet or a zero-length packet). */
  private close(endSeen: boolean): SwallowedMessage | null {
    const size = this.offset - this.begun;
    let found: SwallowedMessage | null = null;
    if (size > 0) {
      if (this.alive && onlyProgrammerMessages(this.text())) found = { at: this.begun, length: size, kind: "message" };
      else if (endSeen && size < this.sectorSize) {
        if (this.white) found = { at: this.begun, length: size, kind: "padding" };
        else if (this.alive && opensAMessage(this.text())) found = { at: this.begun, length: size, kind: "opening" };
      }
    }
    this.begun = this.offset;
    this.parts = [];
    this.held = 0;
    this.alive = true;
    this.judged = false;
    this.white = true;
    return found;
  }
}
