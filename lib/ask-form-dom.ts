import { NAMED_ENTITIES } from "./ask-form-entities";

/**
 * A small, tolerant HTML tree for the `ask` form view (omp >= 19.1).
 *
 * omp's `ask` tool sends the model's own `<form>` HTML to the host and rejects any answer that does not fit the
 * form it parsed itself. Cody therefore has to read the HTML the way omp does: this is a port of the tokenizer
 * and tree builder in omp's `dom/parser.ts` (implicit `<p>`/`<li>`/`<td>`/`<option>` closing, void elements,
 * raw `<script>`/`<style>` text, a named-entity table, SVG children), reduced to the few DOM operations the
 * form rules need. It is NOT an HTML5 parser (a `<textarea>` body is parsed like any element, as in omp), and
 * it is pure TypeScript so Node tests and the browser read a form identically.
 */

export interface DomText {
  kind: "text";
  data: string;
  /** An HTML comment: skipped by the walkers, but its text still counts in `textContent` as in omp. */
  comment?: true;
}

export interface DomElement {
  kind: "element";
  /** Lower-case tag name; every rule matches on this. */
  tag: string;
  /** Tag name as written (SVG names are case sensitive: `linearGradient`). */
  name: string;
  /** Inside an `<svg>` (the element itself included). */
  svg: boolean;
  attrs: [name: string, value: string][];
  children: DomNode[];
  parent: DomElement | undefined;
}

export type DomNode = DomText | DomElement;

const VOID_ELEMENTS: Record<string, true> = {
  area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true,
  link: true, meta: true, param: true, source: true, track: true, wbr: true,
};

const CLOSE_ON_OPEN: Record<string, readonly string[]> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr"],
  th: ["th", "td"],
  td: ["th", "td"],
  option: ["option"],
  thead: ["thead", "tbody", "tfoot"],
  tbody: ["thead", "tbody", "tfoot"],
  tfoot: ["thead", "tbody", "tfoot"],
};

/** Tags that implicitly close an open `<p>`. */
const P_CLOSERS: Record<string, true> = {
  address: true, article: true, aside: true, blockquote: true, div: true, dl: true, fieldset: true, footer: true,
  form: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, header: true, hr: true, menu: true,
  nav: true, ol: true, p: true, pre: true, section: true, table: true, ul: true,
};

const RAW_TEXT_CLOSE: Record<string, RegExp> = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };
const DOCTYPE_PATTERN = /<!doctype\b/iy;
const TAG_NAME_PATTERN = /[^\s/>]+/y;
const ATTRIBUTE_NAME_PATTERN = /[^\s=/>]+/y;
const UNQUOTED_VALUE_PATTERN = /[^\s>]+/y;
const ENTITY_PATTERN = /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi;

/** Decode the named entities in the table and every valid numeric character reference. */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY_PATTERN, (whole, entity: string) => {
    if (entity[0] !== "#") return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    const hexadecimal = entity[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return "\ufffd";
    }
    return String.fromCodePoint(codePoint);
  });
}

function isDoctypeAt(html: string, index: number): boolean {
  DOCTYPE_PATTERN.lastIndex = index;
  return DOCTYPE_PATTERN.test(html);
}

function findTagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return html.length - 1;
}

const isSpace = (character: string | undefined) => character !== undefined && /\s/.test(character);

function parseStartTag(source: string): { name: string; raw: string; attributes: [string, string][]; selfClosing: boolean } | null {
  let index = 0;
  while (isSpace(source[index])) index += 1;
  TAG_NAME_PATTERN.lastIndex = index;
  const nameMatch = TAG_NAME_PATTERN.exec(source);
  if (!nameMatch) return null;
  const raw = nameMatch[0];
  index += raw.length;
  const attributes: [string, string][] = [];
  let selfClosing = false;
  while (index < source.length) {
    while (isSpace(source[index])) index += 1;
    if (source[index] === "/") {
      selfClosing = true;
      break;
    }
    ATTRIBUTE_NAME_PATTERN.lastIndex = index;
    const attributeMatch = ATTRIBUTE_NAME_PATTERN.exec(source);
    if (!attributeMatch) break;
    const attributeName = attributeMatch[0];
    index += attributeName.length;
    while (isSpace(source[index])) index += 1;
    let value = "";
    if (source[index] === "=") {
      index += 1;
      while (isSpace(source[index])) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const end = source.indexOf(quote, index);
        if (end < 0) {
          value = source.slice(index);
          index = source.length;
        } else {
          value = source.slice(index, end);
          index = end + 1;
        }
      } else {
        UNQUOTED_VALUE_PATTERN.lastIndex = index;
        value = UNQUOTED_VALUE_PATTERN.exec(source)?.[0] ?? "";
        index += value.length;
      }
    }
    const lower = attributeName.toLowerCase();
    if (!attributes.some(([existing]) => existing.toLowerCase() === lower)) attributes.push([attributeName, decodeEntities(value)]);
  }
  return { name: raw.toLowerCase(), raw, attributes, selfClosing };
}

/** Parse markup into a tree; the returned root is a `#document` element holding the top-level nodes. */
export function parseHtml(html: string): DomElement {
  const root: DomElement = { kind: "element", tag: "#document", name: "#document", svg: false, attrs: [], children: [], parent: undefined };
  const stack: DomElement[] = [];
  const append = (parent: DomElement, node: DomNode) => {
    if (node.kind === "element") node.parent = parent;
    parent.children.push(node);
  };
  let parent: DomElement = root;
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      const contentEnd = end < 0 ? html.length : end;
      append(parent, { kind: "text", data: html.slice(index + 4, contentEnd), comment: true });
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const end = next < 0 ? html.length : next;
      append(parent, { kind: "text", data: decodeEntities(html.slice(index, end)) });
      index = end;
      continue;
    }
    if (html[index + 1] === "!" && isDoctypeAt(html, index)) {
      const end = html.indexOf(">", index + 2);
      index = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("<![CDATA[", index)) {
      const end = html.indexOf("]]>", index + 9);
      const contentEnd = end < 0 ? html.length : end;
      append(parent, { kind: "text", data: html.slice(index + 9, contentEnd) });
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[index + 1] === "/") {
      const end = findTagEnd(html, index + 2);
      const closingName = (html.slice(index + 2, end).trim().split(/\s/, 1)[0] ?? "").toLowerCase();
      const matchIndex = stack.findLastIndex((element) => element.tag === closingName);
      if (matchIndex >= 0) stack.length = matchIndex;
      parent = stack[stack.length - 1] ?? root;
      index = end + 1;
      continue;
    }
    if (html[index + 1] === "!" || html[index + 1] === "?") {
      const end = html.indexOf(">", index + 2);
      index = end < 0 ? html.length : end + 1;
      continue;
    }
    const end = findTagEnd(html, index + 1);
    const parsed = parseStartTag(html.slice(index + 1, end));
    if (!parsed) {
      append(parent, { kind: "text", data: "<" });
      index += 1;
      continue;
    }
    const current = stack[stack.length - 1];
    if (current) {
      if (current.tag === "p" && P_CLOSERS[parsed.name]) stack.pop();
      else if (CLOSE_ON_OPEN[parsed.name]?.includes(current.tag)) stack.pop();
    }
    parent = stack[stack.length - 1] ?? root;
    const svg = parsed.name === "svg" || (parent !== root && parent.svg);
    const element: DomElement = { kind: "element", tag: parsed.name, name: svg ? parsed.raw : parsed.name, svg, attrs: parsed.attributes, children: [], parent: undefined };
    append(parent, element);
    index = end + 1;
    const rawClose = Object.hasOwn(RAW_TEXT_CLOSE, parsed.name) ? RAW_TEXT_CLOSE[parsed.name] : undefined;
    if (rawClose && !parsed.selfClosing) {
      rawClose.lastIndex = index;
      const match = rawClose.exec(html);
      const rawEnd = match?.index ?? html.length;
      append(element, { kind: "text", data: html.slice(index, rawEnd) });
      index = match ? rawClose.lastIndex : html.length;
      continue;
    }
    if (!(VOID_ELEMENTS[parsed.name] || (svg && parsed.selfClosing))) {
      stack.push(element);
      parent = element;
    }
  }
  return root;
}

/** An attribute's value (names match case-insensitively), or null when absent. */
export function attr(element: DomElement, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [attributeName, value] of element.attrs) if (attributeName.toLowerCase() === lower) return value;
  return null;
}

export function hasAttr(element: DomElement, name: string): boolean {
  return attr(element, name) !== null;
}

/** Text of a node and its descendants (comments included, as omp's `textContent` does). */
export function textContent(node: DomNode): string {
  if (node.kind === "text") return node.data;
  let text = "";
  for (const child of node.children) text += textContent(child);
  return text;
}

export function elementChildren(element: DomElement): DomElement[] {
  return element.children.filter((child): child is DomElement => child.kind === "element");
}

/** Descendant elements (not the root itself) that pass `test`, in document order. */
export function descendants(root: DomElement, test: (element: DomElement) => boolean): DomElement[] {
  const found: DomElement[] = [];
  const visit = (element: DomElement) => {
    for (const child of element.children) {
      if (child.kind !== "element") continue;
      if (test(child)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

/** The element itself or its nearest ancestor with `tag`. */
export function closest(element: DomElement, tag: string): DomElement | undefined {
  for (let current: DomElement | undefined = element; current; current = current.parent) {
    if (current.tag === tag) return current;
  }
  return undefined;
}

/** Whether `inner` is `outer` or sits inside it. */
export function contains(outer: DomElement, inner: DomElement): boolean {
  for (let current: DomElement | undefined = inner; current; current = current.parent) {
    if (current === outer) return true;
  }
  return false;
}

const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/\u00a0/g, "&#160;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Serialize a subtree as well-formed markup (an `<svg>` for an XML image). */
export function outerHtml(node: DomNode): string {
  if (node.kind === "text") return node.comment ? `<!--${node.data}-->` : escapeText(node.data);
  const attributes = node.attrs.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
  return `<${node.name}${attributes}>${node.children.map(outerHtml).join("")}</${node.name}>`;
}
