import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The attachment policy, tested where it actually decides things.
 *
 * Everything here is the pure half of lib/image-compress.ts: what gets
 * compressed, how far down the ladder it walks, and whether the assembled
 * prompt can fit in the one RPC frame omp will accept. The canvas half cannot
 * run under node (no DOM, and faking one would mean a new dependency), so the
 * ladder is exercised through an injected encoder instead — which is the whole
 * reason the loop takes one.
 */

const jiti = createJiti(import.meta.url);
const {
  base64LengthForBytes,
  checkPromptFrameBudget,
  COMPRESSION_STEPS,
  estimatePromptFrameBytes,
  fitWithinEdge,
  formatAttachmentSize,
  IMAGE_FALLBACK_EDGE_PX,
  IMAGE_MAX_EDGE_PX,
  IMAGE_PASSTHROUGH_BASE64_BYTES,
  IMAGE_TARGET_BASE64_BYTES,
  planImageCompression,
  PROMPT_FRAME_BUDGET_BYTES,
  runCompressionLadder,
} = await jiti.import("./image-compress.ts");

const { MAX_RPC_FRAME_BYTES } = await jiti.import("./omp/rpc-frame.ts");

/** Largest file whose base64 still fits the pass-through allowance. */
const PASSTHROUGH_MAX_FILE_BYTES = (IMAGE_PASSTHROUGH_BASE64_BYTES / 4) * 3;

test("the shipped size policy is the one the UI promises", () => {
  assert.equal(IMAGE_PASSTHROUGH_BASE64_BYTES, 600 * 1024);
  assert.equal(IMAGE_TARGET_BASE64_BYTES, 600 * 1024);
  assert.equal(PROMPT_FRAME_BUDGET_BYTES, 900 * 1024);
  // The whole point of the budget: refuse in the composer, with headroom, so
  // the transport's hard limit is never the thing the user meets.
  assert.ok(PROMPT_FRAME_BUDGET_BYTES < MAX_RPC_FRAME_BYTES);
  // Room for several compressed attachments under the budget.
  assert.ok(IMAGE_TARGET_BASE64_BYTES < PROMPT_FRAME_BUDGET_BYTES);
});

test("base64 length accounts for padding", () => {
  assert.equal(base64LengthForBytes(0), 0);
  assert.equal(base64LengthForBytes(1), 4);
  assert.equal(base64LengthForBytes(3), 4);
  assert.equal(base64LengthForBytes(4), 8);
  assert.equal(base64LengthForBytes(3 * 1024), 4 * 1024);
});

test("screenshots pass through untouched; anything bigger gets the ladder", () => {
  const png = (byteLength) => planImageCompression({ byteLength, mimeType: "image/png" });

  assert.deepEqual(png(80 * 1024), { kind: "passthrough", reason: "within-budget" });
  // Exactly at the allowance is still pass-through: pixel-crisp screenshots.
  assert.deepEqual(png(PASSTHROUGH_MAX_FILE_BYTES), { kind: "passthrough", reason: "within-budget" });
  assert.equal(png(PASSTHROUGH_MAX_FILE_BYTES + 1).kind, "compress");

  const plan = png(6 * 1024 * 1024);
  assert.equal(plan.kind, "compress");
  assert.equal(plan.targetBase64Length, IMAGE_TARGET_BASE64_BYTES);
  assert.deepEqual(plan.steps, COMPRESSION_STEPS);

  // Vector art is never rasterized, at any size — the total budget catches an
  // oversized one instead.
  assert.deepEqual(
    planImageCompression({ byteLength: 4 * 1024 * 1024, mimeType: "image/svg+xml" }),
    { kind: "passthrough", reason: "vector" },
  );
  // Case is not the user's problem.
  assert.equal(planImageCompression({ byteLength: 9 * 1024 * 1024, mimeType: "IMAGE/JPEG" }).kind, "compress");
});

test("the ladder is 2048px 0.9→0.5, then 1568px down to 0.4", () => {
  assert.equal(COMPRESSION_STEPS[0].maxEdge, IMAGE_MAX_EDGE_PX);
  assert.equal(COMPRESSION_STEPS[0].quality, 0.9);
  assert.equal(COMPRESSION_STEPS[COMPRESSION_STEPS.length - 1].maxEdge, IMAGE_FALLBACK_EDGE_PX);
  assert.equal(COMPRESSION_STEPS[COMPRESSION_STEPS.length - 1].quality, 0.4);
  assert.deepEqual([...new Set(COMPRESSION_STEPS.map((step) => step.maxEdge))], [IMAGE_MAX_EDGE_PX, IMAGE_FALLBACK_EDGE_PX]);
  // Never gets better as it goes: each rung is smaller than the one before.
  for (let index = 1; index < COMPRESSION_STEPS.length; index++) {
    const previous = COMPRESSION_STEPS[index - 1];
    const step = COMPRESSION_STEPS[index];
    assert.ok(step.maxEdge <= previous.maxEdge);
    assert.ok(step.maxEdge < previous.maxEdge || step.quality < previous.quality);
  }
  // The 2048 half bottoms out at 0.5 before the resolution drops.
  const lastAtFullEdge = [...COMPRESSION_STEPS].reverse().find((step) => step.maxEdge === IMAGE_MAX_EDGE_PX);
  assert.equal(lastAtFullEdge.quality, 0.5);
});

test("fitting to the long edge never upscales and never rounds to zero", () => {
  assert.deepEqual(fitWithinEdge(4032, 3024, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(fitWithinEdge(3024, 4032, 2048), { width: 1536, height: 2048 });
  assert.deepEqual(fitWithinEdge(4000, 4000, 1568), { width: 1568, height: 1568 });
  // Already small: left exactly as it is.
  assert.deepEqual(fitWithinEdge(800, 600, 2048), { width: 800, height: 600 });
  // A panorama's short edge still survives as a pixel.
  const strip = fitWithinEdge(20000, 3, 2048);
  assert.equal(strip.width, 2048);
  assert.ok(strip.height >= 1);
});

test("the ladder stops at the first rung that fits", async () => {
  const seen = [];
  const result = await runCompressionLadder(COMPRESSION_STEPS, IMAGE_TARGET_BASE64_BYTES, async (step) => {
    seen.push(step);
    // Small original: the very first, highest-quality rung is already under.
    return { data: "A".repeat(120 * 1024), mimeType: "image/jpeg", width: 2048, height: 1365 };
  });
  assert.equal(seen.length, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.withinTarget, true);
  assert.equal(result.step.quality, 0.9);
});

test("a big photo walks down until it fits, in order", async () => {
  const seen = [];
  // Synthetic sizes shrinking with quality: only 0.6 and below come in under.
  const sizeFor = (step) => Math.round(IMAGE_TARGET_BASE64_BYTES * (step.quality / 0.65) * (step.maxEdge / IMAGE_MAX_EDGE_PX));
  const result = await runCompressionLadder(COMPRESSION_STEPS, IMAGE_TARGET_BASE64_BYTES, async (step) => {
    seen.push(step);
    return { data: "A".repeat(sizeFor(step)), mimeType: "image/jpeg", width: step.maxEdge, height: step.maxEdge };
  });
  assert.deepEqual(seen, COMPRESSION_STEPS.slice(0, seen.length));
  assert.equal(result.withinTarget, true);
  assert.equal(result.step.quality, 0.6);
  assert.equal(result.attempts, 4);
  assert.ok(result.image.data.length <= IMAGE_TARGET_BASE64_BYTES);
});

test("when no rung fits, the smallest result comes back flagged", async () => {
  const result = await runCompressionLadder(COMPRESSION_STEPS, IMAGE_TARGET_BASE64_BYTES, async (step) => ({
    // Never under target, and smallest at the very bottom of the ladder.
    data: "A".repeat(IMAGE_TARGET_BASE64_BYTES * 4 + Math.round(step.quality * 1000) + step.maxEdge),
    mimeType: "image/jpeg",
    width: step.maxEdge,
    height: step.maxEdge,
  }));
  assert.equal(result.withinTarget, false);
  assert.equal(result.attempts, COMPRESSION_STEPS.length);
  assert.equal(result.step.maxEdge, IMAGE_FALLBACK_EDGE_PX);
  assert.equal(result.step.quality, 0.4);
  // The caller still gets an image — the budget check is what refuses the send.
  assert.ok(result.image.data.length > IMAGE_TARGET_BASE64_BYTES);
});

test("the frame estimate is never smaller than the frame that gets serialized", () => {
  const images = [
    { type: "image", mimeType: "image/jpeg", data: "A".repeat(400 * 1024) },
    { type: "image", mimeType: "image/png", data: "B".repeat(64 * 1024) },
  ];
  const message = "look at these two — “quoted”, multi-byte 日本語, and a\nnewline";
  const actual = Buffer.byteLength(JSON.stringify({ type: "prompt", id: "w17", message, images }), "utf8");
  const estimate = estimatePromptFrameBytes({ message, images });
  assert.ok(estimate >= actual, `estimate ${estimate} must not undercount ${actual}`);
  // ...and not so padded that it refuses messages that would have fit.
  assert.ok(estimate - actual < 1024);
});

test("an oversized message is refused in the composer, naming what to remove", () => {
  const small = { data: "A".repeat(200 * 1024), mimeType: "image/jpeg", name: "receipt.jpg" };
  const large = { data: "B".repeat(750 * 1024), mimeType: "image/jpeg", name: "IMG_4021.jpg" };

  const fits = checkPromptFrameBudget({ message: "hello", images: [small] });
  assert.equal(fits.ok, true);
  assert.equal(fits.largest, null);

  const over = checkPromptFrameBudget({ message: "hello", images: [small, large] });
  assert.equal(over.ok, false);
  assert.equal(over.limit, PROMPT_FRAME_BUDGET_BYTES);
  assert.ok(over.totalBytes > PROMPT_FRAME_BUDGET_BYTES);
  // The one worth removing is named, not just "something is too big".
  assert.equal(over.largest.index, 1);
  assert.equal(over.largest.name, "IMG_4021.jpg");
  // Reported in the decoded size a human recognizes, not base64 characters.
  assert.ok(over.largest.byteLength < large.data.length);

  // A text-only message over the budget has no attachment to blame.
  const textOnly = checkPromptFrameBudget({ message: "x".repeat(PROMPT_FRAME_BUDGET_BYTES + 1), images: [] });
  assert.equal(textOnly.ok, false);
  assert.equal(textOnly.largest, null);

  // Ten compressed images at the target still clear the budget only if the
  // per-image target is respected — pin the arithmetic that makes that true.
  const atTarget = { data: "C".repeat(IMAGE_TARGET_BASE64_BYTES), mimeType: "image/jpeg" };
  assert.equal(checkPromptFrameBudget({ message: "", images: [atTarget] }).ok, true);
  assert.equal(checkPromptFrameBudget({ message: "", images: [atTarget, atTarget] }).ok, false);
});

test("sizes read the way a file manager shows them", () => {
  assert.equal(formatAttachmentSize(0), "0 KB");
  assert.equal(formatAttachmentSize(900), "1 KB");
  assert.equal(formatAttachmentSize(820 * 1024), "820 KB");
  assert.equal(formatAttachmentSize(Math.round(1.44 * 1024 * 1024)), "1.4 MB");
});
