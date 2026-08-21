import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// The utility process answers /api/models, whose get_available_models response
// grows with the provider catalog: an OpenRouter key alone contributed 466 of
// 502 models on a real install, pushing the payload to 1,058,841 bytes against
// omp's 1,048,576-byte frame limit. At protocol v1 omp cannot chunk, so it
// replaces the whole response with "RPC response exceeded the transport limit"
// — which surfaced in the UI as a bare "Model error" and an empty model list.
//
// Both entry points must negotiate. This is asserted against the source
// (matching the convention rpc-manager.test.mjs uses for the same invariant on
// the session path) because RpcProcess is constructed directly here, with no
// injectable transport to drive a >1MiB response through.

const source = await readFile(new URL("./rpc-utility.ts", import.meta.url), "utf8");

test("the shared utility process negotiates protocol v2 before running commands", () => {
  const startProcess = source.slice(
    source.indexOf("async function startProcess"),
    source.indexOf("export function runUtilityCommand"),
  );

  assert.match(startProcess, /const ready = await proc\.waitReady\(READY_TIMEOUT_MS\)/);
  assert.match(startProcess, /await proc\.negotiateProtocol\(ready\)/);
  // Negotiation failure must dispose the child rather than hand back a process
  // wedged at v1 that will drop every large response.
  assert.match(startProcess, /catch[\s\S]*proc\.dispose\(\)/);
});

test("the isolated utility process negotiates protocol v2 too", () => {
  const isolated = source.slice(source.indexOf("export async function runIsolatedUtilityCommand"));

  assert.match(isolated, /const ready = await proc\.waitReady\(READY_TIMEOUT_MS\)/);
  assert.match(isolated, /await proc\.negotiateProtocol\(ready\)/);
});

test("negotiation happens before the command is sent, not after", () => {
  for (const region of [
    source.slice(source.indexOf("async function startProcess"), source.indexOf("export function runUtilityCommand")),
    source.slice(source.indexOf("export async function runIsolatedUtilityCommand")),
  ]) {
    const negotiated = region.indexOf("negotiateProtocol");
    const sent = region.indexOf("sendCommand");
    if (sent === -1) continue;
    assert.ok(negotiated !== -1 && negotiated < sent, "negotiateProtocol must precede sendCommand");
  }
});
