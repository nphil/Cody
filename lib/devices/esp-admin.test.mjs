import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { OPS, fakeEspChip, securityInfoPayload } from "./esp.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createEspFlasher, parseEspCommand, parseEspSecurityInfo } = await jiti.import("./esp.ts");
const { ESP_EFUSE_LAYOUTS, readEspSecurity, readEfuseBlocks, readEfuseKeyPurposes, describeEfuseBlock } = await jiti.import("./esp-efuse.ts");
const bundle = await import("esptool-js/bundle.js");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The chip object esptool-js would have detected, with the read-only probes Cody calls. */
function chipObject(name, { bootOffset = 0x1000, revision = 3, mac = "aa:bb:cc:dd:ee:ff" } = {}) {
  return {
    CHIP_NAME: name,
    BOOTLOADER_FLASH_OFFSET: bootOffset,
    async getChipDescription() { return `${name} (emulated)`; },
    async getChipFeatures() { return ["Wi-Fi", "BLE"]; },
    async getCrystalFreq() { return 40; },
    async getChipRevision() { return revision; },
    async readMac() { return mac; },
  };
}

/**
 * The REAL esptool-js loader over the emulated stub. Only `main()` (reset, sync,
 * stub upload) and the SPI-register flash-id dance are replaced; every command
 * Cody's code sends is encoded and parsed by esptool-js itself.
 */
function emulated(chip, { stub = true, flashId = 0x001240ef } = {}) {
  return async () => ({
    ESPLoader: class extends bundle.ESPLoader {
      async main() {
        this.chip = chip;
        this.IS_STUB = stub;
        this.transport.readLoop();
        return chip.CHIP_NAME;
      }
      async readFlashId() { return flashId; }
    },
  });
}

function context(hardware, over = {}) {
  const controller = new AbortController();
  const state = { confirmations: [], saved: [], outputs: [], streams: [], seen: [] };
  return {
    transport: hardware,
    signal: controller.signal,
    controller,
    progress: () => {},
    output: (text) => state.outputs.push(text),
    save: async (name, blob) => {
      state.saved.push({ name, blob });
      return `saved:${name}`;
    },
    saveStream: async (name, chunks) => {
      const parts = [];
      for await (const chunk of chunks) parts.push(Buffer.from(chunk));
      const bytes = Buffer.concat(parts);
      state.streams.push({ name, bytes });
      return { fileId: `stream:${name}`, sha256: sha256(bytes), length: bytes.length };
    },
    confirm: async (risk) => {
      state.confirmations.push(risk);
      state.beforeConfirm?.(risk);
    },
    ...state,
    ...over,
  };
}

const run = (flasher, request, ctx) => flasher.run({ protocol: "esp", ...request }, ctx);
const exec = (command, extra = {}) => ({ action: "exec", command, ...extra });
const opsOf = (chip) => chip.commands.map((entry) => entry.op);

test("erase_region parses esptool arguments and refuses what esptool refuses", () => {
  assert.deepEqual(parseEspCommand("erase_region 0x10000 0x20000"), { kind: "erase_region", offset: 0x10000, length: 0x20000 });
  assert.deepEqual(parseEspCommand("esptool.py erase-region 65536 64k"), { kind: "erase_region", offset: 65536, length: 65536 });
  assert.deepEqual(parseEspCommand("erase_region 0 1M"), { kind: "erase_region", offset: 0, length: 1048576 });
  assert.deepEqual(parseEspCommand("esptool erase-flash"), { kind: "erase_flash" });
  assert.deepEqual(parseEspCommand("espefuse.py summary"), { kind: "efuse_summary" });
  assert.deepEqual(parseEspCommand("espefuse dump"), { kind: "efuse_dump" });
  assert.deepEqual(parseEspCommand("chip-id"), { kind: "chip_id" });
  assert.throws(() => parseEspCommand("erase_region 0x10001 0x1000"), /multiple of 4096/);
  assert.throws(() => parseEspCommand("erase_region 0x10000 0x1001"), /multiple of 4096/);
  assert.throws(() => parseEspCommand("erase_region 0x10000 0"), /greater than zero/);
  assert.throws(() => parseEspCommand("erase_region 0x10000"), /ADDRESS and a SIZE/);
  assert.throws(() => parseEspCommand("erase_region 0x1k 0x1000"), /decimal or 0x hexadecimal/);
  assert.throws(() => parseEspCommand("erase_region 0x10000 0x1000 extra"), /ADDRESS and a SIZE/);
  assert.throws(() => parseEspCommand("erase_flash --force"), /options are not accepted/);
  assert.throws(() => parseEspCommand("--chip esp32 erase_flash"), /options are not accepted/);
  assert.throws(() => parseEspCommand("espefuse burn_efuse DISABLE_DL_ENCRYPT"), /irreversible/);
  assert.throws(() => parseEspCommand("espefuse write_protect_efuse RD_DIS"), /irreversible/);
  assert.throws(() => parseEspCommand("write_flash 0x0 a.bin"), /device_flash/);
  assert.throws(() => parseEspCommand("load_ram x.bin"), /Unsupported ESP command/);
  assert.throws(() => parseEspCommand(""), /ESP command is required/);
});

test("erase_region backs up the range, waits for approval, erases once on the wire, and proves it blank", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000 });
  const before = Uint8Array.from(chip.flash);
  const ctx = context(chip.hardware);
  ctx.beforeConfirm = (risk) => {
    // Nothing has been erased, and the backup is already escrowed with its hash.
    assert.equal(opsOf(chip).includes(OPS.eraseRegion), false);
    assert.deepEqual(chip.flash, before);
    const backup = ctx.streams[0];
    assert.equal(backup.bytes.length, 0x4000);
    assert.deepEqual(Uint8Array.from(backup.bytes), before.slice(0x10000, 0x14000));
    assert.match(risk.backup, new RegExp(`stream:.*${sha256(backup.bytes)}`));
  };
  const result = await run(createEspFlasher(emulated(chipObject("ESP32"))), exec("erase_region 0x10000 0x4000"), ctx);

  assert.equal(ctx.confirmations.length, 1);
  const [risk] = ctx.confirmations;
  assert.equal(risk.action, "esp erase_region");
  assert.equal(risk.target, "flash");
  assert.equal(risk.offset, 0x10000);
  assert.equal(risk.length, 0x4000);
  assert.equal(risk.protectedOverride, undefined, "an application-area erase on an unsecured chip needs no typed override");

  assert.deepEqual(chip.flash.slice(0x10000, 0x14000), new Uint8Array(0x4000).fill(0xff));
  assert.deepEqual(chip.flash.slice(0, 0x10000), before.slice(0, 0x10000));
  assert.deepEqual(chip.flash.slice(0x14000), before.slice(0x14000));

  const erase = chip.commands.filter((entry) => entry.op === OPS.eraseRegion);
  assert.equal(erase.length, 1, "the erase is sent once and never retried");
  assert.deepEqual([...erase[0].data], [0x00, 0x00, 0x01, 0x00, 0x00, 0x40, 0x00, 0x00], "ESP_ERASE_REGION payload is little-endian offset then size");
  const order = opsOf(chip);
  assert.ok(order.indexOf(OPS.readFlash) < order.indexOf(OPS.eraseRegion) && order.indexOf(OPS.eraseRegion) < order.indexOf(OPS.md5), "backup, erase, then verify");
  assert.equal(result.verified, true);
  assert.equal(result.details.backupId, ctx.streams[0] && `stream:${ctx.streams[0].name}`);
  assert.match(result.summary, /verified it blank/);
});

test("an erase that touches the SPI boot area demands that exact override, typed by the user", async () => {
  for (const [name, bootOffset, region, expected] of [
    ["ESP32", 0x1000, "0x0 0x1000", undefined],
    ["ESP32", 0x1000, "0x1000 0x1000", "allow-spi-boot"],
    ["ESP32", 0x1000, "0x0 0x20000", "allow-spi-boot"],
    ["ESP32-S3", 0, "0x0 0x1000", "allow-spi-boot"],
    ["ESP32-S3", 0, "0xf000 0x2000", "allow-spi-boot"],
    ["ESP32-S3", 0, "0x10000 0x1000", undefined],
  ]) {
    const chip = fakeEspChip({ flashSize: 0x40000 });
    const ctx = context(chip.hardware);
    await run(createEspFlasher(emulated(chipObject(name, { bootOffset }))), exec(`erase_region ${region}`), ctx);
    assert.equal(ctx.confirmations[0].protectedOverride, expected, `${name} erase ${region}`);
  }
});

test("a chip with secure boot or flash encryption burned, or one Cody has not reviewed, needs its own override", async () => {
  const cases = [
    // ESP32: FLASH_CRYPT_CNT has an odd number of bits set.
    ["ESP32", { 0x3ff5a000: 0x00100000 }, "allow-fuses"],
    // ESP32: an even number of bits set is flash encryption off.
    ["ESP32", { 0x3ff5a000: 0x00300000 }, undefined],
    // ESP32 secure boot v1 (ABS_DONE_0).
    ["ESP32", { 0x3ff5a018: 1 << 4 }, "allow-fuses"],
    // ESP32-S3: SPI_BOOT_CRYPT_CNT = 1 and SECURE_BOOT_EN.
    ["ESP32-S3", { 0x60007034: 1 << 18 }, "allow-fuses"],
    ["ESP32-S3", { 0x60007038: 1 << 20 }, "allow-fuses"],
    ["ESP32-C3", { 0x60008838: 1 << 20 }, "allow-fuses"],
    ["ESP32-C2", { 0x60008830: 1 << 21 }, "allow-fuses"],
    // A chip newer than the reviewed table is not guessed at.
    ["ESP32-P4", {}, "allow-unknown"],
  ];
  for (const [name, registers, expected] of cases) {
    const chip = fakeEspChip({ flashSize: 0x40000, registers });
    const ctx = context(chip.hardware);
    await run(createEspFlasher(emulated(chipObject(name, { bootOffset: name === "ESP32" ? 0x1000 : 0 }))), exec("erase_region 0x20000 0x1000"), ctx);
    assert.equal(ctx.confirmations[0].protectedOverride, expected, `${name} ${JSON.stringify(registers)}`);
  }
  // Both reasons together are both typed.
  const chip = fakeEspChip({ flashSize: 0x40000, registers: { 0x3ff5a000: 0x00100000 } });
  const ctx = context(chip.hardware);
  await run(createEspFlasher(emulated(chipObject("ESP32"))), exec("erase_region 0x1000 0x1000"), ctx);
  assert.equal(ctx.confirmations[0].protectedOverride, "allow-spi-boot allow-fuses");
  assert.match(ctx.confirmations[0].details, /Flash encryption: enabled \(counter 1\)/);
});

test("ESP32 Secure Boot V2 only counts on silicon revision 3 or later, but an unknown revision is read", async () => {
  const read = (registers, revision) => readEspSecurity("ESP32", async (address) => registers[address] ?? 0, revision);
  const v2 = { 0x3ff5a018: 1 << 5 };
  assert.equal((await read(v2, 2)).secureBoot, false);
  assert.deepEqual(await read(v2, 3), { secureBoot: true, secureBootVersion: "v2", flashEncryption: false, flashCryptCnt: 0, basis: "efuse-registers" });
  assert.equal((await read(v2, undefined)).secureBoot, true);
  assert.equal((await readEspSecurity("ESP8266", async () => { throw new Error("must not read"); })).basis, "not-applicable");
  const failed = await readEspSecurity("ESP32", async () => { throw new Error("link lost"); });
  assert.equal(failed.secureBoot, undefined);
  assert.equal(failed.basis, "read-failed");
  assert.match(failed.note, /link lost/);
});

test("erase_flash backs up the whole chip, sends ESP_ERASE_FLASH once, and verifies every byte blank", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000 });
  const original = Uint8Array.from(chip.flash);
  const ctx = context(chip.hardware);
  const result = await run(createEspFlasher(emulated(chipObject("ESP32-S3", { bootOffset: 0 }))), exec("erase_flash"), ctx);
  assert.deepEqual(chip.flash, new Uint8Array(0x40000).fill(0xff));
  assert.deepEqual(Uint8Array.from(ctx.streams[0].bytes), original, "the escrowed backup is the whole pre-erase flash");
  const erase = chip.commands.filter((entry) => entry.op === OPS.eraseFlash);
  assert.equal(erase.length, 1);
  assert.equal(erase[0].data.length, 0);
  const risk = ctx.confirmations[0];
  assert.equal(risk.action, "esp erase_flash");
  assert.equal(risk.offset, 0);
  assert.equal(risk.length, 0x40000);
  assert.equal(risk.protectedOverride, "allow-spi-boot", "a whole-chip erase always includes the boot area");
  assert.equal(result.verified, true);
  assert.equal(result.details.backupSha256, sha256(original));
});

test("an erase larger than one piece is backed up and verified piece by piece", async () => {
  const chip = fakeEspChip({ flashSize: 0x200000 });
  const original = Uint8Array.from(chip.flash);
  const ctx = context(chip.hardware);
  await run(createEspFlasher(emulated(chipObject("ESP32", { bootOffset: 0x1000 }), { flashId: 0x001540ef })), exec("erase_flash"), ctx);
  assert.deepEqual(Uint8Array.from(ctx.streams[0].bytes), original);
  assert.equal(chip.commands.filter((entry) => entry.op === OPS.readFlash).length, 2, "two 1 MiB reads, never one 2 MiB buffer");
  assert.equal(chip.commands.filter((entry) => entry.op === OPS.md5).length, 2);
  assert.deepEqual(chip.flash, new Uint8Array(0x200000).fill(0xff));
});

test("without streaming escrow the backup is saved as a whole Blob and still hashed", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000 });
  const original = Uint8Array.from(chip.flash);
  const ctx = context(chip.hardware, { saveStream: undefined });
  await run(createEspFlasher(emulated(chipObject("ESP32"))), exec("erase_region 0x10000 0x1000"), ctx);
  assert.equal(ctx.saved.length, 1);
  assert.deepEqual(new Uint8Array(await ctx.saved[0].blob.arrayBuffer()), original.slice(0x10000, 0x11000));
  assert.match(ctx.confirmations[0].backup, /saved:/);
});

test("an erase the chip silently ignored is reported, not claimed as done", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000, ignoreErase: true });
  const ctx = context(chip.hardware);
  await assert.rejects(run(createEspFlasher(emulated(chipObject("ESP32"))), exec("erase_region 0x10000 0x1000"), ctx), /Erase verification failed.*device has been modified/);
  assert.equal(ctx.confirmations.length, 1, "approval came first");
});

test("a rejected erase command surfaces the chip's status and is never retried", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000, failErase: true });
  const ctx = context(chip.hardware);
  await assert.rejects(run(createEspFlasher(emulated(chipObject("ESP32"))), exec("erase_region 0x10000 0x1000"), ctx), /erase region.*status/i);
  assert.equal(chip.commands.filter((entry) => entry.op === OPS.eraseRegion).length, 1);
  assert.equal(chip.commands.some((entry) => entry.op === OPS.md5), false, "no verification claim after a failed erase");
});

test("a corrupted backup read stops before anything is approved or erased", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000, corruptReads: true });
  const ctx = context(chip.hardware);
  await assert.rejects(run(createEspFlasher(emulated(chipObject("ESP32"))), exec("erase_region 0x10000 0x1000"), ctx), /read was corrupted.*Nothing was erased/);
  assert.equal(ctx.confirmations.length, 0);
  assert.equal(chip.commands.some((entry) => entry.op === OPS.eraseRegion), false);
});

test("a stub that sends no read digest does not block a backup", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000, omitDigest: true });
  const ctx = context(chip.hardware);
  const result = await run(createEspFlasher(emulated(chipObject("ESP32"))), exec("erase_region 0x10000 0x1000"), ctx);
  assert.equal(result.verified, true);
});

test("declining the confirmation leaves the chip untouched", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000 });
  const original = Uint8Array.from(chip.flash);
  const ctx = context(chip.hardware, { confirm: async () => { throw new DOMException("Declined", "AbortError"); } });
  await assert.rejects(run(createEspFlasher(emulated(chipObject("ESP32"))), exec("erase_flash"), ctx), /Declined/);
  assert.deepEqual(chip.flash, original);
  assert.equal(chip.commands.some((entry) => entry.op === OPS.eraseFlash || entry.op === OPS.eraseRegion), false);
});

test("erase refuses a ROM-only connection, a wrong expected chip, an unsizable flash, and ranges outside the chip", async () => {
  const attempt = async (command, { stub = true, flashId, options, chipName = "ESP32" } = {}) => {
    const chip = fakeEspChip({ flashSize: 0x40000 });
    const ctx = context(chip.hardware);
    const failure = await run(createEspFlasher(emulated(chipObject(chipName), { stub, flashId })), exec(command, { options }), ctx).then(() => undefined, (error) => error);
    assert.equal(ctx.confirmations.length, 0);
    assert.equal(chip.commands.some((entry) => entry.op === OPS.eraseFlash || entry.op === OPS.eraseRegion), false, `${command} must not reach the chip`);
    return failure?.message ?? "";
  };
  assert.match(await attempt("erase_flash", { stub: false }), /needs esptool's flasher stub/);
  assert.match(await attempt("erase_region 0x10000 0x1000", { options: { expectedChip: "ESP32-S3" } }), /expected chip ESP32-S3 does not match detected chip ESP32/);
  assert.match(await attempt("erase_region 0x10000 0x1000", { flashId: 0x00ff40ef }), /does not map to a flash size Cody recognises/);
  assert.match(await attempt("erase_region 0x3f000 0x2000"), /escapes the detected 256KB flash/);
  assert.match(await attempt("erase_region 0x10000 0x1000", { options: { safety: {} } }), /caller-supplied safety layouts/);
});

test("chip_id, read_mac and flash_id answer from the chip without asking for approval", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000 });
  const flasher = createEspFlasher(emulated(chipObject("ESP32-S3", { bootOffset: 0, revision: 1 })));
  const id = context(chip.hardware);
  const identity = await run(flasher, exec("chip_id"), id);
  assert.deepEqual(identity.details, { chip: "ESP32-S3", description: "ESP32-S3 (emulated)", revision: 1, features: ["Wi-Fi", "BLE"], crystalMHz: 40, mac: "aa:bb:cc:dd:ee:ff" });
  assert.ok(id.outputs.some((line) => line.includes("MAC: aa:bb:cc:dd:ee:ff")));
  const mac = context(chip.hardware);
  assert.equal((await run(flasher, exec("read_mac"), mac)).details.mac, "aa:bb:cc:dd:ee:ff");
  const flash = context(chip.hardware);
  const flashId = await run(flasher, exec("flash_id"), flash);
  assert.deepEqual(flashId.details, { chip: "ESP32-S3", manufacturer: "ef", device: "4012", flashSize: "256KB" });
  assert.equal(id.confirmations.length + mac.confirmations.length + flash.confirmations.length, 0);
});

test("get_security_info parses both ROM reply shapes and reports an unsupported chip plainly", async () => {
  const info = securityInfoPayload({ flags: 0b101, flashCryptCnt: 1, keyPurposes: [9, 0, 0, 0, 0, 0, 4], chipId: 9, apiVersion: 2 });
  const full = parseEspSecurityInfo(info);
  assert.equal(full.parsedFlags.SECURE_BOOT_EN, true);
  assert.equal(full.parsedFlags.SECURE_DOWNLOAD_ENABLE, true);
  assert.equal(full.parsedFlags.SOFT_DIS_JTAG, false);
  assert.deepEqual([full.flashCryptCnt, full.chipId, full.apiVersion], [1, 9, 2]);
  assert.deepEqual(full.keyPurposes, [9, 0, 0, 0, 0, 0, 4]);
  assert.equal(parseEspSecurityInfo(securityInfoPayload({ flags: 0x40 })).chipId, undefined);
  assert.throws(() => parseEspSecurityInfo(new Uint8Array(13)), /12 or 20 bytes/);

  const flasher = createEspFlasher(emulated(chipObject("ESP32-S3", { bootOffset: 0 })));
  const modern = fakeEspChip({ securityInfo: info });
  const result = await run(flasher, exec("get_security_info"), context(modern.hardware));
  assert.match(result.summary, /SECURE_BOOT_EN, SECURE_DOWNLOAD_ENABLE/);
  assert.equal(modern.commands.filter((entry) => entry.op === OPS.securityInfo).length, 1);

  const s2 = fakeEspChip({ securityInfo: securityInfoPayload({ flags: 0x80 }) });
  const short = await run(createEspFlasher(emulated(chipObject("ESP32-S2"))), exec("get_security_info"), context(s2.hardware));
  assert.equal(short.details.chipId, undefined);
  assert.equal(short.details.parsedFlags.HARD_DIS_JTAG, true);

  const old = fakeEspChip({});
  await assert.rejects(run(createEspFlasher(emulated(chipObject("ESP32"))), exec("get_security_info"), context(old.hardware)), /does not answer get_security_info.*efuse_summary/);
});

test("efuse_summary reads the security state and key purposes from the registers esptool reads", async () => {
  const base = 0x60007000;
  const chip = fakeEspChip({ registers: {
    [base + 0x34]: (1 << 18) | (9 << 24) | (4 << 28), // one encryption-count bit; KEY0 = SECURE_BOOT_DIGEST0, KEY1 = XTS_AES_128_KEY
    [base + 0x38]: 1 << 20, // SECURE_BOOT_EN
  } });
  const ctx = context(chip.hardware);
  const result = await run(createEspFlasher(emulated(chipObject("ESP32-S3", { bootOffset: 0 }))), exec("espefuse summary"), ctx);
  assert.equal(result.details.security.secureBoot, true);
  assert.equal(result.details.security.flashEncryption, true);
  assert.deepEqual(result.details.keyPurposes.slice(0, 3), [
    { block: "BLOCK4", purpose: 9, name: "SECURE_BOOT_DIGEST0" },
    { block: "BLOCK5", purpose: 4, name: "XTS_AES_128_KEY" },
    { block: "BLOCK6", purpose: 0, name: "USER/EMPTY" },
  ]);
  assert.ok(ctx.outputs.includes("Secure boot: enabled (v2)"));
  assert.equal(ctx.confirmations.length, 0, "reading eFuse state is not a write");
  assert.equal(chip.commands.every((entry) => entry.op === OPS.readReg), true, "nothing but register reads reaches the chip");
});

test("efuse_dump asks first, keeps key contents out of the log, and saves every word", async () => {
  const base = 0x60007000;
  const secret = 0xdeadbeef;
  const chip = fakeEspChip({ registers: { [base + 0x9c]: secret, [base + 0x7c]: 0x01020304 } });
  const ctx = context(chip.hardware);
  const result = await run(createEspFlasher(emulated(chipObject("ESP32-S3", { bootOffset: 0 }))), exec("efuse_dump"), ctx);
  assert.equal(ctx.confirmations.length, 1);
  assert.match(ctx.confirmations[0].details, /key blocks that are not read-protected/);
  const log = ctx.outputs.join("\n");
  assert.doesNotMatch(log, /deadbeef/i, "key contents never reach the operation log");
  assert.match(log, /BLOCK4 \(KEY0\).*1 of 8 words non-zero; contents withheld/);
  assert.match(log, /BLOCK3 \(user data\) @0x6000707c: 01020304/);
  const saved = await ctx.saved[0].blob.text();
  assert.match(saved, /BLOCK4 \(KEY0\) @0x6000709c: deadbeef/i);
  assert.equal(result.sha256, sha256(Buffer.from(saved)));
  assert.equal(result.details.blocks.length, 11);
  assert.equal(chip.commands.every((entry) => entry.op === OPS.readReg), true);
  const total = ESP_EFUSE_LAYOUTS["ESP32-S3"].blocks.reduce((sum, block) => sum + block.words, 0);
  assert.equal(chip.commands.length, total);
});

test("efuse_dump on a chip Cody has not reviewed refuses instead of guessing addresses", async () => {
  const chip = fakeEspChip({});
  const ctx = context(chip.hardware);
  await assert.rejects(run(createEspFlasher(emulated(chipObject("ESP32-P4", { bootOffset: 0x2000 }))), exec("efuse_dump"), ctx), /no reviewed eFuse block map for ESP32-P4/);
  assert.equal(chip.commands.length, 0);
});

test("detect reports identity, MAC and the security state it can establish", async () => {
  const chip = fakeEspChip({ flashSize: 0x40000, registers: { 0x3ff5a000: 0x00100000 } });
  const result = await run(createEspFlasher(emulated(chipObject("ESP32"))), { action: "detect" }, context(chip.hardware));
  assert.equal(result.details.mac, "aa:bb:cc:dd:ee:ff");
  assert.equal(result.details.description, "ESP32 (emulated)");
  assert.equal(result.details.security.eFuseOperations, "read-only");
  assert.equal(result.details.security.flashEncryption, "enabled");
  assert.equal(result.details.security.secureBoot, "disabled");
  assert.equal(result.details.capabilities.eraseFlash, true);
});

test("eFuse layouts match Espressif's published register map", () => {
  const word = (chip, name) => ESP_EFUSE_LAYOUTS[chip].blocks.find((block) => block.name === name);
  assert.equal(word("ESP32", "BLOCK1").address, 0x3ff5a038);
  assert.equal(word("ESP32", "BLOCK3").address, 0x3ff5a078);
  assert.deepEqual(ESP_EFUSE_LAYOUTS.ESP32.blocks.map((block) => block.words), [7, 8, 8, 8]);
  assert.equal(word("ESP32-S3", "BLOCK4").address, 0x6000709c);
  assert.equal(word("ESP32-S3", "BLOCK9").address, 0x6000713c);
  assert.equal(word("ESP32-S3", "BLOCK10").address, 0x6000715c);
  assert.equal(word("ESP32-C3", "BLOCK1").address, 0x60008844);
  assert.equal(word("ESP32-C6", "BLOCK0").address, 0x600b082c);
  assert.equal(word("ESP32-H2", "BLOCK0").address, 0x600b082c);
  assert.equal(word("ESP32-S2", "BLOCK2").address, 0x3f41a05c);
  assert.equal(word("ESP32-C2", "BLOCK3").address, 0x60008860);
  assert.deepEqual(ESP_EFUSE_LAYOUTS["ESP32-C2"].blocks.map((block) => block.words), [2, 3, 8, 8]);
  for (const [chip, layout] of Object.entries(ESP_EFUSE_LAYOUTS)) {
    assert.equal(layout.blocks.filter((block) => block.secret).length > 0, true, `${chip} has key blocks`);
  }
});

test("key purposes and block reads use the reviewed registers only", async () => {
  const reads = [];
  // KEY4's purpose nibble is bits 8-11 of the register at base+0x38; 0xb is SECURE_BOOT_DIGEST2.
  const readReg = async (address) => { reads.push(address); return address === 0x60007038 ? 0x00000b00 : 0; };
  const purposes = await readEfuseKeyPurposes("ESP32-S3", readReg);
  assert.deepEqual(purposes.map((entry) => entry.name), ["USER/EMPTY", "USER/EMPTY", "USER/EMPTY", "USER/EMPTY", "SECURE_BOOT_DIGEST2", "USER/EMPTY"]);
  assert.deepEqual(new Set(reads), new Set([0x60007034, 0x60007038]));
  assert.equal(await readEfuseKeyPurposes("ESP32", readReg), undefined, "ESP32 has no key-purpose fields");
  assert.equal(await readEfuseBlocks("ESP32-P4", readReg), undefined);
  const dumped = await readEfuseBlocks("ESP32-C2", readReg);
  assert.equal(dumped.length, 4);
  assert.match(describeEfuseBlock(dumped[3]), /BLOCK3 \(KEY0\).*empty or read-protected/);
});
