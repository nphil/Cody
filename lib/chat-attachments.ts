/**
 * Cody sends prompts to omp as one outbound NDJSON frame. That direction does
 * not reassemble chunks, and the composer keeps the complete frame under its
 * 900 KiB safety budget (including images). Keep text attachments below that
 * ceiling with room for the user's message and attachment delimiters; the
 * final prompt-frame preflight remains authoritative for mixed attachments.
 */
export const MAX_TOTAL_ATTACHED_TEXT_BYTES = 768 * 1024;
/** Preserve Cody's existing per-file text attachment behavior. */
export const MAX_ATTACHED_TEXT_BYTES = 256 * 1024;
export const MAX_ATTACHED_TEXT_FILES = 10;

const TEXT_FILE_EXTENSIONS: Record<string, true> = Object.fromEntries(
  "txt text md markdown mdx js mjs cjs jsx ts tsx json jsonc yaml yml toml py rb go rs java c cc cpp h hpp cs sh bash zsh fish sql html css scss xml svg vue svelte php swift kt kts lua r pl ps1 ini conf env log csv".split(" ").map((extension) => [extension, true]),
);

const TEXT_FILE_MIME_TYPES = new Set(["application/json", "application/javascript", "application/typescript", "application/x-javascript", "application/x-typescript", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/sql"]);

export interface AttachedTextFileData {
  name: string;
  mimeType: string;
  content: string;
  size: number;
}

/** Human-readable limit for composer attachment banners. */
export function formatAttachmentBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** What the composer already holds (or has reserved while a read is in flight). */
export interface TextAttachmentBudget {
  usedBytes: number;
  usedSlots: number;
}

export interface TextAttachmentSelection<T> {
  accepted: T[];
  /** Candidates dropped for exceeding Cody's per-file cap. */
  tooLarge: number;
  /** Candidates dropped because the aggregate text budget was spent. */
  overBudget: number;
}

/**
 * Apply the shared per-file, aggregate-byte, and slot limits. Keeping this
 * selection pure lets fresh browser drops and persisted draft restoration use
 * exactly the same policy.
 *
 * Candidates beyond the available slots are intentionally not classified:
 * the caller already has a separate, stable count-limit message for that
 * condition.
 */
export function selectTextAttachments<T extends { size: number }>(
  candidates: readonly T[],
  budget: TextAttachmentBudget,
): TextAttachmentSelection<T> {
  const accepted: T[] = [];
  const remainingSlots = Math.max(0, MAX_ATTACHED_TEXT_FILES - budget.usedSlots);
  let totalBytes = budget.usedBytes;
  let tooLarge = 0;
  let overBudget = 0;

  for (const candidate of candidates) {
    if (accepted.length >= remainingSlots) break;
    if (!Number.isFinite(candidate.size) || candidate.size < 0 || candidate.size > MAX_ATTACHED_TEXT_BYTES) {
      tooLarge++;
      continue;
    }
    if (totalBytes + candidate.size > MAX_TOTAL_ATTACHED_TEXT_BYTES) {
      overBudget++;
      continue;
    }
    totalBytes += candidate.size;
    accepted.push(candidate);
  }

  return { accepted, tooLarge, overBudget };
}

/** Banner text for a batch that produced no usable attachments. */
export function describeTextAttachmentSkip(
  selection: Pick<TextAttachmentSelection<unknown>, "tooLarge" | "overBudget">,
): string | null {
  if (selection.tooLarge > 0) {
    return `${selection.tooLarge} file(s) skipped: files up to ${formatAttachmentBytes(MAX_ATTACHED_TEXT_BYTES)} are supported.`;
  }
  if (selection.overBudget > 0) {
    return `${selection.overBudget} file(s) skipped: attachments are limited to ${formatAttachmentBytes(MAX_TOTAL_ATTACHED_TEXT_BYTES)} per message.`;
  }
  return null;
}

function getFileExtension(name: string): string {
  return name.toLowerCase().replace(/\\/g, "/").split("/").pop()?.split(".").pop() ?? "";
}

export function isTextAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("text/")
      || TEXT_FILE_MIME_TYPES.has(file.type)
      || TEXT_FILE_EXTENSIONS[getFileExtension(file.name)] === true;
}

function languageForFile(name: string): string {
  const extension = getFileExtension(name);
  if (extension === "md" || extension === "markdown" || extension === "mdx") return "markdown";
  return "text";
}

function fenceForContent(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Add text-file contents to the prompt while keeping the attachment boundary clear. */
export function composeMessageWithTextAttachments(
  message: string,
  files: AttachedTextFileData[],
): string {
  if (files.length === 0) return message;
  const blocks = files.map((file) => {
    const fence = fenceForContent(file.content);
    return `Attached file: ${file.name}\n${fence}${languageForFile(file.name)}\n${file.content}\n${fence}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
