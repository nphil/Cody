/**
 * How the text box of a list setting (SchemaSettingsList's ArrayControl) turns
 * into the list it saves, with no React in it so a test can drive it.
 *
 * A list setting is free-form strings, one per line. Several engine lists
 * (tools.restrictedFolders, contextFiles.extra, task.perCallModelAllow, omp
 * 18.13+) describe themselves as "a JSON list" because the engine's own editor
 * is JSON, and the box used to take what was typed literally: `["~/secrets"]`
 * saved ONE entry, `["~/secrets"]` itself, which names no folder, so the
 * protection it was meant to switch on never existed. A draft that is a JSON
 * list of strings is therefore read as that list; a draft that starts like one
 * but does not parse is refused rather than saved as a stray entry.
 */

/** What the box holds: the list to save, or why it cannot be saved yet. */
export type ListDraft = { ok: true; entries: string[] } | { ok: false; reason: string };

/** The placeholder, and the answer to "what does this box take". */
export const LIST_DRAFT_HINT = "One entry per line, or a JSON list such as [\"first\", \"second\"]";

const NOT_A_LIST = "That looks like a JSON list but is not one. Write one entry per line, or a list of quoted strings such as [\"first\", \"second\"].";

/** Read the box: a JSON list of strings, or one entry per line. Entries are trimmed and blanks dropped. */
export function parseListDraft(draft: string): ListDraft {
  const text = draft.trim();
  let items: string[];
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: NOT_A_LIST };
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) return { ok: false, reason: NOT_A_LIST };
    items = parsed as string[];
  } else {
    items = text.split("\n");
  }
  return { ok: true, entries: items.map((entry) => entry.trim()).filter((entry) => entry.length > 0) };
}

/** How a saved list shows in the box: one entry per line. */
export function formatListDraft(entries: readonly string[]): string {
  return entries.join("\n");
}
