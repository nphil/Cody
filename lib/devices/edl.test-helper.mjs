import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * A Qualcomm device in emergency download mode, at the bulk-transfer boundary:
 * the boot ROM's Sahara state machine, and once a loader is accepted the
 * Firehose programmer's XML command loop over a real byte image of an eMMC
 * user area. Cody's real EDL layer talks to it, so what is on the wire (and
 * what the "device" ends up holding) is observable.
 *
 * The device-to-host side is modelled packet by packet. A device transfer is cut
 * into 512-byte packets; a host bulk-IN request of N bytes completes when it has
 * N bytes or a short packet (a zero-length one counts), whichever comes first.
 * So a message that is a multiple of 512 bytes with no zero-length packet runs
 * into the NEXT message, a request smaller than a full packet is a babble error,
 * and the host cannot rely on one read being one message - which is exactly what
 * the real thing does to a careless host.
 *
 * Nothing in the Firehose loop is restricted: a `program`, `erase`, `patch` or
 * any other command the host sends is recorded in `forbidden` AND carried out
 * on the disk image, so a host that ever sends one cannot hide it.
 */

export const SECTOR = 512;
const PACKET = 512;
const IMAGE_ID = 13;

const gone = () => new DOMException("The device was disconnected.", "NotFoundError");
const aborted = () => Object.assign(new Error("The device read was cancelled."), { name: "AbortError" });

/** Bytes whose every sector starts with its own sector number, so a shifted or misplaced read cannot pass for the right one. */
export function fillSectors(buffer, firstSector, seed) {
  for (let offset = 0; offset + SECTOR <= buffer.length; offset += SECTOR) {
    const sector = firstSector + offset / SECTOR;
    buffer.writeBigUInt64LE(BigInt(sector), offset);
    for (let index = 8; index < SECTOR; index += 1) buffer[offset + index] = (index * 7 + sector * 13 + seed + (index >> 3)) & 0xff;
  }
  return buffer;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const guidBytes = (text) => {
  const hex = text.replace(/-/g, "");
  const out = Buffer.alloc(16);
  out.writeUInt32LE(Number.parseInt(hex.slice(0, 8), 16), 0);
  out.writeUInt16LE(Number.parseInt(hex.slice(8, 12), 16), 4);
  out.writeUInt16LE(Number.parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(out, 8);
  return out;
};

export const LINUX_DATA = "0FC63DAF-8483-4772-8E79-3D69D8477DE4";
export const DISK_GUID = "12345678-ABCD-4321-9876-0123456789AB";

/**
 * A disk image with a protective MBR, primary GPT, backup GPT at the end, and
 * the partitions' contents. `partitions` is `[{ name, sectors }]`, laid out one
 * after another from sector 34; the rest of the disk is filled too.
 * Options damage it on purpose: `gptSectors` (the sector count the GPT claims,
 * default the real one), `badBackup`, `badPrimaryCrc`, `entries`.
 */
export function buildDisk({ sectors, partitions, gptSectors = sectors, entries = 128, badBackup = false, badPrimaryCrc = false, seed = 5 }) {
  const disk = fillSectors(Buffer.alloc(sectors * SECTOR), 0, seed);
  const entrySectors = Math.ceil((entries * 128) / SECTOR);
  const firstUsable = 2 + entrySectors;
  const lastUsable = gptSectors - 1 - entrySectors - 1;
  const array = Buffer.alloc(entries * 128);
  const table = [];
  let next = firstUsable;
  partitions.forEach((partition, index) => {
    const entry = array.subarray(index * 128, (index + 1) * 128);
    guidBytes(LINUX_DATA).copy(entry, 0);
    guidBytes(`AAAAAAAA-0000-4000-8000-${String(index + 1).padStart(12, "0")}`).copy(entry, 16);
    const first = partition.first ?? next;
    const last = first + partition.sectors - 1;
    entry.writeBigUInt64LE(BigInt(first), 32);
    entry.writeBigUInt64LE(BigInt(last), 40);
    entry.write(partition.name, 56, "utf16le");
    next = last + 1;
    table.push({ name: partition.name, first, last, sectors: partition.sectors });
    fillSectors(disk.subarray(first * SECTOR, (last + 1) * SECTOR), first, seed + index + 1);
  });
  const header = (myLba, alternateLba, entriesLba) => {
    const sector = Buffer.alloc(SECTOR);
    sector.write("EFI PART", 0, "latin1");
    sector.writeUInt32LE(0x00010000, 8);
    sector.writeUInt32LE(92, 12);
    sector.writeBigUInt64LE(BigInt(myLba), 24);
    sector.writeBigUInt64LE(BigInt(alternateLba), 32);
    sector.writeBigUInt64LE(BigInt(firstUsable), 40);
    sector.writeBigUInt64LE(BigInt(lastUsable), 48);
    guidBytes(DISK_GUID).copy(sector, 56);
    sector.writeBigUInt64LE(BigInt(entriesLba), 72);
    sector.writeUInt32LE(entries, 80);
    sector.writeUInt32LE(128, 84);
    sector.writeUInt32LE(crc32(array), 88);
    sector.writeUInt32LE(crc32(sector.subarray(0, 92)), 16);
    return sector;
  };
  // Protective MBR.
  disk.fill(0, 0, SECTOR);
  disk[450] = 0xee;
  disk.writeUInt32LE(1, 454);
  disk.writeUInt32LE(Math.min(0xffffffff, sectors - 1), 458);
  disk[510] = 0x55;
  disk[511] = 0xaa;
  const primary = header(1, gptSectors - 1, 2);
  if (badPrimaryCrc) primary.writeUInt32LE(0xdeadbeef, 16);
  primary.copy(disk, SECTOR);
  array.copy(disk, 2 * SECTOR);
  const backupEntriesLba = gptSectors - 1 - entrySectors;
  if (backupEntriesLba + entrySectors < sectors) {
    array.copy(disk, backupEntriesLba * SECTOR);
    const backup = header(gptSectors - 1, 1, backupEntriesLba);
    if (badBackup) backup.fill(0, 0, 8);
    if (gptSectors - 1 < sectors) backup.copy(disk, (gptSectors - 1) * SECTOR);
  }
  return { disk, table, sectors };
}

/** A fake programmer image: starts like an ELF file, so it looks like the real thing to a quick glance. */
export function loaderImage(size = 6000, seed = 3) {
  const image = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) image[index] = (index * 11 + seed + (index >> 6)) & 0xff;
  image.write("\x7fELF", 0, "latin1");
  return image;
}

const xmlDoc = (body) => `<?xml version="1.0" encoding="UTF-8" ?><data>${body}</data>`;
const escapeAttr = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const logDoc = (line) => xmlDoc(`<log value="${escapeAttr(line)}" />`);

const FORBIDDEN_TAGS = ["program", "erase", "patch", "setbootablestoragedrive", "firmwarewrite", "poke", "peek", "benchmark", "getsha256digest", "getcrc16digest", "memcpy", "writeIMEI", "xml", "ufs"];

/**
 * @param {object} [options]
 * @param {"sahara"|"firehose"} [options.mode] Initial mode: the boot ROM waiting for a loader, or a programmer already running.
 */
export function fakeEdlDevice(options = {}) {
  const {
    mode: initialMode = "sahara",
    saharaVersion = 2,
    saharaMinVersion = 1,
    commandMode = true,
    resetStateMachine = true,
    /** After a switch back the ROM sends HELLO ("sends"), or says nothing and just waits for a HELLO_RSP ("silent"). */
    helloAfterSwitch = "sends",
    serial = 0x1a2b3c4d,
    hardwareId = "000460e100020000",
    pkHash = Buffer.from(createHash("sha256").update("oem root key").digest()),
    refuseExecute = [],
    loader = loaderImage(),
    loaderChunk = 4096,
    loaderOverread = 0,
    loaderStatus = 0x21,
    disk = buildDisk({ sectors: 4096, partitions: [{ name: "boot", sectors: 64 }, { name: "system", sectors: 256 }, { name: "userdata", sectors: 512 }] }).disk,
    totalBlocks = disk.length / SECTOR,
    blockSize = SECTOR,
    memoryType = "eMMC",
    zlp = true,
    padding = "",
    coalesceRaw = false,
    rawChunk = 65536,
    maxPayload = 1048576,
    configureNakFirst = false,
    nopAnswers = "response",
    greeting = true,
    /**
     * Read behaviour, counted in raw bytes: { nak, stallAfter, leaveAfter, extra, truncate, atRead } - `atRead`
     * is the 1-based number of the read command the fault starts at.
     */
    readFault = undefined,
    /** How `getstorageinfo` misbehaves: "spam", "oversize", "garbage", "silent" or "nak"; `storageInfoLine` replaces its report. */
    infoFault = undefined,
    spamLogs = 1000,
    storageInfoLine = undefined,
    onReset = () => {},
    productName = "HBG4a2",
  } = options;

  const store = Buffer.from(disk);
  const commands = [];
  const forbidden = [];
  const saharaLog = [];
  const waiters = new Set();
  const transfers = [];
  let pendingIn;
  let inboxBytes = Buffer.alloc(0);
  let onBus = true;
  let mode = initialMode;
  let state = "start";
  let loaderPlan = [];
  let planIndex = 0;
  let received = [];
  let expectRaw = 0;
  let readsDone = 0;
  let rawSent = 0;
  let requestedLength = 0;
  let configured = false;
  let resets = 0;
  let loaderAccepted = false;
  let uploadedLoader;

  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const push = (bytes, { shortPacket = zlp } = {}) => {
    const buffer = Buffer.from(bytes);
    transfers.push({ bytes: buffer, position: 0, zlp: shortPacket });
    wake();
  };
  const packet = (command, ...fields) => {
    const out = Buffer.alloc(8 + 4 * fields.length);
    out.writeUInt32LE(command, 0);
    out.writeUInt32LE(out.length, 4);
    fields.forEach((field, index) => out.writeUInt32LE(field >>> 0, 8 + 4 * index));
    return out;
  };
  const sayHello = (helloMode = 0) => push(packet(0x01, saharaVersion, saharaMinVersion, 0x400, helloMode, 0, 0, 0, 0, 0, 0));
  const endTransfer = (status, imageId = IMAGE_ID) => push(packet(0x04, imageId, status));
  const doc = (xml) => push(Buffer.from(xml + padding));
  const respond = (attributes) => doc(xmlDoc(`<response ${attributes} />`));

  /**
   * Gives the host's pending bulk-IN request what the pipe has for it: whole
   * packets until the request is full, then (if it is not) the short or
   * zero-length packet that ends a transfer. `done: false` means the request
   * is still waiting for more from the device.
   */
  const takeTransfer = (length, partial) => {
    for (;;) {
      const head = transfers[0];
      if (!head) return { done: false };
      const space = length - partial.total;
      if (space <= 0) return { done: true };
      const remaining = head.bytes.length - head.position;
      if (remaining === 0) {
        // Only the zero-length packet that terminates the device's transfer is left; it ends the host's request.
        transfers.shift();
        return { done: true };
      }
      const fullPackets = Math.floor(remaining / PACKET);
      if (fullPackets > 0) {
        const spacePackets = Math.floor(space / PACKET);
        if (spacePackets === 0) {
          if (partial.total === 0) throw Object.assign(new Error("babble: the device sent a full packet to a request smaller than a packet"), { status: "babble" });
          return { done: true };
        }
        const take = Math.min(fullPackets, spacePackets) * PACKET;
        partial.parts.push(head.bytes.subarray(head.position, head.position + take));
        head.position += take;
        partial.total += take;
        // A transfer that ended on a packet boundary with no zero-length packet lets the next message run on into this request.
        if (head.position === head.bytes.length && !head.zlp) transfers.shift();
        continue;
      }
      if (space < remaining) throw Object.assign(new Error("babble: a short packet does not fit the request"), { status: "babble" });
      partial.parts.push(head.bytes.subarray(head.position));
      partial.total += remaining;
      transfers.shift();
      return { done: true };
    }
  };

  const waitFor = (ready, timeoutMs, signal, { background = false } = {}) => new Promise((resolve, reject) => {
    let timer;
    const settle = (outcome) => {
      clearTimeout(timer);
      waiters.delete(check);
      signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const check = () => { if (ready()) settle(() => resolve(true)); };
    const onAbort = () => settle(() => reject(aborted()));
    if (signal?.aborted) return onAbort();
    waiters.add(check);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => settle(() => resolve(false)), timeoutMs);
    // A native transfer nobody is waiting for any more (the test is over) must not keep the process alive; a read someone awaits must.
    if (background) timer.unref();
    return check();
  });

  /** One host bulk-IN request: completes with its bytes, rejects when the device leaves the bus or the request is cancelled. */
  const bulkIn = async (length, signal) => {
    const partial = { parts: [], total: 0 };
    for (;;) {
      if (!onBus) throw gone();
      if (signal?.aborted) throw aborted();
      const result = takeTransfer(length, partial);
      if (result.done) return Buffer.concat(partial.parts);
      await waitFor(() => transfers.length > 0 || !onBus, 60_000, signal, { background: true });
    }
  };

  const leave = () => {
    onBus = false;
    mode = "gone";
    wake();
  };

  // ---- Sahara ----------------------------------------------------------------

  const startLoaderPlan = () => {
    planIndex = 0;
    loaderPlan = [{ offset: 0, length: 0x34 }, { offset: 0x34, length: 0x40 }];
    let offset = 0x74;
    while (offset < loader.length) {
      const length = Math.min(loaderChunk, loader.length - offset);
      loaderPlan.push({ offset, length });
      offset += length;
    }
    if (loaderOverread > 0) loaderPlan[loaderPlan.length - 1].length += loaderOverread;
    received = [];
  };

  const requestNext = () => {
    if (planIndex >= loaderPlan.length) {
      const joined = Buffer.concat(received);
      uploadedLoader = joined;
      const expected = Buffer.concat([loader, Buffer.alloc(loaderOverread, 0xff)]);
      if (joined.equals(expected)) {
        loaderAccepted = true;
        state = "await-done";
        endTransfer(0);
      } else {
        state = "error";
        endTransfer(loaderStatus);
      }
      return;
    }
    const step = loaderPlan[planIndex];
    expectRaw = step.length;
    push(packet(0x03, IMAGE_ID, step.offset, step.length));
    state = "image-data";
  };

  const startProgrammer = () => {
    mode = "firehose";
    state = "firehose";
    if (!greeting) return;
    doc(logDoc("INFO: Binary build date: Oct  4 2026 @ 12:00:00"));
    doc(logDoc(`INFO: Chip serial num: ${serial} (0x${serial.toString(16)})`));
    const functions = ["configure", "program", "firmwarewrite", "patch", "setbootablestoragedrive", "read", "getstorageinfo", "power", "nop", "erase"];
    doc(logDoc(`INFO: Supported Functions (${functions.length}):`));
    for (const name of functions) doc(logDoc(`INFO: ${name}`));
    doc(logDoc(`INFO: End of supported functions ${functions.length}`));
  };

  const executePayload = (command) => {
    if (command === 1) return Buffer.from(new Uint8Array(new Uint32Array([serial]).buffer));
    if (command === 2) return Buffer.from(hardwareId, "hex").reverse();
    if (command === 3) return Buffer.from(pkHash);
    return undefined;
  };

  const saharaPacket = (bytes) => {
    const command = bytes.readUInt32LE(0);
    const field = (index) => bytes.readUInt32LE(8 + 4 * index);
    saharaLog.push({ command, mode: command === 0x02 ? field(3) : undefined, executed: command === 0x0d ? field(0) : undefined });
    if (command === 0x13) {
      if (!resetStateMachine) return endTransfer(0x01, 0);
      state = "await-hello-rsp";
      return sayHello(0);
    }
    if (state === "await-hello-rsp" && command === 0x02) {
      if (field(0) < saharaMinVersion) return (state = "error"), endTransfer(0x04, 0);
      const wanted = field(3);
      if (wanted === 3) {
        if (!commandMode) return (state = "error"), endTransfer(0x18, 0);
        state = "command";
        return push(packet(0x0b));
      }
      if (wanted === 0) {
        startLoaderPlan();
        return requestNext();
      }
      return (state = "error"), endTransfer(0x18, 0);
    }
    if (state === "command") {
      if (command === 0x0d) {
        const wanted = field(0);
        const payload = refuseExecute.includes(wanted) ? undefined : executePayload(wanted);
        if (!payload) return endTransfer(0x1f, 0);
        state = `execute-${wanted}`;
        return push(packet(0x0e, wanted, payload.length));
      }
      if (command === 0x0c) {
        if (field(0) === 0 && helloAfterSwitch === "sends") sayHello(0);
        state = "await-hello-rsp";
        return undefined;
      }
      if (command === 0x07) {
        push(packet(0x08));
        resets += 1;
        onReset();
        return leave();
      }
    }
    if (state.startsWith("execute-") && command === 0x0f) {
      const wanted = Number(state.slice(8));
      state = "command";
      return push(executePayload(wanted));
    }
    if (state === "await-hello-rsp" && command === 0x07) {
      push(packet(0x08));
      resets += 1;
      onReset();
      return leave();
    }
    if (state === "await-done" && command === 0x05) {
      push(packet(0x06, 1));
      return startProgrammer();
    }
    state = "error";
    return endTransfer(0x01, 0);
  };

  const saharaInbox = () => {
    for (;;) {
      if (state === "error") {
        // A ROM in error ignores everything except a state-machine reset.
        if (inboxBytes.length >= 8 && inboxBytes.readUInt32LE(0) === 0x13) {
          const packetBytes = inboxBytes.subarray(0, 8);
          inboxBytes = inboxBytes.subarray(8);
          saharaPacket(Buffer.from(packetBytes));
          continue;
        }
        inboxBytes = Buffer.alloc(0);
        return;
      }
      if (state === "image-data") {
        if (inboxBytes.length < expectRaw) return;
        received.push(Buffer.from(inboxBytes.subarray(0, expectRaw)));
        inboxBytes = inboxBytes.subarray(expectRaw);
        planIndex += 1;
        requestNext();
        continue;
      }
      if (inboxBytes.length < 8) return;
      const length = inboxBytes.readUInt32LE(4);
      if (length < 8 || length > 4096) {
        state = "error";
        inboxBytes = Buffer.alloc(0);
        return endTransfer(0x05, 0);
      }
      if (inboxBytes.length < length) return;
      const bytes = Buffer.from(inboxBytes.subarray(0, length));
      inboxBytes = inboxBytes.subarray(length);
      saharaPacket(bytes);
    }
  };

  // ---- Firehose --------------------------------------------------------------

  const attributesOf = (tag) => {
    const out = {};
    for (const match of tag.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) out[match[1]] = match[2];
    return out;
  };

  const storageLog = () => `INFO: ${JSON.stringify({ storage_info: { total_blocks: totalBlocks, block_size: blockSize, page_size: blockSize, num_physical: 1, manufacturer_id: 21, serial_num: 3731524394, fw_version: "0", mem_type: memoryType, prod_name: productName } })}`;

  /** The fault that applies to the read command being handled now: from read `atRead` on, or (with `once`) that read only. */
  const faultNow = () => {
    if (!readFault) return undefined;
    const first = readFault.atRead ?? 1;
    return (readFault.once ? readsDone === first : readsDone >= first) ? readFault : undefined;
  };

  const handleRead = (attributes) => {
    const sectorSize = Number(attributes.SECTOR_SIZE_IN_BYTES);
    const start = Number(attributes.start_sector);
    const count = Number(attributes.num_partition_sectors);
    readsDone += 1;
    if (!configured) {
      doc(logDoc("ERROR: configure first"));
      return respond('value="NAK"');
    }
    if (faultNow()?.nak) {
      doc(logDoc("ERROR: Failed to read from the device"));
      return respond('value="NAK"');
    }
    // The programmer can only read what is really there, whatever the storage report claims.
    if (sectorSize !== blockSize || Number(attributes.physical_partition_number) !== 0 || start + count > totalBlocks || (start + count) * sectorSize > store.length) {
      doc(logDoc(`ERROR: Read of ${count} sector(s) at ${start} is outside the device`));
      return respond('value="NAK"');
    }
    const data = Buffer.from(store.subarray(start * sectorSize, (start + count) * sectorSize));
    const announce = Buffer.from(xmlDoc('<response value="ACK" rawmode="true" />') + padding);
    const closing = Buffer.from(xmlDoc('<response value="ACK" rawmode="false" />') + padding);
    const fault = faultNow();
    let body = data;
    if (fault?.truncate) body = data.subarray(0, data.length - fault.truncate);
    if (fault?.stallAfter !== undefined) body = data.subarray(0, fault.stallAfter);
    if (fault?.leaveAfter !== undefined) body = data.subarray(0, fault.leaveAfter);
    if (fault?.extra) body = Buffer.concat([data, Buffer.alloc(fault.extra, 0xaa)]);
    if (coalesceRaw) push(Buffer.concat([announce, body.subarray(0, Math.min(body.length, rawChunk))]), { shortPacket: false });
    else push(announce);
    for (let offset = coalesceRaw ? Math.min(body.length, rawChunk) : 0; offset < body.length; offset += rawChunk) {
      const piece = body.subarray(offset, Math.min(body.length, offset + rawChunk));
      push(piece);
      rawSent += piece.length;
    }
    if (fault?.leaveAfter !== undefined) return setTimeout(leave, 20).unref();
    if (fault?.stallAfter !== undefined) return undefined;
    return push(closing);
  };

  const handleCommand = (tag, attributes) => {
    commands.push({ tag, attributes });
    if (FORBIDDEN_TAGS.includes(tag) || !["nop", "configure", "getstorageinfo", "read", "power"].includes(tag)) {
      forbidden.push({ tag, attributes });
      // The device does what it is told: a host that sends a write sees it land.
      if (tag === "erase" || tag === "program" || tag === "patch") store.fill(0, 0, Math.min(store.length, 4096));
      return respond('value="ACK"');
    }
    if (tag === "nop") {
      if (nopAnswers === "silent") return undefined;
      doc(logDoc(`INFO: Chip serial num: ${serial} (0x${serial.toString(16)})`));
      return nopAnswers === "response" ? respond('value="ACK"') : undefined;
    }
    if (tag === "configure") {
      const wanted = Number(attributes.MaxPayloadSizeToTargetInBytes);
      if ((configureNakFirst && wanted > 65536) || wanted > maxPayload) {
        return respond(`value="NAK" MemoryName="${memoryType}" MaxPayloadSizeToTargetInBytes="${configureNakFirst ? 65536 : maxPayload}" MaxPayloadSizeToTargetInBytesSupported="${configureNakFirst ? 65536 : maxPayload}" MaxXMLSizeInBytes="4096"`);
      }
      if (attributes.MemoryName.toLowerCase() !== memoryType.toLowerCase()) {
        doc(logDoc(`ERROR: Not support configure MemoryName ${attributes.MemoryName}`));
        return respond('value="NAK"');
      }
      configured = true;
      return respond(`value="ACK" MinVersionSupported="1" MemoryName="${memoryType}" MaxPayloadSizeFromTargetInBytes="4096" MaxPayloadSizeToTargetInBytes="${wanted}" MaxPayloadSizeToTargetInBytesSupported="${maxPayload}" MaxXMLSizeInBytes="4096" Version="1" TargetName="8953"`);
    }
    if (tag === "getstorageinfo") {
      if (infoFault === "spam") {
        for (let index = 0; index < spamLogs; index += 1) doc(logDoc(`INFO: spam ${index}`));
        return undefined;
      }
      if (infoFault === "oversize") return push(Buffer.from(xmlDoc(`<log value="${"A".repeat(300 * 1024)}" />`)));
      if (infoFault === "garbage") return push(Buffer.from("this is not xml at all ".repeat(10)));
      if (infoFault === "silent") return undefined;
      if (infoFault === "nak") {
        doc(logDoc("ERROR: Failed to open the SDCC Device"));
        return respond('value="NAK"');
      }
      doc(logDoc(storageInfoLine ?? storageLog()));
      return respond('value="ACK"');
    }
    if (tag === "read") return handleRead(attributes);
    if (tag === "power") {
      respond('value="ACK"');
      resets += 1;
      onReset();
      return setTimeout(leave, 10).unref();
    }
    return undefined;
  };

  const firehoseInbox = () => {
    for (;;) {
      const text = inboxBytes.toString("latin1");
      const close = text.indexOf("</data>");
      if (close === -1) return;
      const documentText = text.slice(0, close + 7);
      inboxBytes = inboxBytes.subarray(close + 7);
      const elements = [...documentText.matchAll(/<([A-Za-z_][\w.-]*)([^>]*)>/g)].filter((match) => match[1] !== "data" && !match[0].startsWith("<?"));
      for (const element of elements) handleCommand(element[1], attributesOf(element[2]));
    }
  };

  // ---- Bus -------------------------------------------------------------------

  const receive = (bytes) => {
    inboxBytes = Buffer.concat([inboxBytes, Buffer.from(bytes)]);
    if (mode === "sahara") saharaInbox();
    else if (mode === "firehose") firehoseInbox();
  };

  if (initialMode === "sahara") {
    state = "await-hello-rsp";
    sayHello(0);
  } else {
    state = "firehose";
    configured = false;
    if (greeting) {
      doc(logDoc(`INFO: Chip serial num: ${serial} (0x${serial.toString(16)})`));
    }
  }

  // The browser transport keeps ONE native transfer outstanding across quiet deadlines and hands its bytes to a later read.
  let completed;
  let failure;
  const startNativeRead = () => {
    const controller = new AbortController();
    pendingIn = { controller };
    bulkIn(requestedLength, controller.signal).then(
      (value) => { if (pendingIn?.controller === controller) { pendingIn = undefined; completed = value; wake(); } },
      (error) => { if (pendingIn?.controller === controller) { pendingIn = undefined; failure = error; wake(); } },
    );
  };

  const transport = {
    kind: "usb",
    async read(length, timeoutMs, signal) {
      if (!onBus) throw gone();
      if (signal?.aborted) throw aborted();
      requestedLength = Math.max(requestedLength, length);
      if (failure) { const error = failure; failure = undefined; throw error; }
      if (completed === undefined && !pendingIn) startNativeRead();
      try {
        await waitFor(() => completed !== undefined || failure !== undefined, timeoutMs, signal);
      } catch (error) {
        // Cancelling a read closes the device in the real client: whatever the native transfer held is gone.
        pendingIn?.controller.abort();
        pendingIn = undefined;
        completed = undefined;
        throw error;
      }
      if (failure) { const error = failure; failure = undefined; throw error; }
      if (completed === undefined) return null;
      const value = completed;
      completed = undefined;
      return Uint8Array.from(value);
    },
    async write(bytes, signal) {
      if (!onBus) throw gone();
      if (signal?.aborted) throw aborted();
      receive(bytes);
    },
    connected: () => onBus,
  };

  return {
    transport,
    /** The WebUSB-shaped halves, for tests that put this behind a fake `USBDevice`. */
    bulkIn,
    bulkOut: async (bytes) => {
      if (!onBus) throw gone();
      receive(bytes);
    },
    leave,
    /** Everything the Firehose loop was asked, in order. */
    commands,
    /** Write-type commands that arrived (there must be none). */
    forbidden,
    saharaLog,
    get disk() { return store; },
    get mode() { return mode; },
    get state() { return state; },
    get resets() { return resets; },
    get loaderAccepted() { return loaderAccepted; },
    get uploadedLoader() { return uploadedLoader; },
    get configured() { return configured; },
    get onBus() { return onBus; },
    get rawSent() { return rawSent; },
    get pendingTransfers() { return transfers.length; },
    loader,
    serial,
    sector: SECTOR,
  };
}

/** Wraps a device transport in the shape `HardwareContext` wants, recording progress, output and confirmations. */
export function edlContext(device, { input, signal = new AbortController().signal, approve = true, saved = [], onProgress } = {}) {
  const confirmations = [];
  const progress = [];
  const output = [];
  const abort = signal;
  const context = {
    transport: device.transport,
    signal: abort,
    input,
    progress: (event) => { progress.push(event); onProgress?.(event); },
    output: (line) => { output.push(line); },
    async confirm(risk) {
      confirmations.push(risk);
      if (approve === false) throw new DOMException("Operation cancelled.", "AbortError");
      if (typeof approve === "function") await approve(risk);
    },
    async save(name, blob) {
      const id = `file-${saved.length + 1}`;
      const bytes = Buffer.from(await blob.arrayBuffer());
      saved.push({ id, name, blob, bytes, sha256: sha256(bytes) });
      return id;
    },
    async saveStream(name, chunks) {
      const parts = [];
      for await (const chunk of chunks) {
        abort.throwIfAborted();
        parts.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(parts);
      const id = `file-${saved.length + 1}`;
      saved.push({ id, name, bytes, sha256: sha256(bytes) });
      return { fileId: id, sha256: sha256(bytes), length: bytes.length };
    },
    expectDeviceRestart() { return () => undefined; },
  };
  return { context, confirmations, progress, output, saved };
}
