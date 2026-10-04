import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { crc32 as zlibCrc32 } from "node:zlib";
import { createJiti } from "jiti";
import { buildDisk, fakeEdlDevice, loaderImage, movePrimaryBackupPointer, patchGptHeader, SECTOR, sha256 } from "./edl.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { EdlLink, EdlError, edlTimeouts } = await jiti.import("./edl-link.ts");
const sahara = await jiti.import("./edl-sahara.ts");
const xml = await jiti.import("./edl-xml.ts");
const gpt = await jiti.import("./edl-gpt.ts");
const firehose = await jiti.import("./edl-firehose.ts");

const encoder = new TextEncoder();

// The emulator answers within the same tick, so the quiet windows that end a programmer's chatter can be short.
edlTimeouts.greetingQuiet = 25;
edlTimeouts.nopQuiet = 25;

/** Shortens the waits of the failure paths for the duration of one test. */
async function withTimeouts(overrides, body) {
  const saved = { ...edlTimeouts };
  Object.assign(edlTimeouts, overrides);
  try {
    return await body();
  } finally {
    Object.assign(edlTimeouts, saved);
  }
}

function linkTo(device, controller = new AbortController()) {
  return { link: new EdlLink(device.transport, controller.signal), controller };
}

async function loaded(device, loader = device.loader) {
  const { link, controller } = linkTo(device);
  const hello = await sahara.awaitHello(link, 1000, "hello");
  await sahara.saharaUpload(link, hello, new Blob([loader]), { progress() {}, note() {} });
  const session = new firehose.FirehoseSession(link, () => {});
  await session.start();
  return { link, controller, session };
}

async function collect(generator) {
  const chunks = [];
  for await (const chunk of generator) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("the checksum GPT relies on is CRC-32/IEEE", () => {
  for (const sample of [Buffer.alloc(0), Buffer.from("123456789"), Buffer.alloc(4096, 0xa5), Buffer.from(Array.from({ length: 1000 }, (_, index) => (index * 37) & 0xff))]) {
    assert.equal(gpt.crc32(sample), zlibCrc32(sample));
  }
});

// ---- Sahara ----------------------------------------------------------------

test("Sahara command mode reads the serial number, hardware id and key hash, and leaves the device waiting for a loader", async () => {
  const device = fakeEdlDevice();
  const { link } = linkTo(device);
  const hello = await sahara.awaitHello(link, 1000, "hello");
  assert.deepEqual(hello, { version: 2, minVersion: 1, maxPacketBytes: 0x400, mode: 0 });
  const identity = await sahara.saharaIdentify(link, hello, { consumeNextHello: true });
  assert.equal(identity.serial, "1a2b3c4d");
  assert.equal(identity.hardwareId, "000460e100020000");
  assert.equal(identity.msmId, "0460e1");
  assert.equal(identity.oemId, "0002");
  assert.equal(identity.modelId, "0000");
  assert.equal(identity.pkHash, createHash("sha256").update("oem root key").digest("hex"));
  assert.equal(identity.pkHashBytes, 32);
  assert.deepEqual(identity.warnings, []);
  assert.equal(identity.backInLoaderState, true);
  assert.deepEqual(device.saharaLog.map((entry) => entry.command), [0x02, 0x0d, 0x0f, 0x0d, 0x0f, 0x0d, 0x0f, 0x0c]);
  assert.deepEqual(device.saharaLog.filter((entry) => entry.executed !== undefined).map((entry) => entry.executed), [1, 2, 3]);
  assert.equal(device.saharaLog[0].mode, 3, "command mode was asked for, not an image transfer");
});

test("a device that does not say HELLO again after the switch back is reported, not hung on", async () => {
  await withTimeouts({ packet: 80 }, async () => {
    const device = fakeEdlDevice({ helloAfterSwitch: "silent" });
    const { link } = linkTo(device);
    const identity = await sahara.saharaIdentify(link, await sahara.awaitHello(link, 1000, "hello"), { consumeNextHello: true });
    assert.equal(identity.backInLoaderState, false);
    assert.match(identity.warnings.join(" "), /did not say HELLO again/);
    assert.equal(identity.serial, "1a2b3c4d", "what was read before is kept");
  });
});

test("a boot ROM that refuses the hardware id keeps what it did give and says what it would not", async () => {
  const device = fakeEdlDevice({ refuseExecute: [2] });
  const { link } = linkTo(device);
  const identity = await sahara.saharaIdentify(link, await sahara.awaitHello(link, 1000, "hello"), { consumeNextHello: true });
  assert.equal(identity.serial, "1a2b3c4d");
  assert.equal(identity.hardwareId, null);
  assert.equal(identity.pkHash, null);
  assert.match(identity.warnings.join(" "), /would not give its hardware id.*0x1f/s);
  assert.match(identity.warnings.join(" "), /left in command mode/);
});

test("a boot ROM without command mode answers the identify with its own refusal", async () => {
  const device = fakeEdlDevice({ commandMode: false });
  const { link } = linkTo(device);
  await assert.rejects(sahara.saharaIdentify(link, await sahara.awaitHello(link, 1000, "hello"), { consumeNextHello: true }), (error) => error instanceof sahara.SaharaRejection && error.status === 0x18 && /command mode/.test(error.message));
});

test("a device that needs a newer Sahara than Cody speaks is refused before anything is sent", async () => {
  const device = fakeEdlDevice({ saharaVersion: 3, saharaMinVersion: 3 });
  const { link } = linkTo(device);
  await assert.rejects(sahara.awaitHello(link, 1000, "hello"), (error) => error instanceof EdlError && error.kind === "refused" && /version 3/.test(error.message));
  assert.equal(device.saharaLog.length, 0);
});

test("a loader the boot ROM accepts is served piece by piece to the end, and the device then runs a programmer", async () => {
  const loader = loaderImage(10000);
  const device = fakeEdlDevice({ loader });
  const { link } = linkTo(device);
  const hello = await sahara.awaitHello(link, 1000, "hello");
  const progress = [];
  const result = await sahara.saharaUpload(link, hello, new Blob([loader]), { progress: (sent, total) => progress.push([sent, total]), note() {} });
  assert.equal(result.doneStatus, 1);
  assert.equal(result.bytesSent, loader.length);
  assert.equal(result.paddedBytes, 0);
  assert.ok(result.requests >= 4);
  assert.equal(device.loaderAccepted, true);
  assert.ok(device.uploadedLoader.equals(loader), "the device received exactly the bytes of the file");
  assert.equal(device.mode, "firehose");
  assert.deepEqual(progress.at(-1), [loader.length, loader.length]);
  assert.ok(progress.every((entry, index) => index === 0 || entry[0] >= progress[index - 1][0]), "progress never goes backwards");
});

test("a loader for another device is rejected by the boot ROM with its own words, and is not reported as running", async () => {
  const device = fakeEdlDevice({ loader: loaderImage(8000, 3) });
  const { link } = linkTo(device);
  const hello = await sahara.awaitHello(link, 1000, "hello");
  await assert.rejects(
    sahara.saharaUpload(link, hello, new Blob([loaderImage(8000, 4)]), { progress() {}, note() {} }),
    (error) => error instanceof sahara.SaharaRejection && error.status === 0x21 && /did not accept the loader/.test(error.message) && /0x21/.test(error.message) && /was not run/.test(error.message),
  );
  assert.equal(device.loaderAccepted, false);
  assert.equal(device.mode, "sahara");
});

test("a device that asks a little past the end of the loader is answered with padding, and says so", async () => {
  const loader = loaderImage(6000);
  const device = fakeEdlDevice({ loader, loaderOverread: 100 });
  const { link } = linkTo(device);
  const notes = [];
  const result = await sahara.saharaUpload(link, await sahara.awaitHello(link, 1000, "hello"), new Blob([loader]), { progress() {}, note: (line) => notes.push(line) });
  assert.equal(result.paddedBytes, 100);
  assert.match(notes.join(" "), /100 byte\(s\) past the end/);
  assert.equal(device.loaderAccepted, true);
});

test("a device that asks far past the end of the loader is told the file is incomplete", async () => {
  const loader = loaderImage(6000);
  const device = fakeEdlDevice({ loader, loaderOverread: 100_000 });
  const { link } = linkTo(device);
  await assert.rejects(sahara.saharaUpload(link, await sahara.awaitHello(link, 1000, "hello"), new Blob([loader]), { progress() {}, note() {} }), /beyond the end of the loader file/);
});

test("bytes that are not Sahara are reported as such rather than interpreted", async () => {
  const device = fakeEdlDevice({ mode: "firehose" });
  const { link } = linkTo(device);
  await assert.rejects(sahara.readSaharaPacket(link, 500, "probe"), /not a Sahara packet/);
});

test("Sahara packets with absurd sizes are refused and 64-bit read requests are decoded", async () => {
  const device = fakeEdlDevice();
  const { link } = linkTo(device);
  await sahara.awaitHello(link, 1000, "hello");
  // Inject packets the way a device would send them.
  const scripted = { reads: [] };
  const push = (bytes) => scripted.reads.push(Uint8Array.from(bytes));
  const transport = { kind: "usb", async read() { return scripted.reads.shift() ?? null; }, async write() {} };
  const scriptedLink = new EdlLink(transport, new AbortController().signal);
  const wide = Buffer.alloc(32);
  wide.writeUInt32LE(0x12, 0);
  wide.writeUInt32LE(32, 4);
  wide.writeBigUInt64LE(13n, 8);
  wide.writeBigUInt64LE(4096n, 16);
  wide.writeBigUInt64LE(512n, 24);
  push(wide);
  assert.deepEqual(await sahara.readSaharaPacket(scriptedLink, 100, "wide"), { kind: "read-data", imageId: 13, offset: 4096, length: 512 });
  const huge = Buffer.alloc(32);
  huge.writeUInt32LE(0x12, 0);
  huge.writeUInt32LE(32, 4);
  huge.writeBigUInt64LE(0xffffffffffffffffn, 16);
  push(huge);
  await assert.rejects(sahara.readSaharaPacket(scriptedLink, 100, "huge"), /far outside any real image/);
  const long = Buffer.alloc(16);
  long.writeUInt32LE(0x04, 0);
  long.writeUInt32LE(0x7fffffff, 4);
  push(long);
  await assert.rejects(sahara.readSaharaPacket(scriptedLink, 100, "long"), /not a Sahara packet/);
});

// ---- Firehose XML ------------------------------------------------------------

test("Firehose documents are parsed with entities decoded, several documents in a row, and control characters made harmless", () => {
  const text = '<?xml version="1.0" encoding="UTF-8" ?>\n<data>\n<log value="INFO: {&quot;a&quot;: 1} &lt;ok&gt; &#65;&#x42; \u001b[31mred" />\n<response value=\'ACK\' rawmode="true"/></data>';
  const document = xml.parseFirehoseDocument(text);
  assert.deepEqual(document.logs, ['INFO: {"a": 1} <ok> AB \uFFFD[31mred']);
  assert.deepEqual(document.responses, [{ value: "ACK", rawmode: "true" }]);
  assert.equal(document.strayText, false);
  const both = encoder.encode('<data><log value="one" /></data><?xml version="1.0" ?><data><response value="ACK" /></data>');
  const first = xml.scanFirehoseFrame(both);
  assert.equal(first.kind, "document");
  assert.deepEqual(first.document.logs, ["one"]);
  const second = xml.scanFirehoseFrame(both.subarray(first.end));
  assert.deepEqual(second.document.responses, [{ value: "ACK" }]);
});

test("hostile Firehose XML is refused, each in its own way, never expanded or truncated", () => {
  const reject = (text, pattern) => assert.throws(() => xml.parseFirehoseDocument(text), (error) => error instanceof EdlError && pattern.test(error.message), text.slice(0, 60));
  reject('<!DOCTYPE data [<!ENTITY a "aaaa">]><data><log value="&a;" /></data>', /DOCTYPE, entity and CDATA/);
  reject('<data><log value="&lol9;" /></data>', /not one of the five predefined/);
  reject('<data><log value="&#0;" /></data>', /not a legal XML character/);
  reject('<data><log value="&#xD800;" /></data>', /not a legal XML character/);
  reject('<data><log value="&amp" /></data>', /not terminated/);
  reject('<data><![CDATA[x]]></data>', /DOCTYPE, entity and CDATA/);
  reject('<data><log value="a<b" /></data>', /raw '<'/);
  reject('<data><log value="open /></data>', /not terminated/);
  reject('<data><log value=unquoted /></data>', /not quoted/);
  reject('<data><log value="a" value="b" /></data>', /repeats the attribute/);
  reject(`<data><log ${Array.from({ length: 33 }, (_, index) => `a${index}="1"`).join(" ")} /></data>`, /more than 32 attributes/);
  reject(`<data>${"<log value=\"x\" />".repeat(513)}</data>`, /more than 512 elements/);
  reject(`${"<a>".repeat(9)}${"</a>".repeat(9)}`, /nested too deeply/);
  reject(`<data><${"n".repeat(65)} /></data>`, /tag name is too long/);
  reject(`<data><log value="${"v".repeat(16 * 1024 + 1)}" /></data>`, /longer than 16384/);
  reject("<data><log value=\"x\" /></data></data>", /does not close/);
  reject("<data><log value=\"x\" /></dataa>", /does not close/);
  reject("<data><log value=\"x\" />", /never closed/);
  reject("plain text", /no elements/);
});

test("a Firehose frame is found only when complete, junk is bounded, and the answer after raw data may not be preceded by junk", () => {
  assert.deepEqual(xml.scanFirehoseFrame(encoder.encode('<data><log value="x" />')), { kind: "incomplete" });
  assert.deepEqual(xml.scanFirehoseFrame(new Uint8Array(0)), { kind: "incomplete" });
  assert.equal(xml.scanFirehoseFrame(Buffer.concat([Buffer.alloc(10, 0x20), Buffer.from('<data><log value="x" /></data>')])).kind, "document", "a few stray bytes before a document are tolerated");
  assert.throws(() => xml.scanFirehoseFrame(Buffer.alloc(100, 0x41)), /bytes of something else/);
  assert.throws(() => xml.scanFirehoseFrame(encoder.encode(`${" ".repeat(70)}<data></data>`)), /bytes of something else/);
  // Strict: right after raw data.
  assert.equal(xml.scanFirehoseFrame(encoder.encode('\n<data><response value="ACK" /></data>'), true).kind, "document");
  assert.throws(() => xml.scanFirehoseFrame(encoder.encode('X<data><response value="ACK" /></data>'), true), /misaligned/);
  assert.throws(() => xml.scanFirehoseFrame(encoder.encode(`${" ".repeat(9)}<data><response value="ACK" /></data>`), true), /misaligned/);
  // Size limits: no document ever grows without bound.
  assert.throws(() => xml.scanFirehoseFrame(encoder.encode(`<data><log value="${"a".repeat(300 * 1024)}`)), /longer than 262144 bytes without ending/);
  assert.throws(() => xml.scanFirehoseFrame(encoder.encode(`<data><log value="${"a".repeat(300 * 1024)}" /></data>`)), /longer than 262144 bytes/);
});

test("device text is cleaned before it is shown or stored", () => {
  assert.equal(xml.cleanDeviceText("a\u001b[2Jb\u0000c\u007fd\n\te"), "a\uFFFD[2Jb\uFFFDc\uFFFDd\n\te");
  assert.equal(xml.cleanDeviceText("x".repeat(5000), 100).length, "x".repeat(100).length + " …[cut]".length);
});

// ---- The read-only guarantee -----------------------------------------------

test("the five commands Cody sends serialize to exactly the documents the guard accepts", () => {
  const commands = [
    [{ kind: "nop" }, '<?xml version="1.0" ?><data><nop /></data>'],
    [{ kind: "configure", maxPayloadToTarget: 1048576, zlpAware: true, skipStorageInit: false }, '<?xml version="1.0" ?><data><configure MemoryName="eMMC" Verbose="0" AlwaysValidate="0" MaxDigestTableSizeInBytes="2048" MaxPayloadSizeToTargetInBytes="1048576" ZLPAwareHost="1" SkipStorageInit="0" SkipWrite="0" /></data>'],
    [{ kind: "getstorageinfo" }, '<?xml version="1.0" ?><data><getstorageinfo physical_partition_number="0" /></data>'],
    [{ kind: "read", sectorSize: 512, startSector: 34, sectors: 128 }, '<?xml version="1.0" ?><data><read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="128" physical_partition_number="0" start_sector="34" /></data>'],
    [{ kind: "power-reset" }, '<?xml version="1.0" ?><data><power value="reset" /></data>'],
  ];
  for (const [command, expected] of commands) {
    const text = firehose.serializeFirehoseCommand(command);
    assert.equal(text, expected);
    firehose.assertReadOnlyFirehoseXml(text);
  }
});

test("every Firehose command that can change the device is refused before it can reach the wire", () => {
  const forbidden = [
    '<program SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" filename="x.bin" />',
    '<erase SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" />',
    '<patch SECTOR_SIZE_IN_BYTES="512" byte_offset="0" filename="DISK" physical_partition_number="0" size_in_bytes="4" start_sector="1" value="0" what="x" />',
    '<setbootablestoragedrive value="1" />',
    '<firmwarewrite SECTOR_SIZE_IN_BYTES="512" />',
    '<poke address64="0x1000" size_in_bytes="4" value="0" />',
    '<peek address64="0x1000" size_in_bytes="4" />',
    '<benchmark TriggerWatchdog="0" />',
    '<getsha256digest SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" />',
    '<memcpy destaddress="0" sourceaddress="1" size="4" />',
    '<writeIMEI len="16" />',
    '<ufs commit="1" />',
    '<power value="off" />',
    '<power value="edl" />',
    '<power value="reset_to_edl" />',
    '<power value="reset" delay_in_seconds="0" />',
    '<nop value="ping" />',
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="1" start_sector="0" />',
    '<read SECTOR_SIZE_IN_BYTES="1024" num_partition_sectors="1" physical_partition_number="0" start_sector="0" />',
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" filename="x" />',
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="0" physical_partition_number="0" start_sector="0" />',
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" />',
    '<getstorageinfo physical_partition_number="1" />',
    '<configure MemoryName="UFS" Verbose="0" AlwaysValidate="0" MaxDigestTableSizeInBytes="2048" MaxPayloadSizeToTargetInBytes="1048576" ZLPAwareHost="1" SkipStorageInit="0" SkipWrite="0" />',
    '<configure MemoryName="eMMC" Verbose="0" AlwaysValidate="0" MaxDigestTableSizeInBytes="2048" MaxPayloadSizeToTargetInBytes="1048576" ZLPAwareHost="1" SkipStorageInit="0" SkipWrite="1" />',
    '<READ SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" />',
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0"><erase /></read>',
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" /><erase />',
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" /><read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="1" />',
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" /><!-- erase -->',
    "<nop />text",
    "",
  ];
  for (const body of forbidden) {
    assert.throws(() => firehose.assertReadOnlyFirehoseXml(`<?xml version="1.0" ?><data>${body}</data>`), (error) => error instanceof EdlError && error.kind === "refused", body);
  }
  // Document-level tricks.
  const read = '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" start_sector="0" />';
  for (const text of [
    `<data>${read}</data><data><erase /></data>`,
    `<?xml version="1.0" ?><?xml version="1.0" ?><data>${read}</data>`,
    `<data attr="1">${read}</data>`,
    `<other>${read}</other>`,
    `<data>${read}</data>${" ".repeat(2000)}`,
    `<data>\n${read}\n</data>trailing`,
    read,
    "",
  ]) {
    assert.throws(() => firehose.assertReadOnlyFirehoseXml(text), (error) => error instanceof EdlError && error.kind === "refused", text.slice(0, 80));
  }
});

test("the Firehose command builders take numbers only, so no text can be smuggled into an attribute", () => {
  const read = (overrides) => () => firehose.serializeFirehoseCommand({ kind: "read", sectorSize: 512, startSector: 0, sectors: 1, ...overrides });
  for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1" erase="1', "1", null, undefined]) {
    assert.throws(read({ startSector: bad }), (error) => error instanceof EdlError && error.kind === "refused", String(bad));
    assert.throws(read({ sectors: bad }), (error) => error instanceof EdlError && error.kind === "refused", String(bad));
  }
  assert.throws(read({ sectorSize: 1024 }), /SECTOR_SIZE_IN_BYTES/);
  assert.throws(read({ sectors: 0 }), /num_partition_sectors/);
  assert.throws(() => firehose.serializeFirehoseCommand({ kind: "configure", maxPayloadToTarget: 12, zlpAware: true, skipStorageInit: false }), /MaxPayloadSizeToTargetInBytes/);
});

// ---- GPT -------------------------------------------------------------------

function tableOf(disk, sectors) {
  const header = gpt.parseGptHeader(disk.subarray(SECTOR, 2 * SECTOR), SECTOR);
  const count = gpt.gptEntrySectors(header, SECTOR);
  const table = gpt.parseGptEntries(header, disk.subarray(header.entriesLba * SECTOR, (header.entriesLba + count) * SECTOR), SECTOR);
  // The backup table is judged where the disk really ends, not where the primary header says it is.
  const tailLba = sectors - 1;
  const alternate = disk.subarray(tailLba * SECTOR, (tailLba + 1) * SECTOR);
  let backup = { header: null, table: null, problem: "no backup header" };
  try {
    const backupHeader = gpt.parseGptHeader(alternate, SECTOR);
    backup = { header: backupHeader, table: gpt.parseGptEntries(backupHeader, disk.subarray(backupHeader.entriesLba * SECTOR, (backupHeader.entriesLba + count) * SECTOR), SECTOR), problem: null };
  } catch (error) {
    backup = { header: null, table: null, problem: error.message };
  }
  return { header, table, backup };
}

test("a real-looking GPT is read: names, ranges, checksums, and the span agrees with a disk of that size", () => {
  const { disk, table } = buildDisk({ sectors: 2048, partitions: [{ name: "boot_a", sectors: 64 }, { name: "system_a", sectors: 300 }, { name: "userdata", sectors: 500 }] });
  const parsed = tableOf(disk, 2048);
  assert.equal(parsed.header.headerCrcValid, true);
  assert.equal(parsed.table.entriesCrcValid, true);
  assert.deepEqual(parsed.table.warnings, []);
  assert.equal(parsed.header.myLba, 1);
  assert.equal(parsed.header.alternateLba, 2047);
  assert.deepEqual(parsed.table.partitions.map((p) => [p.name, p.firstLba, p.lastLba, p.sectors, p.bytes]), table.map((p) => [p.name, p.first, p.last, p.sectors, p.sectors * SECTOR]));
  assert.equal(parsed.table.partitions[0].typeGuid, "0FC63DAF-8483-4772-8E79-3D69D8477DE4");
  assert.equal(parsed.header.diskGuid, "12345678-ABCD-4321-9876-0123456789AB");
  const report = gpt.evaluateSpan(2048, SECTOR, parsed.table, { lastSectorReadable: true, backup: parsed.backup });
  assert.equal(report.ok, true, report.reasons.join("; "));
  assert.equal(report.gptSpanSectors, 2048);
  assert.equal(report.checks.length, 9);
});

test("the span check fails, with numbers, for every way the table and the disk can disagree", () => {
  const build = (extra, sectors = 2048) => buildDisk({ sectors, partitions: [{ name: "boot", sectors: 64 }], ...extra });
  // The disk is bigger than the table says (a 2048-sector table on a 4096-sector chip).
  const small = build({}, 2048);
  const parsed = tableOf(small.disk, 2048);
  const bigger = gpt.evaluateSpan(4096, SECTOR, parsed.table, { lastSectorReadable: true, backup: parsed.backup });
  assert.equal(bigger.ok, false);
  assert.match(bigger.reasons.join(" "), /spans 2048 sectors.*reports 4096.*2048 sector\(s\)/s);
  assert.match(bigger.reasons.join(" "), /not in the last sector \(4095\)/);
  // The disk is smaller than the table says.
  const smaller = gpt.evaluateSpan(1000, SECTOR, parsed.table, { lastSectorReadable: false, backup: parsed.backup });
  assert.equal(smaller.ok, false);
  assert.match(smaller.reasons.join(" "), /could not be read/);
  // The backup header is damaged.
  const damaged = build({ badBackup: true });
  const damagedParsed = tableOf(damaged.disk, 2048);
  const noBackup = gpt.evaluateSpan(2048, SECTOR, damagedParsed.table, { lastSectorReadable: true, backup: damagedParsed.backup });
  assert.equal(noBackup.ok, false);
  assert.match(noBackup.reasons.join(" "), /signature/);
  // A GPT that claims more than the disk has: the backup header is not there at all.
  const lying = build({ gptSectors: 5000 }, 2048);
  const lyingParsed = tableOf(lying.disk, 2048);
  const lie = gpt.evaluateSpan(2048, SECTOR, lyingParsed.table, { lastSectorReadable: true, backup: { header: null, table: null, problem: null } });
  assert.equal(lie.ok, false);
  assert.match(lie.reasons.join(" "), /spans 5000 sectors.*reports 2048/s);
});

test("the span check also fails when the table's own ranges do not fit the disk, however well its checksums and backup agree", () => {
  const evaluate = (disk) => {
    const parsed = tableOf(disk, 2048);
    return gpt.evaluateSpan(2048, SECTOR, parsed.table, { lastSectorReadable: true, backup: parsed.backup });
  };
  const good = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 64 }, { name: "data", sectors: 500 }] }).disk;
  assert.equal(evaluate(good).ok, true);

  // An entry that runs through sector 3000 on a 2048-sector disk; both tables are intact and both point at sector 2047.
  const overrun = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 64 }, { name: "overrun", first: 200, sectors: 2801 }] }).disk;
  const parsedOverrun = tableOf(overrun, 2048);
  assert.equal(parsedOverrun.header.headerCrcValid && parsedOverrun.table.entriesCrcValid && parsedOverrun.header.alternateLba === 2047, true, "the table looks intact");
  const overrunReport = evaluate(overrun);
  assert.equal(overrunReport.ok, false);
  assert.match(overrunReport.reasons.join(" "), /"overrun" \(sectors 200-3000\) .*outside the usable range \(sectors 34-2014\)/s);
  assert.equal(overrunReport.checks.find((check) => check.name === "partitions")?.passed, false);

  // Inside the disk but past the usable range the table declares.
  const pastUsable = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 64 }, { name: "late", first: 1990, sectors: 40 }] }).disk;
  assert.match(evaluate(pastUsable).reasons.join(" "), /"late" \(sectors 1990-2029\) .*outside the usable range/s);

  // A usable range that ends beyond the disk, in both headers.
  const widened = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 64 }] }).disk;
  for (const lba of [1, 2047]) patchGptHeader(widened, lba, (header) => header.writeBigUInt64LE(3000n, 48));
  const widenedReport = evaluate(widened);
  assert.equal(widenedReport.ok, false);
  assert.match(widenedReport.reasons.join(" "), /usable range \(sectors 34-3000\) does not fit the 2048-sector disk/);

  // A usable range that starts inside the primary entry array.
  const crowded = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 64 }] }).disk;
  for (const lba of [1, 2047]) patchGptHeader(crowded, lba, (header) => header.writeBigUInt64LE(10n, 40));
  const crowdedReport = evaluate(crowded);
  assert.equal(crowdedReport.ok, false);
  assert.match(crowdedReport.reasons.join(" "), /primary entry array \(sectors 2-33\) runs into the usable range, which starts at sector 10/);
  assert.equal(crowdedReport.checks.find((check) => check.name === "entry arrays")?.passed, false);

  // A usable range that is back to front.
  const reversed = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 64 }] }).disk;
  for (const lba of [1, 2047]) patchGptHeader(reversed, lba, (header) => { header.writeBigUInt64LE(2000n, 40); header.writeBigUInt64LE(100n, 48); });
  assert.match(evaluate(reversed).reasons.join(" "), /usable range \(sectors 2000-100\) does not fit/);
});

test("the backup table is judged in the last sector of the disk, and a primary header that points anywhere else fails on its own", () => {
  const partitions = [{ name: "boot", sectors: 64 }, { name: "data", sectors: 500 }];
  const evaluate = (disk) => {
    const parsed = tableOf(disk, 2048);
    return gpt.evaluateSpan(2048, SECTOR, parsed.table, { lastSectorReadable: true, backup: parsed.backup });
  };
  const check = (report, name) => report.checks.find((entry) => entry.name === name);
  for (const [pointer, interior] of [[5000, false], [1999, true], [1, false]]) {
    const report = evaluate(movePrimaryBackupPointer(buildDisk({ sectors: 2048, partitions }).disk, pointer, { interiorCopy: interior }));
    const label = `pointer ${pointer}${interior ? " with an older copy there" : ""}`;
    assert.equal(report.ok, false, label);
    assert.equal(check(report, "backup header").passed, true, `${label}: the real backup, in the last sector, is valid`);
    assert.match(check(report, "backup header").detail, /sits in the last sector \(2047\)/, label);
    assert.equal(check(report, "backup matches primary").passed, true, label);
    assert.equal(check(report, "span").passed, false, label);
    assert.equal(check(report, "backup at the end").passed, false, label);
    assert.match(check(report, "backup at the end").detail, new RegExp(`puts the backup at sector ${pointer}, not in the last sector \\(2047\\)`), label);
  }
  // And a damaged tail is damaged even when the primary header's pointer is right.
  const damagedTail = buildDisk({ sectors: 2048, partitions, badBackup: true }).disk;
  const damaged = evaluate(damagedTail);
  assert.equal(check(damaged, "backup header").passed, false);
  assert.equal(check(damaged, "backup at the end").passed, true);
});

test("a damaged primary table is reported as damaged", () => {
  const { disk } = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 64 }], badPrimaryCrc: true });
  const parsed = tableOf(disk, 2048);
  assert.equal(parsed.header.headerCrcValid, false);
  assert.match(parsed.table.warnings.join(" "), /header's CRC/);
  const report = gpt.evaluateSpan(2048, SECTOR, parsed.table, { lastSectorReadable: true, backup: parsed.backup });
  assert.equal(report.ok, false);
  assert.match(report.reasons.join(" "), /primary partition table is not intact/);
});

test("a partition table from a hostile device cannot make Cody read or allocate without bound", () => {
  const sector = (patch) => {
    const { disk } = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 64 }] });
    const header = Buffer.from(disk.subarray(SECTOR, 2 * SECTOR));
    patch(header);
    return header;
  };
  assert.throws(() => gpt.gptEntrySectors(gpt.parseGptHeader(sector((h) => h.writeUInt32LE(1_000_000, 80)), SECTOR), SECTOR), /declares 1000000 entries/);
  assert.throws(() => gpt.gptEntrySectors(gpt.parseGptHeader(sector((h) => h.writeUInt32LE(100, 84)), SECTOR), SECTOR), /128 bytes times a power of two/);
  assert.throws(() => gpt.gptEntrySectors(gpt.parseGptHeader(sector((h) => { h.writeUInt32LE(1024, 80); h.writeUInt32LE(1024, 84); }), SECTOR), SECTOR), /bytes of entries/);
  assert.throws(() => gpt.parseGptHeader(sector((h) => h.writeBigUInt64LE(0xffffffffffffffffn, 32)), SECTOR), /far beyond any real disk/);
  assert.throws(() => gpt.parseGptHeader(sector((h) => h.writeUInt32LE(40, 12)), SECTOR), /claims a size of 40/);
  assert.throws(() => gpt.parseGptHeader(sector((h) => h.fill(0, 0, 8)), SECTOR), /no GPT signature/);
  assert.throws(() => gpt.parseGptHeader(Buffer.alloc(80), SECTOR), /only 80 bytes/);
  assert.throws(() => gpt.parseGptHeader(Buffer.alloc(1024), 1024), /not one Cody reads/);
  const shifted = Buffer.concat([Buffer.alloc(3), sector(() => {})]).subarray(0, 512);
  assert.throws(() => gpt.parseGptHeader(shifted, SECTOR), /3 byte\(s\) into the sector.*offset/);
});

test("partition names are exact, UTF-16, and a name two entries share cannot be used to pick either", () => {
  const { disk } = buildDisk({ sectors: 2048, partitions: [{ name: "boot", sectors: 8 }, { name: "tëst-日本", sectors: 8 }, { name: "boot", sectors: 8 }, { name: "over", sectors: 8, first: 45 }] });
  const parsed = tableOf(disk, 2048);
  assert.equal(gpt.findPartitions(parsed.table, "tëst-日本").length, 1);
  assert.equal(gpt.findPartitions(parsed.table, "boot").length, 2);
  assert.equal(gpt.findPartitions(parsed.table, "BOOT").length, 0, "no case folding");
  assert.match(parsed.table.warnings.join(" "), /Two entries are both named "boot"/);
  assert.match(parsed.table.warnings.join(" "), /overlap/);
});

// ---- Firehose session ------------------------------------------------------

test("a programmer is greeted, configured and asked for its storage; the partition table sector reads back exactly", async () => {
  const device = fakeEdlDevice();
  const { session } = await loaded(device);
  assert.equal(session.chipSerial, "0x1a2b3c4d");
  assert.ok(session.supportedFunctions.includes("read"));
  const configuration = await session.configure();
  assert.equal(configuration.memoryName, "eMMC");
  assert.equal(configuration.targetName, "8953");
  assert.equal(configuration.negotiatedPayloadToTarget, 1048576);
  const storage = await session.storageInfo();
  assert.equal(storage.sectorSize, 512);
  assert.equal(storage.totalSectors, 4096);
  assert.equal(storage.productName, "HBG4a2");
  assert.equal(storage.memoryType, "eMMC");
  const sector = await collect(session.readSectors(1, 1, SECTOR));
  assert.ok(sector.equals(device.disk.subarray(SECTOR, 2 * SECTOR)));
  assert.equal(sector.subarray(0, 8).toString("latin1"), "EFI PART");
  assert.deepEqual(device.commands.map((c) => c.tag), ["nop", "configure", "getstorageinfo", "read"]);
  assert.deepEqual(device.forbidden, []);
});

test("raw sector data is exact however the device chops it up, pads its answers, or runs transfers together", async () => {
  const variants = [
    ["defaults", {}],
    ["no zero-length packets: transfers of whole packets run into the next message", { zlp: false }],
    ["a newline after every document", { padding: "\n" }],
    ["a CR LF and spaces after every document", { padding: "\r\n  " }],
    ["the answer and the first data in one transfer", { coalesceRaw: true }],
    ["one transfer per 4096 bytes without zero-length packets", { rawChunk: 4096, zlp: false }],
    ["odd transfer sizes", { rawChunk: 512 * 3 + 100 }],
    ["huge transfers", { rawChunk: 1 << 20, zlp: false }],
  ];
  for (const [name, options] of variants) {
    const device = fakeEdlDevice({ disk: buildDisk({ sectors: 4096, partitions: [{ name: "a", sectors: 2000 }] }).disk, ...options });
    const { session } = await loaded(device);
    await session.configure();
    const data = await collect(session.readSectors(34, 1500, SECTOR));
    assert.equal(sha256(data), sha256(device.disk.subarray(34 * SECTOR, 1534 * SECTOR)), name);
    const again = await collect(session.readSectors(1600, 7, SECTOR));
    assert.equal(sha256(again), sha256(device.disk.subarray(1600 * SECTOR, 1607 * SECTOR)), `${name}: a second read on the same session`);
  }
});

test("a read longer than one segment is several reads, each ending in the programmer's own ACK", async () => {
  const sectors = (firehose.FIREHOSE_SEGMENT_BYTES / SECTOR) * 2 + 5;
  const device = fakeEdlDevice({ disk: Buffer.alloc(sectors * SECTOR, 7), rawChunk: 1 << 20 });
  const { session } = await loaded(device);
  await session.configure();
  const data = await collect(session.readSectors(0, sectors, SECTOR));
  assert.equal(data.length, sectors * SECTOR);
  const reads = device.commands.filter((c) => c.tag === "read");
  assert.deepEqual(reads.map((c) => Number(c.attributes.num_partition_sectors)), [32768, 32768, 5]);
  assert.deepEqual(reads.map((c) => Number(c.attributes.start_sector)), [0, 32768, 65536]);
});

test("a programmer that supports smaller payloads is asked again with its own figure, once", async () => {
  const device = fakeEdlDevice({ configureNakFirst: true });
  const { session } = await loaded(device);
  const configuration = await session.configure();
  assert.equal(configuration.negotiatedPayloadToTarget, 65536);
  assert.deepEqual(device.commands.filter((c) => c.tag === "configure").map((c) => c.attributes.MaxPayloadSizeToTargetInBytes), ["1048576", "65536"]);
});

test("UFS storage is refused plainly instead of being read as if it were eMMC", async () => {
  const device = fakeEdlDevice({ memoryType: "UFS" });
  const { session } = await loaded(device);
  await assert.rejects(session.configure(), (error) => error instanceof EdlError && error.kind === "refused" && /eMMC/.test(error.message));
  assert.deepEqual(device.commands.filter((c) => c.tag === "read"), []);
});

test("a read before configure, and a read outside the device, are the programmer's refusal and are passed on", async () => {
  const device = fakeEdlDevice();
  const { session } = await loaded(device);
  await assert.rejects(collect(session.readSectors(0, 1, SECTOR)), (error) => error instanceof firehose.FirehoseRejection && /configure first/.test(error.message));
  await session.configure();
  await assert.rejects(collect(session.readSectors(4090, 100, SECTOR)), (error) => error instanceof firehose.FirehoseRejection && /outside the device/.test(error.message));
});

test("the storage report is checked: malformed, odd sector sizes and disagreeing sizes are refused", async () => {
  const report = (storage) => `INFO: ${JSON.stringify({ storage_info: storage })}`;
  const cases = [
    [`INFO: {"storage_info": {"total_blocks": `, /did not report storage/],
    [report({ total_blocks: 0, block_size: 512 }), /no usable total_blocks/],
    [report({ total_blocks: "4096", block_size: 512 }), /no usable total_blocks/],
    [report({ total_blocks: 4096, block_size: 1024 }), /block size of 1024/],
    [report({ total_blocks: 4096, block_size: 4096, page_size: 512 }), /ambiguous/],
    [report({ total_blocks: 4096, block_size: 512, mem_type: "UFS" }), /UFS storage/],
  ];
  for (const [line, pattern] of cases) {
    const device = fakeEdlDevice({ storageInfoLine: line });
    const { session } = await loaded(device);
    await session.configure();
    await assert.rejects(session.storageInfo(), (error) => error instanceof EdlError && pattern.test(error.message), line);
  }
});

test("a programmer that floods, rambles, babbles or goes silent is contained", async () => {
  await withTimeouts({ command: 150, nop: 150, greeting: 100 }, async () => {
    const expectations = [
      ["spam", /kept talking/],
      ["oversize", /longer than 262144 bytes/],
      ["garbage", /bytes of something else|not XML|Expected Firehose XML/],
      ["silent", /timed out/],
      ["nak", /refused getstorageinfo.*Failed to open the SDCC Device/s],
    ];
    for (const [fault, pattern] of expectations) {
      const device = fakeEdlDevice({ infoFault: fault });
      const { session, link } = await loaded(device);
      await session.configure();
      await assert.rejects(session.storageInfo(), (error) => error instanceof EdlError && pattern.test(error.message), fault);
      assert.ok(link.bytesReceived < 3 * 1024 * 1024, `${fault}: bounded reading`);
    }
  });
});

test("raw data that does not end exactly where the programmer promised is reported as misaligned, and a stalled read as a timeout", async () => {
  await withTimeouts({ dataInactivity: 150, command: 200 }, async () => {
    const extra = fakeEdlDevice({ readFault: { extra: 3 } });
    const first = await loaded(extra);
    await first.session.configure();
    await assert.rejects(collect(first.session.readSectors(34, 8, SECTOR)), /did not follow the sector data directly.*misaligned/s);

    const stalled = fakeEdlDevice({ readFault: { stallAfter: 1000 } });
    const second = await loaded(stalled);
    await second.session.configure();
    const chunks = [];
    await assert.rejects(
      (async () => { for await (const chunk of second.session.readSectors(34, 8, SECTOR)) chunks.push(chunk); })(),
      (error) => error instanceof EdlError && error.kind === "timeout" && /24[0-9]+ byte\(s\) still to come|3096 byte\(s\) still to come/.test(error.message),
    );
    assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), 1000);
  });
});

test("a read that comes up short, with the programmer's closing answer taking the missing bytes' place, is refused however short it is", async () => {
  await withTimeouts({ dataInactivity: 150, command: 150 }, async () => {
    // The closing answer is 92 bytes. Short by 39 the data stream swallows exactly its XML declaration and what is left is a
    // well-formed answer; the other shortfalls end in misalignment, malformed XML or a stall. None may end as a good read.
    for (const short of [1, 8, 38, 39, 40, 45, 46, 91, 92, 100]) {
      const device = fakeEdlDevice({ readFault: { truncate: short } });
      const { session } = await loaded(device);
      await session.configure();
      const seen = [];
      await assert.rejects(
        (async () => { for await (const chunk of session.readSectors(34, 8, SECTOR)) seen.push(chunk); })(),
        (error) => error instanceof EdlError,
        `${short} byte(s) short`,
      );
    }
    const device = fakeEdlDevice({ readFault: { truncate: 39 } });
    const { session } = await loaded(device);
    await session.configure();
    await assert.rejects(collect(session.readSectors(34, 8, SECTOR)), (error) => error instanceof EdlError && /closing answer began inside the sector data.*39 byte\(s\) short/s.test(error.message));
  });
});

test("sector data that merely looks like the start of an answer is still data: the check needs the answer itself to run into it", async () => {
  const declaration = '<?xml version="1.0" encoding="UTF-8" ?>';
  const answer = '<?xml version="1.0" encoding="UTF-8" ?><data><response value="ACK" rawmode="false" /></data>';
  for (const [name, text] of [
    ["the declaration the answer starts with", declaration],
    ["a whole answer", answer],
    ["an opening <data> tag", "<data>"],
    ["the beginning of a response element", '<data><response value="ACK" '],
  ]) {
    const disk = buildDisk({ sectors: 4096, partitions: [{ name: "a", sectors: 2000 }] }).disk;
    disk.write(text, 42 * SECTOR - text.length, "latin1");
    const device = fakeEdlDevice({ disk });
    const { session } = await loaded(device);
    await session.configure();
    const data = await collect(session.readSectors(34, 8, SECTOR));
    assert.equal(sha256(data), sha256(disk.subarray(34 * SECTOR, 42 * SECTOR)), `${name}: the read is exact`);
  }
});

test("a device that leaves the bus in the middle of a read ends the read with an error and the bytes before it", async () => {
  const device = fakeEdlDevice({ readFault: { leaveAfter: 2000 } });
  const { session } = await loaded(device);
  await session.configure();
  const seen = [];
  await assert.rejects((async () => { for await (const chunk of session.readSectors(34, 8, SECTOR)) seen.push(chunk.length); })(), /disconnected/);
  assert.equal(seen.reduce((sum, length) => sum + length, 0), 2000);
});

test("cancelling a read stops it at once and sends no further command", async () => {
  const device = fakeEdlDevice({ readFault: { stallAfter: 1000 } });
  const { session, controller } = await loaded(device);
  await session.configure();
  const before = device.commands.length;
  const pending = (async () => { for await (const chunk of session.readSectors(34, 8, SECTOR)) void chunk; })();
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(device.commands.length, before + 1, "only the read that was asked for");
});

test("the link hands out exactly what was asked even when the device sends more at once", async () => {
  const scripted = [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), Uint8Array.from([11, 12])];
  const transport = { kind: "usb", async read() { return scripted.shift() ?? null; }, async write() {} };
  const link = new EdlLink(transport, new AbortController().signal);
  assert.deepEqual([...await link.read(4, 50, "first")], [1, 2, 3, 4]);
  assert.equal(link.buffered, 6);
  assert.deepEqual([...await link.read(8, 50, "second")], [5, 6, 7, 8, 9, 10, 11, 12]);
  await assert.rejects(link.read(1, 30, "third"), (error) => error instanceof EdlError && error.kind === "timeout");
  assert.equal(link.bytesReceived, 12);
});

test("empty packets are not data, and a flood of them is not waited on forever", async () => {
  const transport = { kind: "usb", async read() { return new Uint8Array(0); }, async write() {} };
  const link = new EdlLink(transport, new AbortController().signal);
  await assert.rejects(link.read(1, 5_000, "empty"), /nothing but empty packets/);
});

test("clearing what a device had in flight gives up on a flood of empty packets, and on a device that never goes quiet", async () => {
  // The scripted device ends its flood on its own, far past any sensible limit, so a drain without a bound would return normally.
  let empties = 0;
  const flood = { kind: "usb", async read() { empties += 1; return empties <= 200_000 ? new Uint8Array(0) : null; }, async write() {} };
  await assert.rejects(new EdlLink(flood, new AbortController().signal).drain(150, 16 * 1024 * 1024), (error) => error instanceof EdlError && /empty packets and never goes quiet/.test(error.message));
  assert.ok(empties < 20_000, `it gave up after ${empties} empty packets`);

  // A device that dribbles a byte at a time is below the byte limit for ever: only the clock ends it.
  await withTimeouts({ drain: 150 }, async () => {
    let ticks = 0;
    const dribble = { kind: "usb", async read() { await new Promise((resolve) => setTimeout(resolve, 2)); ticks += 1; return ticks <= 600 ? Uint8Array.of(1) : null; }, async write() {} };
    const started = Date.now();
    await assert.rejects(new EdlLink(dribble, new AbortController().signal).drain(150, 1024 ** 3), (error) => error instanceof EdlError && error.kind === "timeout" && /still sending after 150 ms.*never goes quiet/s.test(error.message));
    assert.ok(Date.now() - started < 900, "it did not wait for the device to finish");
    assert.ok(ticks < 600);
  });

  // Ordinary recovery is unchanged: data that stops is drained and counted.
  let chunks = 3;
  const ordinary = { kind: "usb", async read() { chunks -= 1; return chunks >= 0 ? new Uint8Array(100) : null; }, async write() {} };
  assert.equal(await new EdlLink(ordinary, new AbortController().signal).drain(50, 1024), 300);
});
