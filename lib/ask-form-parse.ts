import {
  type DomElement,
  type DomNode,
  attr,
  closest,
  contains,
  descendants,
  elementChildren,
  hasAttr,
  outerHtml,
  parseHtml,
  textContent,
} from "./ask-form-dom";

/**
 * Reduces the model's `<form>` HTML to what Cody draws (omp >= 19.1 `ask`). A port of omp's
 * `pi-tui/src/html-form/parse.ts`: the same sections, blocks, fields and grouping rules, because omp validates
 * the submitted data against ITS parse of this HTML and fails the tool call on any mismatch.
 *
 * Titled sections (one per top-level `<fieldset>`, plus untitled runs of loose content between them), context
 * blocks (paragraphs, headings, lists, preformatted text, tables, images, inline SVG) and fields. Radios and
 * checkboxes join one `ChoiceField` per `type` + `name` wherever they appear. Layout-only markup (wrapper
 * `<div>`s, `style`, buttons) is dropped: Cody owns layout and Submit/Cancel.
 *
 * One deliberate difference from omp: a newline in the source text is plain whitespace here (omp's terminal
 * draws it as a line break); only `<br>` makes a line break. This only changes how text is drawn, never the
 * fields or the answer data.
 */

/** Inline emphasis a span keeps from `<code>`, `<strong>`/`<b>` and `<em>`/`<i>`. */
export type FormSpanStyle = "code" | "strong" | "em";

/** A run of inline text; `"\n"` inside `text` is a hard line break (`<br>`). */
export interface FormSpan {
  text: string;
  style?: FormSpanStyle;
}

export interface ChoiceOption {
  value: string;
  label: FormSpan[];
  checked: boolean;
  disabled: boolean;
}

/** A radio group (`multi: false`), checkbox group (`multi: true`) or `<select>` (`select: true`). */
export interface ChoiceField {
  kind: "choice";
  name: string;
  multi: boolean;
  select: boolean;
  /** The UI adds a free-text "Other" answer: radio/checkbox groups of 2+ options without an "Other" option. */
  other: boolean;
  /** The control's own label; empty for radio/checkbox groups, whose question is the surrounding text. */
  label: FormSpan[];
  options: ChoiceOption[];
  required: boolean;
}

/** A single-line `<input>` (`multiline: false`) or a `<textarea>`. */
export interface TextField {
  kind: "text";
  name: string;
  /** The `<input type>` (`text`, `number`, `url`, ...); `textarea` for textareas. */
  type: string;
  multiline: boolean;
  label: FormSpan[];
  value: string;
  placeholder: string;
  required: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  /** Visible rows a textarea asked for (`rows`), 1 for inputs. */
  rows: number;
}

export type FormField = ChoiceField | TextField;

export type FormFieldBlock = { kind: "field"; field: FormField; optionsEnd?: number };

export type FormBlock =
  | { kind: "text"; spans: FormSpan[]; heading: boolean }
  | { kind: "list"; items: FormSpan[][]; ordered: boolean }
  | { kind: "pre"; text: string }
  | { kind: "table"; rows: FormSpan[][][]; headerRows: number }
  | { kind: "image"; src: string; alt: string }
  | { kind: "svg"; markup: string; alt: string }
  | FormFieldBlock;

export interface FormSection {
  title: FormSpan[];
  blocks: FormBlock[];
  /** A top-level `<fieldset>`, legend or not; `false` for loose content between fieldsets. */
  fieldset: boolean;
}

export interface HtmlForm {
  sections: FormSection[];
  fields: FormField[];
  hidden: [name: string, value: string][];
}

const SKIPPED: Record<string, true> = {
  button: true, head: true, iframe: true, link: true, meta: true, noscript: true, script: true, style: true, template: true, title: true,
};

const BLOCK: Record<string, true> = {
  address: true, article: true, aside: true, blockquote: true, dd: true, details: true, div: true, dl: true, dt: true,
  figure: true, figcaption: true, footer: true, header: true, li: true, main: true, nav: true, p: true, section: true,
};

const HEADING: Record<string, true> = { h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, summary: true };

const STYLE_OF: Record<string, FormSpanStyle> = {
  b: "strong", code: "code", em: "em", i: "em", kbd: "code", samp: "code", strong: "strong", tt: "code",
};

const IGNORED_INPUTS: Record<string, true> = { button: true, file: true, image: true, reset: true, submit: true };

const isControl = (element: DomElement) => element.tag === "input" || element.tag === "select" || element.tag === "textarea";
const hasControl = (element: DomElement) => descendants(element, isControl).length > 0;

/** Parse the model's form HTML; content outside the first `<form>` is ignored when one exists. */
export function parseHtmlForm(html: string): HtmlForm {
  const root = parseHtml(html);
  return new FormBuilder(descendants(root, (element) => element.tag === "form")[0] ?? root).build();
}

/** Append `text` to `spans`, merging into the previous span when the style matches. */
function appendSpan(spans: FormSpan[], text: string, style: FormSpanStyle | undefined): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last && last.style === style) last.text += text;
  else spans.push(style ? { text, style } : { text });
}

/** Source text is whitespace-collapsed like HTML layout: a newline in the markup is a space, not a break. */
const flowText = (data: string) => data.replace(/\r?\n|\r/g, " ");

/** Collapse whitespace like HTML layout does: runs become one space, spaces next to a hard break vanish, the ends are trimmed. */
function normalizeSpans(spans: FormSpan[]): FormSpan[] {
  const out: FormSpan[] = [];
  for (const span of spans) {
    const text = span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n");
    appendSpan(out, text, span.style);
  }
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((span) => span.text !== "");
}

/** Plain text of spans, for labels that fall back to a single string. */
export function spansText(spans: readonly FormSpan[]): string {
  return spans.map((span) => span.text).join("");
}

/** An inline svg's accessible name: its `aria-label`, else its `<title>`. */
function svgTitle(svg: DomElement): string {
  const label = attr(svg, "aria-label");
  if (label) return label.trim();
  const title = elementChildren(svg).find((child) => child.tag === "title");
  return (title ? textContent(title) : "").replace(/\s+/g, " ").trim();
}

function numberAttr(element: DomElement, name: string): number | undefined {
  const raw = attr(element, name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

class FormBuilder {
  readonly #root: DomElement;
  readonly #sections: FormSection[] = [];
  readonly #fields: FormField[] = [];
  readonly #hidden: [string, string][] = [];
  /** Radio/checkbox groups by `type\0name`, with the section and block of their first option. */
  readonly #groups = new Map<string, { field: ChoiceField; section: FormSection; block: FormFieldBlock }>();
  /** `<label for>` elements by the id of the control they name. */
  readonly #labelFor = new Map<string, DomElement>();
  #section: FormSection = { title: [], blocks: [], fieldset: false };
  #inline: FormSpan[] = [];
  #fieldsetDepth = 0;

  constructor(root: DomElement) {
    this.#root = root;
    this.#sections.push(this.#section);
  }

  build(): HtmlForm {
    const ids = new Set<string>();
    for (const control of descendants(this.#root, isControl)) {
      const id = attr(control, "id");
      if (id) ids.add(id);
    }
    for (const label of descendants(this.#root, (element) => element.tag === "label")) {
      const target = attr(label, "for");
      if (target && ids.has(target) && !this.#labelFor.has(target)) this.#labelFor.set(target, label);
    }
    this.#children(this.#root, undefined);
    this.#flush(false);
    for (const field of this.#fields) {
      if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
      field.other = !field.options.some((option) => /^\s*other\b/i.test(spansText(option.label)));
    }
    return {
      sections: this.#sections.filter((section) => section.blocks.length > 0 || section.title.length > 0),
      fields: this.#fields,
      hidden: this.#hidden,
    };
  }

  #children(node: DomElement, style: FormSpanStyle | undefined): void {
    for (const child of node.children) this.#walk(child, style);
  }

  #walk(node: DomNode, style: FormSpanStyle | undefined): void {
    if (node.kind === "text") {
      if (!node.comment) appendSpan(this.#inline, flowText(node.data), style);
      return;
    }
    const tag = node.tag;
    if (SKIPPED[tag]) return;
    switch (tag) {
      case "br":
        appendSpan(this.#inline, "\n", undefined);
        return;
      case "hr":
        this.#flush(false);
        return;
      case "input":
      case "select":
      case "textarea":
        this.#control(node, undefined);
        return;
      case "label":
        this.#label(node, style);
        return;
      case "fieldset":
        this.#fieldset(node);
        return;
      case "legend":
        this.#flush(false);
        this.#children(node, style);
        this.#flush(true);
        return;
      case "ul":
      case "ol":
        this.#list(node, tag === "ol");
        return;
      case "pre":
        this.#flush(false);
        this.#section.blocks.push({ kind: "pre", text: textContent(node).replace(/^\n/, "").trimEnd() });
        return;
      case "table":
        this.#table(node);
        return;
      case "img": {
        const src = attr(node, "src")?.trim();
        if (!src) return;
        this.#flush(false);
        this.#section.blocks.push({ kind: "image", src, alt: (attr(node, "alt") ?? "").trim() });
        return;
      }
      case "svg":
        this.#flush(false);
        this.#section.blocks.push({ kind: "svg", markup: outerHtml(node), alt: svgTitle(node) });
        return;
    }
    if (HEADING[tag]) {
      this.#flush(false);
      this.#children(node, style);
      this.#flush(true);
      return;
    }
    if (BLOCK[tag]) {
      this.#flush(false);
      this.#children(node, style);
      this.#flush(false);
      return;
    }
    this.#children(node, STYLE_OF[tag] ?? style);
  }

  /** Emit buffered inline content as a text block. */
  #flush(heading: boolean): void {
    const spans = normalizeSpans(this.#inline);
    this.#inline = [];
    if (spans.length > 0) this.#section.blocks.push({ kind: "text", spans, heading });
  }

  /** Inline spans of `element`, skipping controls (their label is the text around them). */
  #spansOf(element: DomElement): FormSpan[] {
    const spans: FormSpan[] = [];
    const visit = (node: DomNode, style: FormSpanStyle | undefined): void => {
      if (node.kind === "text") {
        if (!node.comment) appendSpan(spans, flowText(node.data), style);
        return;
      }
      const tag = node.tag;
      if (SKIPPED[tag] || tag === "input" || tag === "select" || tag === "textarea" || tag === "svg") return;
      if (tag === "br") {
        appendSpan(spans, "\n", undefined);
        return;
      }
      // Labels stay text: a picture inside one reads as its alt text.
      if (tag === "img") {
        appendSpan(spans, attr(node, "alt") ?? "", style);
        return;
      }
      if (BLOCK[tag] || HEADING[tag]) appendSpan(spans, " ", undefined);
      for (const child of node.children) visit(child, STYLE_OF[tag] ?? style);
    };
    for (const child of element.children) visit(child, undefined);
    return normalizeSpans(spans);
  }

  #label(label: DomElement, style: FormSpanStyle | undefined): void {
    const target = attr(label, "for");
    if (target && this.#labelFor.get(target) === label) return;
    const controls = descendants(label, isControl);
    if (controls.length === 0) {
      this.#children(label, style);
      return;
    }
    this.#flush(false);
    const spans = this.#spansOf(label);
    for (const control of controls) this.#control(control, spans);
  }

  #fieldset(fieldset: DomElement): void {
    this.#flush(false);
    const legend = elementChildren(fieldset).find((child) => child.tag === "legend");
    if (this.#fieldsetDepth > 0) {
      // Nested fieldsets stay in the outer section; their legend becomes a heading.
      if (legend) this.#walk(legend, undefined);
    } else {
      this.#startSection(legend ? this.#spansOf(legend) : [], true);
    }
    this.#fieldsetDepth += 1;
    for (const child of fieldset.children) {
      if (child !== legend) this.#walk(child, undefined);
    }
    this.#flush(false);
    this.#fieldsetDepth -= 1;
    if (this.#fieldsetDepth === 0) this.#startSection([], false);
  }

  #startSection(title: FormSpan[], fieldset: boolean): void {
    if (this.#section.blocks.length === 0 && this.#section.title.length === 0) {
      this.#section.title = title;
      this.#section.fieldset = fieldset;
      return;
    }
    this.#section = { title, blocks: [], fieldset };
    this.#sections.push(this.#section);
  }

  #list(list: DomElement, ordered: boolean): void {
    this.#flush(false);
    if (hasControl(list)) {
      // A list of controls is layout, not content: walk it as flow.
      this.#children(list, undefined);
      this.#flush(false);
      return;
    }
    const items = elementChildren(list)
      .filter((child) => child.tag === "li")
      .map((item) => this.#spansOf(item))
      .filter((spans) => spans.length > 0);
    if (items.length > 0) this.#section.blocks.push({ kind: "list", items, ordered });
  }

  #table(table: DomElement): void {
    this.#flush(false);
    const rows = descendants(table, (element) => element.tag === "tr").filter((row) => closest(row.parent ?? row, "table") === table);
    const cellsOf = (row: DomElement) => elementChildren(row).filter((cell) => cell.tag === "td" || cell.tag === "th");
    if (!hasControl(table)) {
      const cells = rows.map((row) => cellsOf(row).map((cell) => this.#spansOf(cell)));
      let headerRows = 0;
      while (
        headerRows < rows.length &&
        (closest(rows[headerRows]!, "thead") !== undefined || cellsOf(rows[headerRows]!).every((cell) => cell.tag === "th"))
      ) {
        headerRows += 1;
      }
      if (cells.some((row) => row.length > 0)) this.#section.blocks.push({ kind: "table", rows: cells, headerRows });
      return;
    }
    // A table of controls (a decision matrix): each row's text becomes a line and each unlabeled control
    // borrows its column header as its label.
    let header: FormSpan[][] = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      if (cells.every((cell) => cell.tag === "th") && !hasControl(row)) {
        header = cells.map((cell) => this.#spansOf(cell));
        continue;
      }
      const text: FormSpan[] = [];
      for (const cell of cells) {
        if (hasControl(cell)) continue;
        const spans = this.#spansOf(cell);
        if (spans.length === 0) continue;
        if (text.length > 0) appendSpan(text, " \u00b7 ", undefined);
        for (const span of spans) appendSpan(text, span.text, span.style);
      }
      if (text.length > 0) this.#section.blocks.push({ kind: "text", spans: text, heading: false });
      cells.forEach((cell, column) => {
        for (const control of descendants(cell, isControl)) {
          const own = closest(control, "label");
          const spans = own && contains(cell, own) ? this.#spansOf(own) : this.#spansOf(cell);
          this.#control(control, spans.length > 0 ? spans : (header[column] ?? []));
        }
      });
    }
  }

  /** Label of a control outside any wrapping `<label>`: `<label for>`, then `aria-label`, `title`. */
  #detachedLabel(control: DomElement): FormSpan[] {
    const id = attr(control, "id");
    const label = id ? this.#labelFor.get(id) : undefined;
    if (label) return this.#spansOf(label);
    const text = attr(control, "aria-label") ?? attr(control, "title");
    return text ? normalizeSpans([{ text }]) : [];
  }

  #control(control: DomElement, wrapping: FormSpan[] | undefined): void {
    this.#flush(false);
    const label = wrapping && wrapping.length > 0 ? wrapping : this.#detachedLabel(control);
    const name = attr(control, "name") ?? "";
    const required = hasAttr(control, "required");
    const tag = control.tag;
    if (tag === "select") {
      const multi = hasAttr(control, "multiple");
      const options: ChoiceOption[] = descendants(control, (element) => element.tag === "option").map((option) => {
        const text = textContent(option).replace(/\s+/g, " ").trim();
        return {
          value: attr(option, "value") ?? text,
          label: [{ text }],
          checked: hasAttr(option, "selected"),
          disabled: hasAttr(option, "disabled"),
        };
      });
      // A single select always has a selection: the first enabled option unless one is marked.
      if (!multi && !options.some((option) => option.checked)) {
        const first = options.find((option) => !option.disabled);
        if (first) first.checked = true;
      }
      this.#addField({ kind: "choice", name, multi, select: true, other: false, label, options, required });
      return;
    }
    if (tag === "textarea") {
      this.#addField({
        kind: "text",
        name,
        type: "textarea",
        multiline: true,
        label: label.length > 0 ? label : this.#nameLabel(name),
        value: textContent(control).replace(/^\r?\n/, ""),
        placeholder: attr(control, "placeholder") ?? "",
        required,
        minLength: numberAttr(control, "minlength"),
        maxLength: numberAttr(control, "maxlength"),
        rows: numberAttr(control, "rows") ?? 4,
      });
      return;
    }
    const type = (attr(control, "type") ?? "text").toLowerCase();
    if (IGNORED_INPUTS[type]) return;
    const value = attr(control, "value");
    if (type === "hidden") {
      if (name) this.#hidden.push([name, value ?? ""]);
      return;
    }
    if (type === "radio" || type === "checkbox") {
      const option: ChoiceOption = {
        value: value ?? "on",
        label: label.length > 0 ? label : [{ text: value ?? name }],
        checked: hasAttr(control, "checked"),
        disabled: hasAttr(control, "disabled"),
      };
      const key = `${type}\0${name}`;
      const group = this.#groups.get(key);
      if (group) {
        group.field.options.push(option);
        group.field.required ||= required;
        if (group.section === this.#section && this.#section.blocks.at(-1) !== group.block) {
          group.block.optionsEnd = this.#section.blocks.length;
        }
        return;
      }
      const field: ChoiceField = { kind: "choice", name, multi: type === "checkbox", select: false, other: false, label: [], options: [option], required };
      this.#groups.set(key, { field, section: this.#section, block: this.#addField(field) });
      return;
    }
    this.#addField({
      kind: "text",
      name,
      type,
      multiline: false,
      label: label.length > 0 ? label : this.#nameLabel(name),
      value: value ?? "",
      placeholder: attr(control, "placeholder") ?? "",
      required,
      min: numberAttr(control, "min"),
      max: numberAttr(control, "max"),
      pattern: attr(control, "pattern") ?? undefined,
      minLength: numberAttr(control, "minlength"),
      maxLength: numberAttr(control, "maxlength"),
      rows: 1,
    });
  }

  /** Last-resort label from the control name: `sentry_dsn` becomes `sentry dsn`. */
  #nameLabel(name: string): FormSpan[] {
    return name ? [{ text: name.replace(/[_-]+/g, " ") }] : [];
  }

  #addField(field: FormField): FormFieldBlock {
    const block: FormFieldBlock = { kind: "field", field };
    this.#fields.push(field);
    this.#section.blocks.push(block);
    return block;
  }
}
