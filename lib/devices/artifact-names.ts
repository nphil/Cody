/**
 * Names for files that leave the browser: inside a zip, in the one a person downloads and in the one the server keeps.
 * One implementation, so both archives name every file the same way.
 *
 * What a browser called a file is DATA, never a path. Each name here is reduced
 * to one safe segment: no separator, drive letter, control character or
 * Windows-reserved character survives, nothing starts or ends with a dot or a
 * space (the leading dot would hide it, the trailing one is stripped by
 * Windows), and the two names a save writes itself are moved aside.
 *
 * The vault keeps its own bookkeeping files (`STATE_NAME`, `partName`) while a save is still arriving, and none of
 * them may share a name with a file made here: every one of them starts with a dot, which no name made here can, and
 * `isVaultInternalName` reserves them a second time so a change to one rule cannot quietly break the other.
 *
 * Pure and browser-safe.
 */

/** The two files every save carries beside the artifacts. */
export const MANIFEST_NAME = "manifest.json";
export const SUMS_NAME = "SHA256SUMS";

/** The vault's record of an unfinished save, inside that save's folder. */
export const STATE_NAME = ".state.json";

/** The partial copy of file number `index` while it is still arriving. */
export function partName(index: number): string {
  return `.${index}.part`;
}

/** Whether a name is one the vault keeps for itself (any case: a share seen from Windows is case-insensitive). */
export function isVaultInternalName(name: string): boolean {
  return name.toLowerCase() === STATE_NAME || /^\.\d+\.part$/.test(name);
}

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
  if (RESERVED_FILE_NAMES.has(base.toLowerCase()) || isVaultInternalName(base)) base = `file-${base}`;
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

const MAX_SLUG_CHARS = 48;

/** The slug of a label before it is cut to length: letters, digits, dot, dash and underscore, no run of dashes, none at either end. */
function slugOf(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * A label as a folder name: letters, digits, dot, dash and underscore only, at most 48 characters, never empty, and
 * never one of the names Windows reserves for devices (`nul`, `con.edl`), which it would refuse to create or extract.
 */
export function labelSlug(label: string): string {
  const cleaned = slugOf(label).slice(0, MAX_SLUG_CHARS).replace(/[-.]+$/g, "");
  if (!cleaned) return "artifacts";
  return WINDOWS_DEVICE_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * `base` followed by `suffix` ("Lenovo QUSB__BULK EDL backup 5 of 56"), the base cut short enough that the suffix
 * survives `labelSlug`: what a backup is missing must reach the file name however long the backup's name is. An empty
 * suffix leaves the base as it is.
 */
export function labelWithSuffix(base: string, suffix: string): string {
  if (!suffix) return base;
  const room = MAX_SLUG_CHARS - slugOf(suffix).length - 1;
  let stem = base.trimEnd();
  while (stem.length > 0 && slugOf(stem).length > room) stem = stem.slice(0, -1).trimEnd();
  return stem ? `${stem} ${suffix}` : suffix;
}
