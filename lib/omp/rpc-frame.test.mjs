import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  encodeOutboundRpcFrame,
  encodeRpcFrames,
  MAX_RPC_FRAME_BYTES,
  RpcFrameDecoder,
  RpcFrameTooLargeError,
} = await jiti.import("./rpc-frame.ts");

test("RPC v2 reassembles an oversized UTF-8 frame", () => {
  const frame = { type: "message_end", text: "x".repeat(MAX_RPC_FRAME_BYTES) };
  const encoded = encodeRpcFrames(frame, 2, "test-frame");
  assert.ok(encoded.length > 1);

  const decoder = new RpcFrameDecoder();
  let decoded;
  for (const line of encoded) decoded = decoder.push(JSON.parse(line));
  assert.deepEqual(decoded, frame);
});

test("RPC v2 rejects chunk reordering and v1 rejects oversized writes", () => {
  const frame = { type: "message_end", text: "x".repeat(MAX_RPC_FRAME_BYTES) };
  const encoded = encodeRpcFrames(frame, 2, "test-frame");
  const decoder = new RpcFrameDecoder();
  assert.throws(() => decoder.push(JSON.parse(encoded[1])), /start at index 0/);
  assert.throws(() => encodeRpcFrames(frame, 1, "test-frame"), /v1 transport limit/);
});

test("frames toward omp are one line each — an oversized one is refused, not chunked", () => {
  // omp's stdin reader has no chunk reassembly (rpc-input.ts), so a chunked
  // command would parse as an unknown, id-less line and never be answered.
  const ordinary = encodeOutboundRpcFrame({ type: "prompt", message: "hello", id: "w1" });
  assert.equal(ordinary.length, 1);
  assert.deepEqual(JSON.parse(ordinary[0]), { type: "prompt", message: "hello", id: "w1" });
  assert.ok(ordinary[0].endsWith("\n"));

  // Exactly at the limit still goes out as one line.
  const atLimit = { type: "prompt", message: "x".repeat(MAX_RPC_FRAME_BYTES - 64) };
  assert.equal(encodeOutboundRpcFrame(atLimit).length, 1);

  const oversized = { type: "prompt", message: "m", images: [{ type: "image", mimeType: "image/png", data: "A".repeat(MAX_RPC_FRAME_BYTES) }] };
  let error;
  try {
    encodeOutboundRpcFrame(oversized);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof RpcFrameTooLargeError, "an oversized outbound frame must throw RpcFrameTooLargeError");
  assert.equal(error.limit, MAX_RPC_FRAME_BYTES);
  assert.ok(error.byteLength > MAX_RPC_FRAME_BYTES);
  assert.equal(error.frameType, "prompt");
  // The message names the limit so the failure explains itself.
  assert.match(error.message, new RegExp(String(MAX_RPC_FRAME_BYTES)));
});
