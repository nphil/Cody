/**
 * Client-side image compression for chat attachments, plus the byte budget that
 * decides whether a composed prompt can physically reach the engine.
 *
 * Why this exists: an attached image travels to omp as base64 INSIDE the prompt
 * command, and that command must fit in one NDJSON line — omp's rpc-ui stdin
 * reader parses a line as a whole command and cannot reassemble chunks (see
 * `lib/omp/rpc-frame.ts`). The transport therefore refuses anything over 1 MiB
 * instead of hanging. A phone photo is 3–8 MB, i.e. 4–11 MB once base64'd, so
 * without this module "attach a photo" could never be delivered at all.
 *
 * The decision half — pass-through policy, the quality/dimension ladder, the
 * budget arithmetic — is pure and unit-tested. The browser half at the bottom
 * is the only part that needs `createImageBitmap` and a canvas.
 */

/** Base64 payload at or under this is sent untouched: screenshots stay crisp. */
export const IMAGE_PASSTHROUGH_BASE64_BYTES = 600 * 1024;
/** What the ladder aims for once an image does have to be re-encoded. */
export const IMAGE_TARGET_BASE64_BYTES = 600 * 1024;
/**
 * Ceiling for the whole assembled prompt frame (message + every attachment +
 * JSON overhead). Deliberately under MAX_RPC_FRAME_BYTES (1 MiB) so a send is
 * refused in the composer, with something the user can act on, rather than by
 * the transport with a protocol error.
 */
export const PROMPT_FRAME_BUDGET_BYTES = 900 * 1024;
/** Everything the ladder re-encodes comes out as JPEG. */
export const COMPRESSED_IMAGE_MIME_TYPE = "image/jpeg";
/** Long-edge caps, in ladder order. 1568px is the second, harder step. */
export const IMAGE_MAX_EDGE_PX = 2048;
export const IMAGE_FALLBACK_EDGE_PX = 1568;

/** Types a browser canvas can re-encode. Anything else is either passed
 *  through untouched (vector) or reported as undecodable. */
export const COMPRESSIBLE_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
];

/** Rasterizing these would destroy them; they ride through at any size and the
 *  total budget is what catches an oversized one. */
export const PASSTHROUGH_ONLY_MIME_TYPES: readonly string[] = ["image/svg+xml"];

/** Named in the per-file error when a browser cannot decode an attachment. */
export const SUPPORTED_IMAGE_FORMAT_LABEL = "JPEG, PNG, WebP, GIF";

export interface CompressionStep {
  /** Longest edge the image is scaled down to (never scaled up). */
  maxEdge: number;
  /** JPEG quality passed to the canvas encoder. */
  quality: number;
}

/**
 * 2048px stepping 0.9 → 0.5, then 1568px continuing 0.5 → 0.4. Each rung is
 * attempted in order and the first result within target wins, so a moderately
 * sized photo stops at 0.9 and only genuinely huge ones walk the whole ladder.
 */
export const COMPRESSION_STEPS: readonly CompressionStep[] = [
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.9 },
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.8 },
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.7 },
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.6 },
  { maxEdge: IMAGE_MAX_EDGE_PX, quality: 0.5 },
  { maxEdge: IMAGE_FALLBACK_EDGE_PX, quality: 0.5 },
  { maxEdge: IMAGE_FALLBACK_EDGE_PX, quality: 0.45 },
  { maxEdge: IMAGE_FALLBACK_EDGE_PX, quality: 0.4 },
];

export type ImageCompressionPlan =
  | { kind: "passthrough"; reason: "within-budget" | "vector" }
  | { kind: "compress"; steps: readonly CompressionStep[]; targetBase64Length: number };

/** Length of the base64 text for `byteLength` raw bytes (padding included). */
export function base64LengthForBytes(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return Math.ceil(byteLength / 3) * 4;
}

/** Scale to fit `maxEdge` on the long side. Never upscales; never returns 0. */
export function fitWithinEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const longest = Math.max(safeWidth, safeHeight);
  if (!Number.isFinite(maxEdge) || maxEdge <= 0 || longest <= maxEdge) {
    return { width: safeWidth, height: safeHeight };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

/**
 * What to do with a file the user just attached, decided from its size and type
 * alone — no decoding, so the common case (a screenshot) never touches a canvas.
 */
export function planImageCompression(input: { byteLength: number; mimeType: string }): ImageCompressionPlan {
  const mimeType = input.mimeType.toLowerCase();
  if (PASSTHROUGH_ONLY_MIME_TYPES.includes(mimeType)) return { kind: "passthrough", reason: "vector" };
  if (base64LengthForBytes(input.byteLength) <= IMAGE_PASSTHROUGH_BASE64_BYTES) {
    return { kind: "passthrough", reason: "within-budget" };
  }
  return {
    kind: "compress",
    steps: COMPRESSION_STEPS,
    targetBase64Length: IMAGE_TARGET_BASE64_BYTES,
  };
}

export interface EncodedImage {
  /** base64 payload, no `data:` prefix. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface LadderResult {
  image: EncodedImage;
  step: CompressionStep;
  /** How many rungs were actually encoded (1 when the first one fit). */
  attempts: number;
  /** False means every rung was over target — the smallest one is returned so
   *  the caller can still show it, and the total budget check has the last word. */
  withinTarget: boolean;
}

/**
 * Walk the ladder with an injected encoder and return the first result within
 * target, or the smallest one if none fits. Pure control flow: the encoder is
 * the only thing that needs a browser, which is what makes the policy testable.
 */
export async function runCompressionLadder(
  steps: readonly CompressionStep[],
  targetBase64Length: number,
  encode: (step: CompressionStep) => Promise<EncodedImage>,
): Promise<LadderResult> {
  if (steps.length === 0) throw new Error("compression ladder has no steps");
  let smallest: LadderResult | null = null;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const image = await encode(step);
    const attempts = index + 1;
    if (image.data.length <= targetBase64Length) {
      return { image, step, attempts, withinTarget: true };
    }
    if (!smallest || image.data.length < smallest.image.data.length) {
      smallest = { image, step, attempts, withinTarget: false };
    }
  }
  // Every rung overshot: hand back the smallest, flagged honestly.
  return { ...smallest!, attempts: steps.length };
}

export interface BudgetImage {
  data: string;
  mimeType: string;
  /** Original file name, when the attachment came from one. */
  name?: string;
}

/** Bytes a JSON string literal costs on the wire, escaping included. */
function jsonStringBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** `{"type":"prompt","id":"w12","message":…,"images":[…]}` minus the payloads. */
const PROMPT_FRAME_ENVELOPE_BYTES = 128;
/** `{"type":"image","data":"…","mimeType":"…"}` minus the payloads. */
const IMAGE_ENVELOPE_BYTES = 48;

/**
 * Size of the prompt frame this message + these attachments would serialize to.
 * base64 is ASCII, so its character count is its byte count; the message is
 * measured through JSON.stringify so escapes and multi-byte text are counted
 * the way the transport will actually count them.
 */
export function estimatePromptFrameBytes(input: {
  message: string;
  images: readonly BudgetImage[];
}): number {
  let total = PROMPT_FRAME_ENVELOPE_BYTES + jsonStringBytes(input.message);
  for (const image of input.images) {
    total += IMAGE_ENVELOPE_BYTES + image.data.length + jsonStringBytes(image.mimeType);
  }
  return total;
}

export interface BudgetVerdict {
  ok: boolean;
  totalBytes: number;
  limit: number;
  /** The attachment worth removing first (largest), when over budget. */
  largest: { index: number; name?: string; byteLength: number } | null;
}

/**
 * Can this composed message be delivered at all? Called before every send so a
 * prompt that cannot fit is refused where the user can still fix it.
 */
export function checkPromptFrameBudget(input: {
  message: string;
  images: readonly BudgetImage[];
  limit?: number;
}): BudgetVerdict {
  const limit = input.limit ?? PROMPT_FRAME_BUDGET_BYTES;
  const totalBytes = estimatePromptFrameBytes(input);
  if (totalBytes <= limit) return { ok: true, totalBytes, limit, largest: null };
  let largestIndex = 0;
  for (let index = 1; index < input.images.length; index++) {
    if (input.images[index].data.length > input.images[largestIndex].data.length) largestIndex = index;
  }
  const largest = input.images[largestIndex];
  return {
    ok: false,
    totalBytes,
    limit,
    largest: largest
      ? {
        index: largestIndex,
        ...(largest.name ? { name: largest.name } : {}),
        // base64 → the decoded size a human recognizes from their file manager.
        byteLength: Math.floor((largest.data.length / 4) * 3),
      }
      : null,
  };
}

/** "820 KB" / "1.4 MB" — the sizes in attachment errors. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ── Browser half ─────────────────────────────────────────────────────────────
// Everything below needs a DOM. It is deliberately thin: decode, draw, encode,
// and hand the bytes back to the pure ladder above.

/** A file no browser decoder here could open (HEIC/HEIF on most platforms). */
export class UnsupportedImageError extends Error {
  readonly fileName: string;

  constructor(fileName: string, message: string) {
    super(message);
    this.name = "UnsupportedImageError";
    this.fileName = fileName;
  }
}

export interface PreparedImage {
  data: string;
  mimeType: string;
  /** False when the original bytes were sent through untouched. */
  compressed: boolean;
  width: number | null;
  height: number | null;
}

function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.slice(result.indexOf(",") + 1);
      if (!base64) reject(new Error("empty image data"));
      else resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Decode, downscale and JPEG-encode until the payload fits.
 *
 * Notes on what this deliberately loses: an animated GIF keeps only its first
 * frame (a canvas has no others), and transparency is flattened onto white
 * because JPEG has no alpha. Both are the price of fitting inside one RPC frame
 * and only apply to images too big to pass through untouched.
 */
export async function prepareImageForAttachment(
  file: File,
  unsupportedMessage: (fileName: string) => string,
): Promise<PreparedImage> {
  const plan = planImageCompression({ byteLength: file.size, mimeType: file.type });
  if (plan.kind === "passthrough") {
    return { data: await readFileAsBase64(file), mimeType: file.type, compressed: false, width: null, height: null };
  }

  if (typeof createImageBitmap !== "function") {
    throw new UnsupportedImageError(file.name, unsupportedMessage(file.name));
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // HEIC/HEIF and other formats the browser has no decoder for land here.
    throw new UnsupportedImageError(file.name, unsupportedMessage(file.name));
  }

  try {
    const { image } = await runCompressionLadder(plan.steps, plan.targetBase64Length, async (step) => {
      const size = fitWithinEdge(bitmap.width, bitmap.height, step.maxEdge);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new UnsupportedImageError(file.name, unsupportedMessage(file.name));
      // JPEG has no alpha: paint the ground first so transparency does not
      // develop into black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size.width, size.height);
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const url = canvas.toDataURL(COMPRESSED_IMAGE_MIME_TYPE, step.quality);
      const data = url.slice(url.indexOf(",") + 1);
      if (!data || !url.startsWith(`data:${COMPRESSED_IMAGE_MIME_TYPE}`)) {
        throw new UnsupportedImageError(file.name, unsupportedMessage(file.name));
      }
      return { data, mimeType: COMPRESSED_IMAGE_MIME_TYPE, width: size.width, height: size.height };
    });
    return { data: image.data, mimeType: image.mimeType, compressed: true, width: image.width, height: image.height };
  } finally {
    bitmap.close?.();
  }
}
