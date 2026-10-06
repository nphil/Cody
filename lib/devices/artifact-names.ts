/**
 * Names for files and folders that leave the browser: inside a zip, and on the
 * server. One implementation, so the archive a person downloads and the folder
 * the server keeps name every file the same way.
 *
 * What a browser called a file is DATA, never a path. Each name here is reduced
 * to one safe segment: no separator, drive letter, control character or
 * Windows-reserved character survives, nothing starts or ends with a dot or a
 * space (the leading dot would hide it, the trailing one is stripped by
 * Windows), and the two names a save writes itself are moved aside.
 *
 * Pure and browser-safe.
 */

/** The two files every save carries beside the artifacts. */
export const MANIFEST_NAME = "manifest.json";
export const SUMS_NAME = "SHA256SUMS";

const RESERVED_FILE_NAMES = new Set([MANIFEST_NAME, SUMS_NAME.toLowerCase()]);
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_NAME_BYTES = 200;
const utf8 = new TextEncoder();

function byteLength(text: string): number {
  return utf8.encode(text).length;
}

function extensionOf(text: string): string {
  return /\.[A-Za-z0-9]{1,16}$/.exec(text)?.[0] ?? "";
}

/** Cut to a byte budget without splitting a character, keeping a short extension. */
function truncateBytes(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  const extension = extensionOf(text);
  let stem = Array.from(text.slice(0, text.length - extension.length));
  while (stem.length > 0 && byteLength(stem.join("")) + byteLength(extension) > limit) stem = stem.slice(0, -1);
  return stem.join("") + extension;
}

/** One safe path segment from whatever a browser called a file. */
export function safeFileName(name: string): string {
  let base = name.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "_");
  base = base.replace(/^[\s.]+/, "_").replace(/[\s.]+$/, "");
  if (!base) base = "file";
  if (WINDOWS_DEVICE_NAME.test(base)) base = `_${base}`;
  if (RESERVED_FILE_NAMES.has(base.toLowerCase())) base = `file-${base}`;
  return truncateBytes(base, MAX_NAME_BYTES);
}

/**
 * Safe names, unique ignoring case (a share seen from Windows is case-insensitive), in the order given. A name that has
 * to be numbered is shortened from its stem first, so the number is never what gets cut off.
 */
export function uniqueFileNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const safe = safeFileName(name);
    const extension = extensionOf(safe);
    const stem = safe.slice(0, safe.length - extension.length);
    let candidate = safe;
    for (let counter = 2; taken.has(candidate.toLowerCase()); counter += 1) {
      const suffix = `-${counter}${extension}`;
      candidate = `${truncateBytes(stem, MAX_NAME_BYTES - byteLength(suffix))}${suffix}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** A label as a folder name: letters, digits, dot, dash and underscore only, at most 48 characters, never empty. */
export function labelSlug(label: string): string {
  const cleaned = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48)
    .replace(/[-.]+$/g, "");
  return cleaned || "artifacts";
}
