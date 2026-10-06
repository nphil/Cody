import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { fastbootFlasher, parseFastbootResponse } = await jiti.import("./fastboot.ts");
const { dfuFlasher, parseDfuFunctionalDescriptor, parseDfuStatus } = await jiti.import("./dfu.ts");

const encoder = new TextEncoder();
const decode = new TextDecoder();
const abort = new AbortController().signal;

function bytes(value) {
  return encoder.encode(value);
}

function fastbootFrame(type, payload = "") {
  return bytes(`${type}${payload}`);
}


function context(transport, over = {}) {
  const confirmations = [];
  const saves = [];
  return {
    signal: abort,
    transport,
    progress: () => {},
    save: async (name, data) => {
      saves.push({ name, data });
      return `saved:${name}`;
    },
    confirm: async (risk) => confirmations.push(risk),
    confirmations,
    saves,
    ...over,
  };
}

function fastbootTransport(responses) {
  const writes = [];
  return {
    kind: "usb",
    writes,
    read: async () => responses.shift() ?? null,
    write: async (data) => writes.push(Uint8Array.from(data)),
  };
}

function dfuTransport(inResponses) {
  const controls = [];
  return {
    kind: "usb",
    alternateSetting: 0,
    dfu: { interfaceNumber: 2, alternateSetting: 0, alternateName: "firmware", attributes: 0x07, transferSize: 4, version: 0x0110 },
    interfaceNumber: 2,
    controls,
    read: async () => null,
    write: async () => {},
    controlIn: async (setup, length) => {
      controls.push({ direction: "in", setup: { ...setup }, length });
      const response = inResponses.shift();
      assert.ok(response, `unexpected control IN request ${setup.request}`);
      return response;
    },
    controlOut: async (setup, data) => {
      controls.push({ direction: "out", setup: { ...setup }, data: Uint8Array.from(data) });
    },
  };
}


test("Fastboot response parser recognizes all wire tags and rejects malformed DATA", () => {
  assert.deepEqual(parseFastbootResponse(fastbootFrame("INFO", "waiting")), { type: "INFO", message: "waiting" });
  assert.deepEqual(parseFastbootResponse(fastbootFrame("OKAY", "0.4")), { type: "OKAY", message: "0.4" });
  assert.deepEqual(parseFastbootResponse(fastbootFrame("FAIL", "denied")), { type: "FAIL", message: "denied" });
  assert.deepEqual(parseFastbootResponse(fastbootFrame("DATA", "00000010")), { type: "DATA", size: 16 });
  assert.throws(() => parseFastbootResponse(fastbootFrame("DATA", "10")), /eight hexadecimal/);
  assert.throws(() => parseFastbootResponse(bytes("NOPE")), /Unknown Fastboot/);
});

test("Fastboot detect sends getvar:version then getvar:all and retains INFO variables", async () => {
  const transport = fastbootTransport([
    fastbootFrame("OKAY", "0.4"),
    fastbootFrame("INFO", "product: fake"),
    fastbootFrame("INFO", "slot-count: 2"),
    fastbootFrame("OKAY"),
  ]);
  const operation = context(transport);
  const result = await fastbootFlasher.run({ protocol: "fastboot", action: "detect" }, operation);
  assert.deepEqual(transport.writes.map((value) => decode.decode(value)), ["getvar:version", "getvar:all"]);
  assert.equal(result.details.variables.product, "fake");
  assert.equal(result.details.variables["slot-count"], "2");
});

test("Fastboot whole-partition flash backs up, confirms, writes, and verifies full readback", async () => {
  const transport = fastbootTransport([
    fastbootFrame("OKAY", "fake-product"),
    fastbootFrame("OKAY", "0x10000000"),
    fastbootFrame("OKAY", "00000004"),
    fastbootFrame("OKAY", "00000004"),
    fastbootFrame("DATA", "00000004"), bytes("old!"), fastbootFrame("OKAY"),
    fastbootFrame("DATA", "00000004"), fastbootFrame("OKAY"),
    fastbootFrame("OKAY"),
    fastbootFrame("DATA", "00000004"), bytes("firm"), fastbootFrame("OKAY"),
  ]);
  const operation = context(transport, { input: new Blob([bytes("firm")]) });
  const result = await fastbootFlasher.run({ protocol: "fastboot", action: "flash", target: "boot", offset: 0, length: 4, options: { protectedOverride: "allow-unknown" } }, operation);
  assert.equal(result.verified, true);
  assert.equal(operation.confirmations.length, 1);
  assert.equal(operation.confirmations[0].target, "boot");
  assert.equal(operation.confirmations[0].offset, 0);
  assert.equal(operation.confirmations[0].length, 4);
  assert.equal(operation.saves[0].name, "boot.preflash.bin");
  assert.deepEqual(transport.writes.map((value) => decode.decode(value)), [
    "getvar:product", "getvar:max-download-size", "getvar:partition-size:boot", "getvar:fetch-size", "fetch:boot:0:4",
    "download:00000004", "firm", "flash:boot", "fetch:boot:0:4",
  ]);
});

test("Fastboot explicit download hashes, confirms, and follows DATA framing", async () => {
  const transport = fastbootTransport([fastbootFrame("DATA", "00000004"), fastbootFrame("OKAY")]);
  const operation = context(transport, { input: new Blob([bytes("firm")]) });
  const result = await fastbootFlasher.run({ protocol: "fastboot", action: "exec", command: "download" }, operation);
  assert.equal(result.verified, false);
  assert.equal(operation.confirmations.length, 1);
  assert.equal(operation.confirmations[0].target, "fastboot-download-buffer");
  assert.deepEqual(transport.writes.map((value) => decode.decode(value)), ["download:00000004", "firm"]);
});

test("DFU descriptor and GETSTATUS parsers enforce standard response shapes", () => {
  assert.deepEqual(parseDfuFunctionalDescriptor(Uint8Array.from([9, 0x21, 7, 0, 0, 4, 0, 0x10, 0x01])), { attributes: 7, transferSize: 4, version: 0x0110 });
  assert.throws(() => parseDfuFunctionalDescriptor(Uint8Array.from([9, 0x21, 1, 0, 0, 0, 0, 0x10, 0x01])), /zero transfer/);
  assert.deepEqual(parseDfuStatus(Uint8Array.from([0, 7, 0, 0, 5, 3])), { status: "OK", pollTimeoutMs: 7, state: "dfuDNLOAD_IDLE", statusStringIndex: 3 });
  assert.throws(() => parseDfuStatus(Uint8Array.from([0, 0, 0])), /6 bytes/);
});

test("DFU dump binds to the descriptor-selected alternate and standard upload wire", async () => {
  const descriptor = Uint8Array.from([9, 0x21, 0x02, 0, 0, 4, 0, 0x10, 0x01]);
  const transport = dfuTransport([descriptor, Uint8Array.from([0, 0, 0, 0, 2, 0]), bytes("dump"), Uint8Array.from([0, 0, 0, 0, 2, 0])]);
  const operation = context(transport);
  const result = await dfuFlasher.run({ protocol: "dfu", action: "dump", target: "firmware", offset: 0, length: 4 }, operation);
  assert.equal(result.verified, true);
  assert.equal(operation.confirmations[0].action, "dfu dump");
  assert.deepEqual(transport.controls.map(({ direction, setup, length, data }) => ({ direction, requestType: setup.requestType, request: setup.request, value: setup.value, length, data: data && decode.decode(data) })), [
    { direction: "in", requestType: "standard", request: 6, value: 0x2100, length: 9, data: undefined },
    { direction: "in", requestType: "class", request: 3, value: 0, length: 6, data: undefined },
    { direction: "in", requestType: "class", request: 2, value: 0, length: 4, data: undefined },
    { direction: "out", requestType: "class", request: 6, value: 0, length: undefined, data: "" },
    { direction: "in", requestType: "class", request: 3, value: 0, length: 6, data: undefined },
  ]);
});

test("DFU ignores caller descriptor metadata and validates the device descriptor", async () => {
  const transport = dfuTransport([Uint8Array.of(0)]);
  const operation = context(transport);
  await assert.rejects(
    dfuFlasher.run({ protocol: "dfu", action: "detect", options: { dfu: { descriptor: {} } } }, operation),
    /functional descriptor/,
  );
});
test("DfuSe refuses an unrecognized memory map before class transfers", async () => {
  const transport = dfuTransport([Uint8Array.from([9, 0x21, 7, 0, 0, 4, 0, 0x1a, 1])]);
  await assert.rejects(dfuFlasher.run({ protocol: "dfu", action: "dump", target: "firmware", offset: 0, length: 4 }, context(transport)), /Internal Flash memory descriptor/);
  assert.deepEqual(transport.controls.map(({ setup }) => setup.request), [6]);
});

function dfuseDevice({ failWrite = false, corruptReadback = false, name = "@Internal Flash /0x08000000/02*008Bg" } = {}) {
  const memory = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const original = memory.slice(), erases = [], writes = [];
  let state = 2, pointer = 0x08000000, approved = false;
  const transport = {
    kind: "usb", interfaceNumber: 3, alternateSetting: 1,
    dfu: { interfaceNumber: 3, alternateSetting: 1, alternateName: name },
    read: async () => null, write: async () => { throw Error("bulk transfer forbidden"); },
    controlIn: async (setup, length) => {
      assert.equal(setup.index, 3);
      if (setup.requestType === "standard") return Uint8Array.from([9, 0x21, 3, 0, 0, 4, 0, 0x1a, 1]);
      if (setup.request === 3) return Uint8Array.from([0, 0, 0, 0, state, 0]);
      assert.equal(setup.request, 2);
      assert.ok(state === 2 || state === 9); assert.ok(setup.value >= 2);
      state = 9;
      const at = pointer - 0x08000000 + (setup.value - 2) * 4;
      const data = memory.slice(at, at + length);
      if (corruptReadback && writes.length) data[0] ^= 1;
      return data;
    },
    controlOut: async (setup, data) => {
      assert.equal(setup.index, 3);
      if (setup.request === 6) { state = 2; return; }
      assert.equal(setup.request, 1); assert.ok(state === 2 || state === 5);
      assert.ok(data.length, "must not manifest/reset before verification");
      state = 5;
      if (setup.value === 0) {
        assert.equal(data.length, 5);
        const address = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
        if (data[0] === 0x21) pointer = address;
        else {
          assert.equal(data[0], 0x41); assert.ok(approved, "erase before approval");
          erases.push(address); memory.fill(255, address - 0x08000000, address - 0x08000000 + 8);
        }
      } else {
        assert.ok(approved, "write before approval"); assert.ok(setup.value >= 2);
        const at = pointer - 0x08000000 + (setup.value - 2) * 4;
        writes.push(at); memory.set(data, at);
        if (failWrite) throw Error("lost write acknowledgement");
      }
    },
  };
  return { transport, memory, original, erases, writes, approve() { approved = true; } };
}

async function dfuseFlashCase(device, overrides = {}) {
  const input = new Blob([Uint8Array.from([51, 52, 53, 54, 55, 56])]);
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", await input.arrayBuffer())).toString("hex");
  const operation = context(device.transport, { input });
  operation.confirm = async (risk) => {
    assert.equal(operation.saves.length, 1);
    assert.deepEqual(new Uint8Array(await operation.saves[0].data.arrayBuffer()), device.original);
    assert.deepEqual(device.erases, []);
    assert.equal(risk.sha256, sha256); assert.equal(risk.offset, 0x08000006); assert.equal(risk.length, 6);
    assert.equal(risk.programOffset, 0x08000000); assert.equal(risk.programLength, 16);
    device.approve();
  };
  return dfuFlasher.run({ protocol: "dfu", action: "flash", target: "internal-flash", offset: 0x08000006, sha256, options: { protectedOverride: "allow-bootloader" }, ...overrides }, operation);
}

test("DfuSe preserves full erase sectors and verifies stored bytes before leaving DFU", async () => {
  const device = dfuseDevice();
  const result = await dfuseFlashCase(device);
  assert.equal(result.verified, true);
  assert.deepEqual(device.erases, [0x08000000, 0x08000008]);
  const expected = device.original.slice(); expected.set([51, 52, 53, 54, 55, 56], 6);
  assert.deepEqual(device.memory, expected);
  assert.deepEqual(device.writes, [0, 4, 8, 12]);
});

test("DfuSe rejects protected writes and unsafe descriptor maps before erase", async () => {
  const device = dfuseDevice();
  await assert.rejects(dfuseFlashCase(device, { options: {} }), /allow-bootloader/);
  assert.deepEqual(device.erases, []); assert.deepEqual(device.writes, []);
  for (const name of ["@Option Bytes /0x1ffff800/01*016Bg", "@Internal Flash /0x08000000/01*008Ba", "@Internal Flash /0x08000000/02*008Bg/trailing", "@Internal Flash /0x08000000/999999999*008Bg"]) {
    const invalid = dfuseDevice({ name });
    await assert.rejects(dfuseFlashCase(invalid), /descriptor|sector|bounds/);
    assert.deepEqual(invalid.erases, []);
  }
});

test("DfuSe never retries an uncertain write or accepts corrupt readback", async () => {
  const interrupted = dfuseDevice({ failWrite: true });
  await assert.rejects(dfuseFlashCase(interrupted), /lost write acknowledgement/);
  assert.equal(interrupted.writes.length, 1);
  await assert.rejects(dfuseFlashCase(dfuseDevice({ corruptReadback: true })), /readback|verification|SHA-256/i);
});
