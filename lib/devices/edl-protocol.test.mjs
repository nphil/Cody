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

// ---- What reaches the wire: reads freely, writes only inside a grant -----------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refusedError = (error) => error instanceof EdlError && error.kind === "refused";
const wrapCommand = (body) => `<?xml version="1.0" ?><data>${body}</data>`;
const sectorCommand = (tag, start, count, extra = "") => `<${tag} SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="${count}" physical_partition_number="0" start_sector="${start}"${extra} />`;
const aRisk = { action: "edl test", target: "t", backup: "none" };
const approving = (log = []) => ({ signal: new AbortController().signal, async confirm(risk) { log.push(risk); } });
const grantFor = (ranges, extra = {}) => firehose.grantWrites(approving(), aRisk, { label: "test", sectorSize: 512, kinds: ["program", "erase"], ranges, ...extra });

test("the commands Cody sends serialize to exactly the documents the guard accepts: reads freely, writes under a grant", async () => {
  const reads = [
    [{ kind: "nop" }, '<?xml version="1.0" ?><data><nop /></data>'],
    [{ kind: "configure", maxPayloadToTarget: 1048576, zlpAware: true, skipStorageInit: false }, '<?xml version="1.0" ?><data><configure MemoryName="eMMC" Verbose="0" AlwaysValidate="0" MaxDigestTableSizeInBytes="2048" MaxPayloadSizeToTargetInBytes="1048576" ZLPAwareHost="1" SkipStorageInit="0" SkipWrite="0" /></data>'],
    [{ kind: "getstorageinfo" }, '<?xml version="1.0" ?><data><getstorageinfo physical_partition_number="0" /></data>'],
    [{ kind: "read", sectorSize: 512, startSector: 34, sectors: 128 }, '<?xml version="1.0" ?><data><read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="128" physical_partition_number="0" start_sector="34" /></data>'],
    [{ kind: "power-reset" }, '<?xml version="1.0" ?><data><power value="reset" /></data>'],
  ];
  for (const [command, expected] of reads) {
    const text = firehose.serializeFirehoseCommand(command);
    assert.equal(text, expected);
    firehose.assertFirehoseXml(text);
  }
  const grant = await grantFor([{ startSector: 34, sectors: 128 }], { kinds: ["program", "erase", "set-bootable"], drive: 1 });
  const writes = [
    [{ kind: "program", sectorSize: 512, startSector: 34, sectors: 128 }, '<?xml version="1.0" ?><data><program SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="128" physical_partition_number="0" start_sector="34" /></data>'],
    [{ kind: "erase", sectorSize: 512, startSector: 34, sectors: 128 }, '<?xml version="1.0" ?><data><erase SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="128" physical_partition_number="0" start_sector="34" /></data>'],
    [{ kind: "set-bootable", drive: 1 }, '<?xml version="1.0" ?><data><setbootablestoragedrive value="1" /></data>'],
  ];
  for (const [command, expected] of writes) {
    const text = firehose.serializeFirehoseCommand(command);
    assert.equal(text, expected);
    assert.throws(() => firehose.assertFirehoseXml(text), refusedError, `without a grant: ${text}`);
    firehose.assertFirehoseXml(text, grant);
  }
});

test("every Firehose command Cody never sends is refused before it can reach the wire, even under a grant that covers the whole disk", async () => {
  const wide = await grantFor([{ startSector: 0, sectors: 2 ** 33 }], { kinds: ["program", "erase", "set-bootable"], drive: 1 });
  const never = [
    '<patch SECTOR_SIZE_IN_BYTES="512" byte_offset="0" filename="DISK" physical_partition_number="0" size_in_bytes="4" start_sector="1" value="0" what="x" />',
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
    // Reads outside their form.
    sectorCommand("read", 0, 1).replace('physical_partition_number="0"', 'physical_partition_number="1"'),
    sectorCommand("read", 0, 1).replace('"512"', '"1024"'),
    sectorCommand("read", 0, 1, ' filename="x"'),
    sectorCommand("read", 0, 0),
    '<read SECTOR_SIZE_IN_BYTES="512" num_partition_sectors="1" physical_partition_number="0" />',
    '<getstorageinfo physical_partition_number="1" />',
    '<configure MemoryName="UFS" Verbose="0" AlwaysValidate="0" MaxDigestTableSizeInBytes="2048" MaxPayloadSizeToTargetInBytes="1048576" ZLPAwareHost="1" SkipStorageInit="0" SkipWrite="0" />',
    '<configure MemoryName="eMMC" Verbose="0" AlwaysValidate="0" MaxDigestTableSizeInBytes="2048" MaxPayloadSizeToTargetInBytes="1048576" ZLPAwareHost="1" SkipStorageInit="0" SkipWrite="1" />',
    sectorCommand("read", 0, 1).toUpperCase(),
    // Writes outside their form: another physical partition (the eMMC boot areas and RPMB are 1 to 3), another sector size,
    // a file name, an empty or missing range.
    ...[1, 2, 3, 4, 8].flatMap((lun) => ["program", "erase"].map((tag) => sectorCommand(tag, 0, 1).replace('physical_partition_number="0"', `physical_partition_number="${lun}"`))),
    ...["program", "erase"].flatMap((tag) => [
      sectorCommand(tag, 0, 1).replace('"512"', '"1024"'),
      sectorCommand(tag, 0, 1, ' filename="x.bin"'),
      sectorCommand(tag, 0, 1, ' label="boot"'),
      sectorCommand(tag, 0, 0),
      sectorCommand(tag, -1, 1),
      sectorCommand(tag, 0, 1).replace(' start_sector="0"', ""),
      sectorCommand(tag, "0x10", 1),
      sectorCommand(tag, 0, 1).toUpperCase(),
    ]),
    '<setbootablestoragedrive value="8" />',
    '<setbootablestoragedrive value="" />',
    '<setbootablestoragedrive value="1" other="2" />',
    '<setbootablestoragedrive />',
    // Shapes that hide a second command.
    `${sectorCommand("read", 0, 1).replace(" />", ">")}<erase /></read>`,
    `${sectorCommand("read", 0, 1)}<erase />`,
    `${sectorCommand("read", 0, 1)}${sectorCommand("read", 1, 1)}`,
    `${sectorCommand("program", 0, 1)}${sectorCommand("program", 1, 1)}`,
    `${sectorCommand("program", 0, 1)}<!-- erase -->`,
    "<nop />text",
    "",
  ];
  for (const body of never) {
    for (const grant of [undefined, wide]) {
      assert.throws(() => firehose.assertFirehoseXml(wrapCommand(body), grant), refusedError, `${grant ? "with a grant" : "without one"}: ${body}`);
    }
  }
  // Document-level tricks.
  const read = sectorCommand("read", 0, 1);
  const program = sectorCommand("program", 0, 1);
  for (const text of [
    `<data>${read}</data><data><erase /></data>`,
    `<data>${program}</data><data>${program}</data>`,
    `<?xml version="1.0" ?><?xml version="1.0" ?><data>${program}</data>`,
    `<data attr="1">${program}</data>`,
    `<other>${program}</other>`,
    `<data>${program}</data>${" ".repeat(2000)}`,
    `<data>\n${program}\n</data>trailing`,
    program,
    "",
  ]) {
    for (const grant of [undefined, wide]) assert.throws(() => firehose.assertFirehoseXml(text, grant), refusedError, text.slice(0, 80));
  }
});

test("program, erase and setbootablestoragedrive go out only inside exactly what the user approved", async () => {
  // 100-149 and 150-159 are adjacent and become one approved range; 300-319 is separate.
  const grant = await grantFor([{ startSector: 150, sectors: 10 }, { startSector: 100, sectors: 50 }, { startSector: 300, sectors: 20 }]);
  assert.deepEqual(grant.ranges.map((range) => [range.startSector, range.sectors]), [[100, 60], [300, 20]], "sorted, and adjacent ranges merged");
  const ok = (tag, start, count) => firehose.assertFirehoseXml(wrapCommand(sectorCommand(tag, start, count)), grant);
  const no = (tag, start, count, why) => assert.throws(() => firehose.assertFirehoseXml(wrapCommand(sectorCommand(tag, start, count)), grant), (error) => refusedError(error) && /outside the sectors the user approved \(100-159, 300-319\)/.test(error.message), `${tag} ${start}+${count}: ${why}`);
  for (const tag of ["program", "erase"]) {
    ok(tag, 100, 60);
    ok(tag, 100, 1);
    ok(tag, 159, 1);
    ok(tag, 120, 40);
    ok(tag, 300, 20);
    ok(tag, 319, 1);
    no(tag, 99, 1, "one sector before");
    no(tag, 99, 2, "straddles the start");
    no(tag, 100, 61, "one sector past the first range");
    no(tag, 159, 2, "straddles the end");
    no(tag, 160, 1, "just after");
    no(tag, 150, 160, "spans the gap");
    no(tag, 300, 21, "one past the second range");
    no(tag, 0, 1, "sector zero");
    no(tag, 2 ** 33, 1, "far away");
  }
  // What kind of write was approved matters too.
  const onlyProgram = await grantFor([{ startSector: 0, sectors: 100 }], { kinds: ["program"] });
  firehose.assertFirehoseXml(wrapCommand(sectorCommand("program", 0, 10)), onlyProgram);
  assert.throws(() => firehose.assertFirehoseXml(wrapCommand(sectorCommand("erase", 0, 10)), onlyProgram), (error) => refusedError(error) && /not among what the user approved/.test(error.message));
  assert.throws(() => firehose.assertFirehoseXml(wrapCommand('<setbootablestoragedrive value="1" />'), onlyProgram), refusedError);
  // A 512-byte approval does not cover 4096-byte sectors.
  assert.throws(() => firehose.assertFirehoseXml(wrapCommand(sectorCommand("program", 0, 10).replace('"512"', '"4096"')), onlyProgram), (error) => refusedError(error) && /approved write is in 512-byte sectors/.test(error.message));
  // Setting the bootable drive: only the drive that was approved.
  const bootable = await firehose.grantWrites(approving(), aRisk, { label: "boot", sectorSize: 512, kinds: ["set-bootable"], drive: 2 });
  firehose.assertFirehoseXml(wrapCommand('<setbootablestoragedrive value="2" />'), bootable);
  assert.throws(() => firehose.assertFirehoseXml(wrapCommand('<setbootablestoragedrive value="1" />'), bootable), (error) => refusedError(error) && /not what the user approved/.test(error.message));
  assert.throws(() => firehose.assertFirehoseXml(wrapCommand(sectorCommand("program", 0, 1)), bootable), refusedError, "approving a boot drive approves no sector writes");
});

test("a write grant cannot be forged, widened, reused or kept after the operation", async () => {
  const grant = await grantFor([{ startSector: 0, sectors: 10 }]);
  const program = wrapCommand(sectorCommand("program", 0, 10));
  const outside = wrapCommand(sectorCommand("program", 0, 11));
  firehose.assertFirehoseXml(program, grant);
  // A look-alike object is not a grant.
  const forged = { label: "x", sectorSize: 512, ranges: [{ startSector: 0, sectors: 2 ** 33 }], active: true, revoke() {} };
  assert.throws(() => firehose.assertFirehoseXml(program, forged), (error) => refusedError(error) && /no write grant covers it/.test(error.message));
  // Changing what a real grant shows changes nothing it allows.
  assert.throws(() => { grant.ranges[0].sectors = 2 ** 33; }, TypeError, "the range list is frozen");
  assert.throws(() => { grant.ranges.push({ startSector: 0, sectors: 2 ** 33 }); }, TypeError);
  const copy = Object.create(grant);
  assert.throws(() => firehose.assertFirehoseXml(program, copy), refusedError, "a copy of the object is not the grant");
  assert.throws(() => firehose.assertFirehoseXml(outside, grant), refusedError);
  // Once the operation ends the grant is dead.
  assert.equal(grant.active, true);
  grant.revoke();
  assert.equal(grant.active, false);
  assert.throws(() => firehose.assertFirehoseXml(program, grant), (error) => refusedError(error) && /grant it needs has ended/.test(error.message));
});

test("a write grant exists only after the user approved, with the exact ranges in what they were shown", async () => {
  const log = [];
  let approve;
  const slow = { signal: new AbortController().signal, confirm: (risk) => { log.push(risk); return new Promise((resolve) => { approve = resolve; }); } };
  let issued;
  const pending = firehose.grantWrites(slow, { ...aRisk, sha256: "a".repeat(64), protectedOverride: "write:sbl1", details: "Flash it." }, { label: "flash sbl1", sectorSize: 512, kinds: ["program"], ranges: [{ startSector: 100, sectors: 60 }, { startSector: 300, sectors: 20 }] }).then((grant) => { issued = grant; });
  await sleep(20);
  assert.equal(issued, undefined, "nothing is granted while the user is still deciding");
  assert.equal(log.length, 1);
  approve();
  await pending;
  assert.ok(issued);
  const [risk] = log;
  assert.equal(risk.action, "edl test");
  assert.equal(risk.sha256, "a".repeat(64));
  assert.equal(risk.protectedOverride, "write:sbl1");
  assert.match(risk.details, /^Flash it\./);
  assert.match(risk.details, /Write grant for flash sbl1: Cody may write only sectors 100-159, 300-319 of the eMMC user area \(physical partition 0; 80 sectors of 512 bytes in all\)/);

  // A decline (or a cancel) means no grant: the confirmation's own rejection comes out and nothing is issued.
  const declined = { signal: new AbortController().signal, async confirm() { throw new DOMException("Operation cancelled.", "AbortError"); } };
  await assert.rejects(firehose.grantWrites(declined, aRisk, { label: "x", sectorSize: 512, kinds: ["program"], ranges: [{ startSector: 0, sectors: 1 }] }), (error) => error.name === "AbortError");
  // Approved, but the operation was cancelled in the same moment: still no grant.
  const controller = new AbortController();
  const raced = { signal: controller.signal, async confirm() { controller.abort(); } };
  await assert.rejects(firehose.grantWrites(raced, aRisk, { label: "x", sectorSize: 512, kinds: ["program"], ranges: [{ startSector: 0, sectors: 1 }] }), (error) => error.name === "AbortError");
});

test("a malformed grant is refused before the user is asked anything", async () => {
  const asked = [];
  const context = approving(asked);
  const spec = { label: "x", sectorSize: 512, kinds: ["program"], ranges: [{ startSector: 0, sectors: 10 }] };
  const bad = [
    { ...spec, kinds: [] },
    { ...spec, kinds: ["patch"] },
    { ...spec, sectorSize: 1024 },
    { ...spec, ranges: [] },
    { ...spec, ranges: undefined },
    { ...spec, ranges: [{ startSector: 0, sectors: 0 }] },
    { ...spec, ranges: [{ startSector: -1, sectors: 5 }] },
    { ...spec, ranges: [{ startSector: 0.5, sectors: 5 }] },
    { ...spec, ranges: [{ startSector: Number.NaN, sectors: 5 }] },
    { ...spec, ranges: [{ startSector: 0, sectors: 2 ** 41 }] },
    { ...spec, ranges: Array.from({ length: 4097 }, (_, index) => ({ startSector: index * 2, sectors: 1 })) },
    { ...spec, drive: 1 },
    { ...spec, kinds: ["set-bootable"], ranges: [{ startSector: 0, sectors: 1 }], drive: 1 },
    { ...spec, kinds: ["set-bootable"], ranges: [], drive: 8 },
    { ...spec, kinds: ["set-bootable"], ranges: [] },
  ];
  for (const candidate of bad) await assert.rejects(firehose.grantWrites(context, aRisk, candidate), refusedError, JSON.stringify(candidate).slice(0, 100));
  assert.equal(asked.length, 0, "nobody was asked to approve any of them");
});

test("the Firehose command builders take numbers only, so no text can be smuggled into an attribute", () => {
  for (const kind of ["read", "program", "erase"]) {
    const build = (overrides) => () => firehose.serializeFirehoseCommand({ kind, sectorSize: 512, startSector: 0, sectors: 1, ...overrides });
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1" erase="1', "1", null, undefined]) {
      assert.throws(build({ startSector: bad }), (error) => refusedError(error), `${kind}: ${String(bad)}`);
      assert.throws(build({ sectors: bad }), (error) => refusedError(error), `${kind}: ${String(bad)}`);
    }
    assert.throws(build({ sectorSize: 1024 }), /SECTOR_SIZE_IN_BYTES/);
    assert.throws(build({ sectors: 0 }), /num_partition_sectors/);
  }
  for (const bad of [1.5, -1, 8, Number.NaN, "1", '1" x="2', null, undefined]) {
    assert.throws(() => firehose.serializeFirehoseCommand({ kind: "set-bootable", drive: bad }), refusedError, String(bad));
  }
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

// ---- Writing through a session -------------------------------------------------------------------------------

const bigDisk = () => buildDisk({ sectors: 8192, partitions: [{ name: "a", sectors: 6000 }] }).disk;
const pattern = (sectors, seed = 1) => {
  const out = Buffer.alloc(sectors * SECTOR);
  for (let index = 0; index < out.length; index += 1) out[index] = (index * 7 + seed) & 0xff;
  return out;
};
const sourceOf = (bytes) => ({ async read(offset, length) { return bytes.subarray(offset, offset + length); } });
const writtenRanges = (device) => device.writes.filter((entry) => entry.tag === "program").map((entry) => [Number(entry.attributes.start_sector), Number(entry.attributes.num_partition_sectors)]);

test("blocks are programmed one at a time inside the grant, each ended by a zero-length packet, and the disk holds exactly the data", async () => {
  const device = fakeEdlDevice({ disk: bigDisk(), rawChunk: 4096, strictZlp: true });
  const before = Buffer.from(device.disk);
  const { session } = await loaded(device);
  await session.configure();
  const data = pattern(5000);
  const grant = await grantFor([{ startSector: 100, sectors: 5000 }]);
  const seen = [];
  await session.writeSectors(grant, 100, 5000, SECTOR, sourceOf(data), {
    beforeBlock: (done, count) => seen.push(["before", done, count]),
    afterBlock: (done, count) => seen.push(["after", done, count]),
  });
  assert.deepEqual(writtenRanges(device), [[100, 2048], [2148, 2048], [4196, 904]], "blocks of at most the agreed payload (1 MiB)");
  assert.deepEqual(seen, [["before", 0, 2048], ["after", 0, 2048], ["before", 2048, 2048], ["after", 2048, 2048], ["before", 4096, 904], ["after", 4096, 904]]);
  assert.ok(device.disk.subarray(100 * SECTOR, 5100 * SECTOR).equals(data), "every byte, in order");
  assert.ok(device.disk.subarray(0, 100 * SECTOR).equals(before.subarray(0, 100 * SECTOR)), "nothing before the range changed");
  assert.ok(device.disk.subarray(5100 * SECTOR).equals(before.subarray(5100 * SECTOR)), "nothing after it changed");
  assert.ok(device.zeroLengthPackets >= 3, "the programmer that waits for the end of a transfer got one per block");
  assert.equal(device.awaitingRawData, false);
  assert.deepEqual(device.forbidden, []);
  assert.ok(device.commands.every((entry) => !["program", "erase"].includes(entry.tag) || Number(entry.attributes.physical_partition_number) === 0), "only the user area was addressed");
});

test("a write, an erase or a boot-drive change outside the grant is refused on the host: the programmer is never sent it", async () => {
  const device = fakeEdlDevice({ disk: bigDisk() });
  const { session } = await loaded(device);
  await session.configure();
  const grant = await grantFor([{ startSector: 100, sectors: 50 }], { kinds: ["program"] });
  const sent = device.commands.length;
  await assert.rejects(session.writeSectors(grant, 90, 20, SECTOR, sourceOf(pattern(20))), refusedError, "starts before the range");
  await assert.rejects(session.writeSectors(grant, 140, 20, SECTOR, sourceOf(pattern(20))), refusedError, "ends after it");
  await assert.rejects(session.eraseSectors(grant, 100, 50, SECTOR), (error) => refusedError(error) && /not among what the user approved/.test(error.message), "an erase was not approved");
  await assert.rejects(session.setBootableDrive(grant, 1), refusedError, "neither was a boot drive");
  assert.equal(device.commands.length, sent, "none of them reached the programmer");
  assert.deepEqual(device.writes, []);
  grant.revoke();
  await assert.rejects(session.writeSectors(grant, 100, 10, SECTOR, sourceOf(pattern(10))), (error) => refusedError(error) && /grant it needs has ended/.test(error.message));
  assert.equal(device.commands.length, sent);
});

test("an erase covers its range in commands of at most 32 MiB, and what it leaves behind is whatever the programmer's erase leaves", async () => {
  for (const [fill, byte] of [["zero", 0x00], ["ff", 0xff]]) {
    const sectors = (32 * 1024 * 1024) / SECTOR + 10;
    const device = fakeEdlDevice({ disk: Buffer.alloc((sectors + 200) * SECTOR, 0x77), eraseFill: fill });
    const { session } = await loaded(device);
    await session.configure();
    const grant = await grantFor([{ startSector: 100, sectors }], { kinds: ["erase"] });
    const seen = [];
    await session.eraseSectors(grant, 100, sectors, SECTOR, { beforeBlock: (done, count) => seen.push([done, count]), afterBlock() {} });
    assert.deepEqual(seen, [[0, (32 * 1024 * 1024) / SECTOR], [(32 * 1024 * 1024) / SECTOR, 10]], fill);
    assert.deepEqual(device.writes.map((entry) => [entry.tag, Number(entry.attributes.start_sector), Number(entry.attributes.num_partition_sectors)]), [["erase", 100, (32 * 1024 * 1024) / SECTOR], ["erase", 100 + (32 * 1024 * 1024) / SECTOR, 10]], fill);
    assert.ok(device.disk.subarray(100 * SECTOR, (100 + sectors) * SECTOR).every((value) => value === byte), fill);
    assert.ok(device.disk.subarray(0, 100 * SECTOR).every((value) => value === 0x77) && device.disk.subarray((100 + sectors) * SECTOR).every((value) => value === 0x77), `${fill}: nothing around it changed`);
  }
});

test("the boot drive is set only to the number that was approved, and the programmer's refusal is passed on", async () => {
  const device = fakeEdlDevice();
  const { session } = await loaded(device);
  await session.configure();
  const grant = await firehose.grantWrites(approving(), aRisk, { label: "boot", sectorSize: 512, kinds: ["set-bootable"], drive: 1 });
  await session.setBootableDrive(grant, 1);
  assert.equal(device.bootableDrive, 1);
  await assert.rejects(session.setBootableDrive(grant, 2), refusedError);
  assert.equal(device.bootableDrive, 1, "the other number never left the host");
  const refusing = fakeEdlDevice({ setBootableFault: "nak" });
  const second = await loaded(refusing);
  await second.session.configure();
  const again = await firehose.grantWrites(approving(), aRisk, { label: "boot", sectorSize: 512, kinds: ["set-bootable"], drive: 1 });
  await assert.rejects(second.session.setBootableDrive(again, 1), (error) => error instanceof firehose.FirehoseRejection && /Failed to set the bootable storage drive/.test(error.message));
});

test("a block the programmer refuses, up front or after its data, stops the write with its words and leaves it idle", async () => {
  for (const [name, fault, programmed] of [["up front", { nakAt: 2 }, 2048], ["after the data", { nakAfterData: 2 }, 2048]]) {
    const device = fakeEdlDevice({ disk: bigDisk(), writeFault: fault });
    const before = Buffer.from(device.disk);
    const { session } = await loaded(device);
    await session.configure();
    const data = pattern(5000);
    const grant = await grantFor([{ startSector: 100, sectors: 5000 }]);
    await assert.rejects(session.writeSectors(grant, 100, 5000, SECTOR, sourceOf(data)), (error) => error instanceof firehose.FirehoseRejection && /Failed to write to the device|Write verification failed/.test(error.message), name);
    assert.equal(device.sectorsProgrammed, programmed, `${name}: only the first block was stored`);
    assert.ok(device.disk.subarray(100 * SECTOR, 2148 * SECTOR).equals(data.subarray(0, 2048 * SECTOR)), name);
    assert.ok(device.disk.subarray(2148 * SECTOR).equals(before.subarray(2148 * SECTOR)), `${name}: nothing after the first block changed`);
    assert.equal(device.awaitingRawData, false, `${name}: the programmer is not left waiting for data`);
    // The session is still good: it can read.
    const sector = await collect(session.readSectors(100, 1, SECTOR));
    assert.ok(sector.equals(data.subarray(0, SECTOR)), name);
  }
});

test("a device that leaves the bus part-way through a block ends the write with an error, and the disk holds exactly the sectors it had stored", async () => {
  const device = fakeEdlDevice({ disk: bigDisk(), writeFault: { dieAfterSectors: 3000 } });
  const before = Buffer.from(device.disk);
  const { session } = await loaded(device);
  await session.configure();
  const data = pattern(5000);
  const grant = await grantFor([{ startSector: 100, sectors: 5000 }]);
  await assert.rejects(session.writeSectors(grant, 100, 5000, SECTOR, sourceOf(data)), (error) => error.name === "NotFoundError" || error instanceof EdlError);
  assert.equal(device.onBus, false);
  assert.equal(device.sectorsProgrammed, 3000);
  assert.ok(device.disk.subarray(100 * SECTOR, 3100 * SECTOR).equals(data.subarray(0, 3000 * SECTOR)), "the stored part is exactly the start of the data");
  assert.ok(device.disk.subarray(3100 * SECTOR).equals(before.subarray(3100 * SECTOR)), "and nothing past it");
});

test("stopping between blocks leaves the programmer idle and usable; a block cut in two leaves it waiting for data that never comes", async () => {
  const device = fakeEdlDevice({ disk: bigDisk() });
  const { session } = await loaded(device);
  await session.configure();
  const data = pattern(5000);
  const grant = await grantFor([{ startSector: 100, sectors: 5000 }]);
  const stop = new DOMException("Operation cancelled.", "AbortError");
  await assert.rejects(session.writeSectors(grant, 100, 5000, SECTOR, sourceOf(data), { beforeBlock: (done) => { if (done > 0) throw stop; }, afterBlock() {} }), (error) => error === stop);
  assert.equal(device.sectorsProgrammed, 2048, "the block before the stop was written whole");
  assert.equal(device.awaitingRawData, false, "the programmer is idle between blocks");
  assert.ok((await collect(session.readSectors(100, 2048, SECTOR))).equals(data.subarray(0, 2048 * SECTOR)), "and answers the next command");

  // A block that stalls half-way: the programmer keeps waiting for its data and takes the next command for that data.
  await withTimeouts({ writeAck: 150, firstAnswer: 150 }, async () => {
    const stuck = fakeEdlDevice({ disk: bigDisk(), writeFault: { stallAfterBytes: 1000 } });
    const second = await loaded(stuck);
    await second.session.configure();
    const again = await grantFor([{ startSector: 0, sectors: 100 }]);
    await assert.rejects(second.session.writeSectors(again, 0, 10, SECTOR, sourceOf(pattern(10))), (error) => error instanceof EdlError && error.kind === "timeout");
    assert.equal(stuck.awaitingRawData, true, "the programmer is still in raw mode");
    await assert.rejects(collect(second.session.readSectors(0, 1, SECTOR)), (error) => error instanceof EdlError && error.kind === "timeout", "its next command is never answered");
  });
});

test("a programmer that refuses to start a block is not sent any data", async () => {
  const device = fakeEdlDevice({ disk: bigDisk(), writeFault: { nakAt: 1 } });
  const { session, link } = await loaded(device);
  await session.configure();
  const grant = await grantFor([{ startSector: 0, sectors: 100 }]);
  const sentBefore = link.bytesSent;
  await assert.rejects(session.writeSectors(grant, 0, 10, SECTOR, sourceOf(pattern(10))), (error) => error instanceof firehose.FirehoseRejection);
  assert.ok(link.bytesSent - sentBefore < 1024, "only the command went out, not 5 KiB of data");
  assert.equal(device.zeroLengthPackets, 0);
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

// ---- the programmer's own messages taken for sector data -----------------------------------------------------------------

const programmerDoc = (text) => encoder.encode(`<?xml version="1.0" encoding="UTF-8" ?><data><log value="${text}" /></data>`);
const patterned = (length, seed = 1) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff);
const joinBytes = (...parts) => Uint8Array.from(parts.flatMap((part) => [...part]));

test("the raw-data watch reports a stretch between two ends of the device's transfers that is nothing but its own documents, and nothing else", () => {
  const found = (chunks) => {
    const watch = new xml.RawMessageWatch();
    let seen = null;
    chunks.forEach(([bytes, ends = []], index) => {
      seen ??= watch.feed(bytes, ends, index === chunks.length - 1);
    });
    return seen;
  };
  const message = programmerDoc("INFO: hello");
  const data = patterned(300);
  // All the data there is, whether or not anything marks where it ends.
  assert.deepEqual(found([[message]]), { at: 0, length: message.length });
  // After data that the end of a transfer closed: in the same chunk, in the next one, and when the end was only noticed later
  // as the zero-length packet that follows the chunk before (it arrives as offset 0).
  assert.deepEqual(found([[joinBytes(data, message), [300]]]), { at: 300, length: message.length });
  assert.deepEqual(found([[data, [300]], [message]]), { at: 300, length: message.length });
  assert.deepEqual(found([[data], [message, [0]]]), { at: 300, length: message.length });
  // In the middle of the data, with more data after it.
  assert.deepEqual(found([[joinBytes(data, message, patterned(200, 7)), [300, 300 + message.length]]]), { at: 300, length: message.length });
  // However the bytes were chunked on the way in, even a byte at a time.
  const bytewise = [...joinBytes(patterned(40), message)].map((value) => [Uint8Array.of(value), []]);
  bytewise[39][1] = [1];
  assert.deepEqual(found(bytewise), { at: 40, length: message.length });
  // Several documents with padding and NULs between and after them.
  const several = joinBytes(message, [0x0a], programmerDoc("INFO: more"), [0x00, 0x00]);
  assert.deepEqual(found([[several]]), { at: 0, length: several.length });
  // Longer than the 1 KiB tail that is kept for the closing answer, and longer than a packet or a read request.
  const long = programmerDoc("x".repeat(5000));
  assert.deepEqual(found([[joinBytes(patterned(100), long), [100]]]), { at: 100, length: long.length });
  // Close to the 256 KiB a document may be (one attribute may hold 16 KiB, so it is made of many log elements), arriving as four reads.
  const huge = encoder.encode(`<?xml version="1.0" encoding="UTF-8" ?><data>${Array.from({ length: 14 }, () => `<log value="${"z".repeat(16000)}" />`).join("")}</data>`);
  assert.ok(huge.length > 200 * 1024 && huge.length < xml.FIREHOSE_XML_LIMITS.documentBytes);
  assert.deepEqual(found([[patterned(10), [10]], ...Array.from({ length: Math.ceil(huge.length / 65536) }, (_, index) => [huge.subarray(index * 65536, Math.min(huge.length, (index + 1) * 65536))])]), { at: 10, length: huge.length });

  // Not messages: the document is only part of its transfer, or is followed by more, or is not the programmer's kind.
  assert.equal(found([[joinBytes(data, message)]]), null, "a whole document at the end of a transfer of data is data");
  assert.equal(found([[joinBytes(message, patterned(100))]]), null, "so is one at the start of it");
  assert.equal(found([[joinBytes(patterned(10), message, patterned(10)), [10 + message.length]]]), null, "and one in the middle of it");
  assert.equal(found([[encoder.encode('<?xml version="1.0" ?><data><getstorageinfo /></data>')]]), null, "a command the programmer never sends");
  assert.equal(found([[encoder.encode('<?xml version="1.0" ?><data><log value="x" /></data>trailing')]]), null);
  assert.equal(found([[patterned(2000)]]), null);
  assert.equal(found([[new Uint8Array(512)]]), null, "erased flash is not a message");
  assert.equal(found([[programmerDoc("y".repeat(3 * 1024 * 1024))]]), null, "a stretch longer than 2 MiB is not examined");
});

test("a message of the programmer's own that arrives as a transfer of its own while data is owed is refused wherever it sits, however long it is and however the transfers are framed", async () => {
  const framings = [
    ["every transfer ended by a short or zero-length packet", {}],
    ["messages padded with a newline", { padding: "\n" }],
    ["data in 4096-byte transfers", { rawChunk: 4096 }],
    ["data in odd-sized transfers", { rawChunk: 512 * 3 + 100 }],
  ];
  let reads = 0;
  for (const [name, options] of framings) {
    for (const sectors of [1, 2, 8, 129]) {
      const owed = sectors * SECTOR;
      const disk = buildDisk({ sectors: 2048, partitions: [{ name: "a", sectors }] }).disk;
      for (const textLength of [0, 40, 444, 900, 1400, 4000, 70000]) {
        const wire = 68 + textLength + (options.padding?.length ?? 0);
        if (wire > owed) continue;
        for (const swallowAt of new Set([0, Math.floor((owed - wire) / 2), owed - wire])) {
          const device = fakeEdlDevice({ disk, ...options, readFault: { swallowLog: "x".repeat(textLength), swallowAt } });
          const { session } = await loaded(device);
          await session.configure();
          await assert.rejects(
            collect(session.readSectors(34, sectors, SECTOR)),
            (error) => error instanceof EdlError && new RegExp(`${wire} byte\\(s\\) of the sector data, starting at byte ${swallowAt} of ${owed}, are a complete message from the programmer`).test(error.message),
            `${name}: a ${wire}-byte message at byte ${swallowAt} of ${sectors} sector(s)`,
          );
          reads += 1;
        }
      }
    }
  }
  assert.ok(reads > 150, `${reads} reads were checked`);
});

test("a programmer that sends no zero-length packets still gives itself away wherever a short packet marks its message, and a message that is all the data always does", async () => {
  for (const sectors of [1, 2, 8]) {
    const owed = sectors * SECTOR;
    const disk = buildDisk({ sectors: 2048, partitions: [{ name: "a", sectors }] }).disk;
    for (const textLength of [0, 40, 444, 900, 1400, 3000]) {
      const wire = 68 + textLength;
      if (wire > owed) continue;
      for (const swallowAt of new Set([0, Math.floor((owed - wire) / 2), owed - wire])) {
        // Without a zero-length packet only a transfer that is not a multiple of the packet size has a visible end.
        const startSeen = swallowAt === 0 || swallowAt % SECTOR !== 0;
        const endSeen = swallowAt + wire === owed || wire % SECTOR !== 0;
        if (!(startSeen && endSeen)) continue;
        for (const options of [{ zlp: false }, { zlp: false, coalesceRaw: true }]) {
          const device = fakeEdlDevice({ disk, ...options, readFault: { swallowLog: "x".repeat(textLength), swallowAt } });
          const { session } = await loaded(device);
          await session.configure();
          await assert.rejects(collect(session.readSectors(34, sectors, SECTOR)), (error) => error instanceof EdlError && /are a complete message from the programmer/.test(error.message), `${JSON.stringify(options)}: ${wire} bytes at ${swallowAt} of ${owed}`);
        }
      }
    }
  }
  // All the data there is: nothing about the framing has to be seen.
  for (const options of [{}, { zlp: false }, { coalesceRaw: true }, { coalesceRaw: true, zlp: false }]) {
    const disk = buildDisk({ sectors: 2048, partitions: [{ name: "a", sectors: 2 }] }).disk;
    const device = fakeEdlDevice({ disk, ...options, readFault: { swallowLog: "x".repeat(1024 - 68), swallowAt: 0 } });
    const { session } = await loaded(device);
    await session.configure();
    await assert.rejects(collect(session.readSectors(34, 2, SECTOR)), (error) => error instanceof EdlError && /1024 byte\(s\) of the sector data, starting at byte 0 of 1024, are a complete message/.test(error.message), JSON.stringify(options));
  }
});

test("disk text that looks like the programmer's own is still data when it is only part of a transfer, wherever it sits", async () => {
  const message = '<?xml version="1.0" encoding="UTF-8" ?><data><log value="INFO: on the disk" /></data>';
  for (const [name, place] of [["the start of a transfer", 0], ["the middle", 1000], ["across the end of one transfer and the start of the next", 65536 - 40], ["the very end", 66048 - message.length]]) {
    for (const options of [{}, { zlp: false }, { coalesceRaw: true }]) {
      const disk = buildDisk({ sectors: 4096, partitions: [{ name: "a", sectors: 129 }] }).disk;
      disk.write(message, 34 * SECTOR + place, "latin1");
      const device = fakeEdlDevice({ disk, ...options });
      const { session } = await loaded(device);
      await session.configure();
      const read = await collect(session.readSectors(34, 129, SECTOR));
      assert.equal(sha256(read), sha256(disk.subarray(34 * SECTOR, 163 * SECTOR)), `${name} ${JSON.stringify(options)}`);
    }
  }
});
