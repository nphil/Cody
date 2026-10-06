import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { EspTransport, createEspFlasher, encodeEspSlip, md5Hex } = await jiti.import("./esp.ts");

function pauseUntilAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function fakeSerial(chunks = []) {
  const writes = [];
  const baudRates = [];
  const signals = [];
  return {
    kind: "serial",
    writes,
    baudRates,
    signals,
    async read(...args) {
      const signal = args[2];
      if (chunks.length > 0) return chunks.shift();
      return pauseUntilAborted(signal);
    },
    async write(bytes) {
      writes.push(Uint8Array.from(bytes));
    },
    async setBaudRate(baudRate) {
      baudRates.push(baudRate);
    },
    async setSignals(value) {
      signals.push(value);
    },
  };
}


test("ESP SLIP framing exactly escapes END and ESC, then decodes through a fake lease", async () => {
  const payload = Uint8Array.from([0, 0xc0, 0xdb, 0x7e]);
  assert.deepEqual([...encodeEspSlip(payload)], [0xc0, 0, 0xdb, 0xdc, 0xdb, 0xdd, 0x7e, 0xc0]);

  const wire = fakeSerial([
    Uint8Array.from([0xc0, 0x44, 0xdb]),
    Uint8Array.from([0xdc, 0xdb, 0xdd, 0xc0]),
  ]);
  const abort = new AbortController();
  const transport = new EspTransport(wire, abort.signal);
  void transport.readLoop();
  assert.deepEqual([...await transport.read(100)], [0x44, 0xc0, 0xdb]);
  await transport.write(payload);
  assert.deepEqual([...wire.writes[0]], [0xc0, 0, 0xdb, 0xdc, 0xdb, 0xdd, 0x7e, 0xc0]);
  await transport.connect();
  await transport.connect(921600);
  assert.deepEqual(wire.baudRates, [115200, 921600]);
  await transport.setDTR(false);
  await transport.setRTS(true);
  assert.deepEqual(wire.signals, [{ dtr: false }, { rts: true }]);
  await transport.dispose();
});

test("ESP MD5 matches device-write callback vectors", () => {
  assert.equal(md5Hex(new Uint8Array()), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex(new TextEncoder().encode("abc")), "900150983cd24fb0d6963f7d28e17f72");
});

test("ESP flash escrows and preserves a complete known erase footprint before one compressed write", async () => {
  const firmware = new Blob([Uint8Array.from([1, 2, 3])]);
  const footprintLength = 4096;
  const before = new Uint8Array(footprintLength).fill(9);
  const expected = new Uint8Array(before);
  expected.set([1, 2, 3]);
  const state = { reads: 0, writes: 0, writeOptions: undefined, events: [] };
  class FakeLoader {
    chip = { CHIP_NAME: "ESP32", BOOTLOADER_FLASH_OFFSET: 0x1000 };
    IS_STUB = true;
    WRITE_BLOCK_ATTEMPTS = 3;

    async main() { return "ESP32"; }
    async detectFlashSize() { return "4MB"; }
    async readFlash(offset, length, onPacketReceived) {
      assert.equal(offset, 0x10000);
      assert.equal(length, footprintLength);
      state.reads += 1;
      const data = state.reads === 1 ? before : expected;
      onPacketReceived?.(data, data.length, data.length);
      return data;
    }
    async writeFlash(options) {
      state.writes += 1;
      state.writeOptions = options;
      assert.equal(this.WRITE_BLOCK_ATTEMPTS, 1);
      assert.equal(options.compress, true);
      assert.equal(options.eraseAll, false);
      assert.equal(options.fileArray[0].address, 0x10000);
      assert.deepEqual([...options.fileArray[0].data], [...expected]);
      assert.equal(options.calculateMD5Hash(options.fileArray[0].data), "326b589cd5d75096f8ed99e43b4e3908");
    }
  }

  const serial = fakeSerial();
  const confirmations = [];
  const flasher = createEspFlasher(async () => ({ ESPLoader: FakeLoader }));
  const result = await flasher.run(
    { protocol: "esp", action: "flash", target: "firmware", offset: 0x10000, options: { expectedChip: "ESP32" } },
    {
      transport: serial,
      signal: new AbortController().signal,
      input: firmware,
      progress: (event) => state.events.push(event.phase),
      save: async (name, data) => {
        assert.match(name, /backup/);
        assert.deepEqual([...new Uint8Array(await data.arrayBuffer())], [...before]);
        assert.equal(state.writes, 0);
        return "escrow-1";
      },
      confirm: async (risk) => {
        confirmations.push(risk);
        assert.equal(risk.target, "firmware");
        assert.equal(risk.offset, 0x10000);
        assert.equal(risk.length, 3);
        assert.equal(risk.sha256, "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
        assert.equal(risk.programOffset, 0x10000);
        assert.equal(risk.programLength, footprintLength);
        assert.equal(risk.programSha256, "d6c72ba0c7763e27f71b473b882ee21937ed656bc6ba10a3e84c2cc45b271390");
        assert.equal(risk.backup, "escrow-1");
        assert.equal(state.writes, 0);
      },
    },
  );

  assert.equal(state.reads, 2);
  assert.equal(state.writes, 1);
  assert.equal(confirmations.length, 1);
  assert.equal(result.verified, true);
  assert.equal(result.sha256, "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
  assert.equal(state.writeOptions.flashMode, "keep");
  assert.ok(state.events.includes("backup"));
  assert.ok(state.events.includes("readback"));
});

test("ESP8266 offset-zero full image requires the named boot override and preserves the final erased sector tail", async () => {
  const payload = new Uint8Array(0x1003).fill(2);
  const firmware = new Blob([payload]);
  const footprintLength = 0x2000;
  const before = new Uint8Array(footprintLength).fill(9);
  const expected = new Uint8Array(before);
  expected.set(payload);
  const state = { reads: 0, writes: 0 };
  class FakeLoader {
    chip = { CHIP_NAME: "ESP8266", BOOTLOADER_FLASH_OFFSET: 0 };
    IS_STUB = true;
    WRITE_BLOCK_ATTEMPTS = 3;
    async main() { return "ESP8266"; }
    async detectFlashSize() { return "1MB"; }
    async readFlash(offset, length) {
      assert.equal(offset, 0);
      assert.equal(length, footprintLength);
      state.reads += 1;
      return state.reads === 1 ? before : expected;
    }
    async writeFlash(options) {
      state.writes += 1;
      assert.equal(this.WRITE_BLOCK_ATTEMPTS, 1);
      assert.equal(options.fileArray[0].address, 0);
      assert.deepEqual([...options.fileArray[0].data], [...expected]);
    }
  }
  const flasher = createEspFlasher(async () => ({ ESPLoader: FakeLoader }));
  const result = await flasher.run(
    { protocol: "esp", action: "flash", target: "flash", offset: 0, options: { expectedChip: "ESP8266", protectedOverride: "allow-spi-boot" } },
    {
      transport: fakeSerial(),
      signal: new AbortController().signal,
      input: firmware,
      progress() {},
      save: async (_name, data) => {
        assert.deepEqual([...new Uint8Array(await data.arrayBuffer())], [...before]);
        return "escrow-8266";
      },
      confirm: async (risk) => {
        assert.equal(risk.offset, 0);
        assert.equal(risk.length, payload.length);
        assert.equal(risk.programOffset, 0);
        assert.equal(risk.programLength, footprintLength);
      },
    },
  );
  assert.equal(result.verified, true);
  assert.equal(state.reads, 2);
  assert.equal(state.writes, 1);
});

test("ESP32 factory image crossing protected boot and firmware requires named override and preserves its tail", async () => {
  const payload = new Uint8Array(0x10003).fill(3);
  const firmware = new Blob([payload]);
  const footprintLength = 0x11000;
  const before = new Uint8Array(footprintLength).fill(9);
  const expected = new Uint8Array(before);
  expected.set(payload);
  const state = { reads: 0, writes: 0 };
  class FakeLoader {
    chip = { CHIP_NAME: "ESP32", BOOTLOADER_FLASH_OFFSET: 0x1000 };
    IS_STUB = true;
    WRITE_BLOCK_ATTEMPTS = 3;
    async main() { return "ESP32"; }
    async detectFlashSize() { return "4MB"; }
    async readFlash(offset, length) {
      assert.equal(offset, 0);
      assert.equal(length, footprintLength);
      state.reads += 1;
      return state.reads === 1 ? before : expected;
    }
    async writeFlash(options) {
      state.writes += 1;
      assert.equal(options.fileArray[0].address, 0);
      assert.equal(options.fileArray[0].data[0], 3);
      assert.equal(options.fileArray[0].data[0x1000], 3);
      assert.equal(options.fileArray[0].data[0x10000], 3);
      assert.equal(options.fileArray[0].data[0x10003], 9);
    }
  }
  const flasher = createEspFlasher(async () => ({ ESPLoader: FakeLoader }));
  await flasher.run(
    {
      protocol: "esp",
      action: "flash",
      target: "factory",
      offset: 0,
      options: { expectedChip: "ESP32", protectedOverride: "allow-spi-boot" },
    },
    {
      transport: fakeSerial(),
      signal: new AbortController().signal,
      input: firmware,
      progress() {},
      save: async (_name, data) => {
        assert.equal(data.size, footprintLength);
        return "escrow-factory";
      },
      confirm: async (risk) => {
        assert.equal(risk.offset, 0);
        assert.equal(risk.length, payload.length);
        assert.equal(risk.programLength, footprintLength);
      },
    },
  );
  assert.equal(state.reads, 2);
  assert.equal(state.writes, 1);
});

test("ESP rejects caller-supplied safety layouts before reading or writing flash", async () => {
  let reads = 0;
  class FakeLoader {
    chip = { CHIP_NAME: "ESP32", BOOTLOADER_FLASH_OFFSET: 0x1000 };
    IS_STUB = true;
    WRITE_BLOCK_ATTEMPTS = 3;
    async main() { return "ESP32"; }
    async detectFlashSize() { return "4MB"; }
    async readFlash() { reads += 1; return new Uint8Array(3); }
    async writeFlash() { throw new Error("must not write"); }
  }
  const flasher = createEspFlasher(async () => ({ ESPLoader: FakeLoader }));
  await assert.rejects(
    flasher.run(
      { protocol: "esp", action: "flash", target: "firmware", offset: 0x10000, options: { safety: {} } },
      {
        transport: fakeSerial(),
        signal: new AbortController().signal,
        input: new Blob(["abc"]),
        progress() {},
        save: async () => "unused",
        confirm: async () => {},
      },
    ),
    /caller-supplied safety layouts/,
  );
  assert.equal(reads, 0);
});
