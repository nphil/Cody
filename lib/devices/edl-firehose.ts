import { EdlError, edlTimeouts, type EdlLink } from "./edl-link";
import { answerBeganInsideData, cleanDeviceText, FIREHOSE_XML_LIMITS, parseFirehoseDocument, scanFirehoseFrame } from "./edl-xml";

/**
 * Firehose: the programmer's XML command protocol, READ-ONLY by construction.
 *
 * A running programmer will do anything it is told, including erase and program.
 * This host layer cannot tell it to: the only commands that exist here are the
 * five in `FirehoseCommand`, they are built from validated numbers (never from
 * text), and every byte string that reaches the wire passes
 * `assertReadOnlyFirehoseXml`, which parses what is about to be sent and refuses
 * anything that is not exactly one of those five commands with exactly their
 * attributes. There is no function that sends caller-supplied XML.
 *
 *   nop             liveness and the programmer's own description of itself
 *   configure       negotiate memory type and transfer sizes (eMMC only)
 *   getstorageinfo  capacity, sector size, product name of the user area
 *   read            sectors of physical partition 0 (the eMMC user area)
 *   power reset     leave EDL; the only `power` value that is ever sent
 */

export const FIREHOSE_SEGMENT_BYTES = 16 * 1024 * 1024;
// Waits: see `edlTimeouts` in edl-link.ts.
const MAX_DOCUMENTS_PER_EXCHANGE = 400;
const MAX_BYTES_PER_EXCHANGE = 2 * 1024 * 1024;
const MAX_KEPT_LOGS = 300;
const MAX_COMMAND_BYTES = 1024;
/** Bytes after a document's `</data>`, in the same transfer, that are padding rather than the start of raw data. */
const MAX_TRAILING_PADDING = 16;
/** How much of the end of a read's data is kept to check it against the answer that closes it. */
const DATA_TAIL_BYTES = 1024;

export type FirehoseCommand =
  | { readonly kind: "nop" }
  | { readonly kind: "configure"; readonly maxPayloadToTarget: number; readonly zlpAware: boolean; readonly skipStorageInit: boolean }
  | { readonly kind: "getstorageinfo" }
  | { readonly kind: "read"; readonly sectorSize: number; readonly startSector: number; readonly sectors: number }
  | { readonly kind: "power-reset" };

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new EdlError(`${name} must be a whole number from ${minimum} to ${maximum}.`, "refused");
  return value;
}

/** The last `limit` bytes of `previous` followed by `next`, as a copy that stays valid when the caller reuses `next`. */
function lastBytes(previous: Uint8Array, next: Uint8Array, limit: number): Uint8Array {
  if (next.byteLength >= limit) return Uint8Array.from(next.subarray(next.byteLength - limit));
  const keep = Math.min(previous.byteLength, limit - next.byteLength);
  const out = new Uint8Array(keep + next.byteLength);
  out.set(previous.subarray(previous.byteLength - keep), 0);
  out.set(next, keep);
  return out;
}

/** The XML for one command. Only numbers and fixed words go in; there is no free text. */
export function serializeFirehoseCommand(command: FirehoseCommand): string {
  let body: string;
  switch (command.kind) {
    case "nop":
      body = "<nop />";
      break;
    case "configure":
      body = `<configure MemoryName="eMMC" Verbose="0" AlwaysValidate="0" MaxDigestTableSizeInBytes="2048" MaxPayloadSizeToTargetInBytes="${integer(command.maxPayloadToTarget, "MaxPayloadSizeToTargetInBytes", 1024, 0x7fffffff)}" ZLPAwareHost="${command.zlpAware ? 1 : 0}" SkipStorageInit="${command.skipStorageInit ? 1 : 0}" SkipWrite="0" />`;
      break;
    case "getstorageinfo":
      body = '<getstorageinfo physical_partition_number="0" />';
      break;
    case "read":
      if (command.sectorSize !== 512 && command.sectorSize !== 4096) throw new EdlError("SECTOR_SIZE_IN_BYTES must be 512 or 4096.", "refused");
      body = `<read SECTOR_SIZE_IN_BYTES="${command.sectorSize}" num_partition_sectors="${integer(command.sectors, "num_partition_sectors", 1, 0x7fffffff)}" physical_partition_number="0" start_sector="${integer(command.startSector, "start_sector", 0, 2 ** 40)}" />`;
      break;
    case "power-reset":
      body = '<power value="reset" />';
      break;
  }
  return `<?xml version="1.0" ?><data>${body}</data>`;
}

/** Exactly the attributes each allowed command may carry, and the only values each may take. */
const ALLOWED_COMMANDS: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  nop: {},
  configure: {
    MemoryName: /^eMMC$/,
    Verbose: /^0$/,
    AlwaysValidate: /^0$/,
    MaxDigestTableSizeInBytes: /^2048$/,
    MaxPayloadSizeToTargetInBytes: /^[1-9][0-9]{3,9}$/,
    ZLPAwareHost: /^[01]$/,
    SkipStorageInit: /^[01]$/,
    SkipWrite: /^0$/,
  },
  getstorageinfo: { physical_partition_number: /^0$/ },
  read: {
    SECTOR_SIZE_IN_BYTES: /^(?:512|4096)$/,
    num_partition_sectors: /^[1-9][0-9]{0,9}$/,
    physical_partition_number: /^0$/,
    start_sector: /^(?:0|[1-9][0-9]{0,12})$/,
  },
  power: { value: /^reset$/ },
};

/**
 * The last line of defence before the wire: parses the XML about to be sent and
 * throws unless it is `<data>` holding exactly ONE allowed command whose
 * attributes are exactly its allowed set with allowed values. Programs, erases,
 * patches, boot-drive changes, memory pokes, digests, `power` with any other
 * value (off, edl) and every unknown tag fail here, as do two commands in one
 * document and anything smuggled in text, comments or a second prolog.
 */
export function assertReadOnlyFirehoseXml(xml: string): void {
  if (xml.length > MAX_COMMAND_BYTES) throw new EdlError("Refused: a Firehose command this long is not one of the read-only commands.", "refused");
  let document;
  try {
    document = parseFirehoseDocument(xml);
  } catch {
    throw new EdlError("Refused: this is not a well-formed read-only Firehose command.", "refused");
  }
  const [root, command, ...extra] = document.elements;
  if (!root || root.name !== "data" || root.depth !== 0 || Object.keys(root.attributes).length > 0 || !command || command.depth !== 1 || extra.length > 0 || document.strayText || document.extras > 0) {
    throw new EdlError("Refused: a Firehose document may hold exactly one read-only command.", "refused");
  }
  const shape = Object.hasOwn(ALLOWED_COMMANDS, command.name) ? ALLOWED_COMMANDS[command.name]! : undefined;
  if (!shape) {
    throw new EdlError(`Refused: <${cleanDeviceText(command.name, 32)}> is not a read-only Firehose command. This build can read storage; it cannot write, erase, patch or change boot settings.`, "refused");
  }
  const given = Object.keys(command.attributes);
  const wanted = Object.keys(shape);
  if (given.length !== wanted.length || !wanted.every((name) => Object.hasOwn(command.attributes, name) && shape[name]!.test(command.attributes[name]!))) {
    throw new EdlError(`Refused: <${command.name}> carries attributes or values outside the read-only form.`, "refused");
  }
}

export type FirehoseAttributes = Readonly<Record<string, string>>;

export class FirehoseRejection extends EdlError {
  constructor(readonly command: string, readonly logs: readonly string[], readonly attributes: FirehoseAttributes) {
    super(`The programmer refused ${command}${logs.length > 0 ? `: ${logs.slice(-3).join(" | ")}` : " without saying why"}.`, "rejected");
    this.name = "FirehoseRejection";
  }
}

export interface FirehoseConfiguration {
  readonly memoryName: string | null;
  readonly targetName: string | null;
  readonly version: string | null;
  readonly maxPayloadFromTarget: number | null;
  readonly maxPayloadToTarget: number | null;
  readonly maxXmlBytes: number | null;
  /** The size the programmer settled on after any negotiation. */
  readonly negotiatedPayloadToTarget: number;
}

export interface FirehoseStorage {
  readonly memoryType: string;
  /** Sector size in bytes. */
  readonly sectorSize: number;
  /** Sectors in the user area, as the programmer measures it. */
  readonly totalSectors: number;
  readonly physicalPartitions: number | null;
  readonly productName: string | null;
  readonly manufacturerId: number | null;
  readonly serialNumber: string | null;
  readonly firmwareVersion: string | null;
  readonly pageSize: number | null;
}

interface Collected {
  readonly logs: string[];
  readonly omittedLogs: number;
  readonly responses: FirehoseAttributes[];
  readonly documents: number;
}

interface CollectOptions {
  readonly label: string;
  readonly timeoutMs: number;
  /** `response`: stop at the first <response>. `quiet`: stop once nothing more arrives for `quietMs`. */
  readonly until: "response" | "quiet";
  readonly quietMs?: number;
  /** The answer must follow raw sector data directly. */
  readonly strict?: boolean;
  /**
   * With `strict`: the last bytes of the sector data this answer closes. A first document that is really the continuation of
   * data that came up short (its start was taken for sector bytes) is refused. `what` names the read in the message.
   */
  readonly dataTail?: { readonly bytes: Uint8Array; readonly what: string };
  /** `quiet` only: wait the whole timeout for the FIRST document instead of one quiet window. */
  readonly patient?: boolean;
}

function numberAttribute(attributes: FirehoseAttributes, name: string): number | null {
  const value = attributes[name];
  return value !== undefined && /^[0-9]{1,15}$/.test(value) ? Number.parseInt(value, 10) : null;
}

function parseStorageInfo(logs: readonly string[]): FirehoseStorage {
  for (const line of logs) {
    if (!line.includes("storage_info")) continue;
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    if (open === -1 || close <= open) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(open, close + 1));
    } catch {
      continue;
    }
    const info = typeof parsed === "object" && parsed !== null && "storage_info" in parsed ? parsed.storage_info : undefined;
    if (typeof info !== "object" || info === null || Array.isArray(info)) continue;
    // JSON.parse produced this plain object; every field read from it is checked below.
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(info));
    const count = (name: string): number | null => {
      const value = record[name];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const text = (name: string): string | null => {
      const value = record[name];
      return typeof value === "string" || typeof value === "number" ? cleanDeviceText(String(value), 64) : null;
    };
    const totalSectors = count("total_blocks");
    const sectorSize = count("block_size");
    if (totalSectors === null || totalSectors < 1) throw new EdlError("The programmer's storage report has no usable total_blocks.");
    if (sectorSize !== 512 && sectorSize !== 4096) throw new EdlError(`The programmer reports a block size of ${String(record.block_size)}; Cody reads 512- or 4096-byte sectors.`, "refused");
    const pageSize = count("page_size");
    if (pageSize !== null && pageSize !== sectorSize) throw new EdlError(`The programmer's block size (${sectorSize}) and page size (${pageSize}) disagree, so the sector size is ambiguous. Nothing was read.`, "refused");
    return {
      memoryType: text("mem_type") ?? "unknown",
      sectorSize,
      totalSectors,
      physicalPartitions: count("num_physical"),
      productName: text("prod_name"),
      manufacturerId: count("manufacturer_id"),
      serialNumber: text("serial_num"),
      firmwareVersion: text("fw_version"),
      pageSize,
    };
  }
  throw new EdlError("The programmer did not report storage information in a form Cody can read.");
}

/** A Firehose programmer on an open link. Every method here sends only commands from `FirehoseCommand`. */
export class FirehoseSession {
  readonly greeting: string[] = [];
  supportedFunctions: string[] = [];
  chipSerial: string | null = null;
  configuration: FirehoseConfiguration | undefined;

  constructor(private readonly link: EdlLink, private readonly say: (line: string) => void) {}

  private noteLogs(logs: readonly string[]): void {
    for (const line of logs) {
      // The programmer prints the serial in decimal and hex ("439041101 (0x1a2b3c4d)"); the hex form is the one people compare.
      const hexSerial = /chip serial num.*?(0x[0-9a-f]+)/i.exec(line);
      const decimalSerial = /chip serial num[^0-9]*([0-9]{1,15})/i.exec(line);
      if (hexSerial) this.chipSerial = hexSerial[1]!.toLowerCase();
      else if (decimalSerial) this.chipSerial = `0x${Number.parseInt(decimalSerial[1]!, 10).toString(16)}`;
    }
    const start = logs.findIndex((line) => /supported functions/i.test(line));
    if (start !== -1) {
      const names = logs.slice(start + 1).filter((line) => !/end of supported functions/i.test(line)).map((line) => line.replace(/^INFO:\s*/, "").trim()).filter((line) => /^[A-Za-z0-9_]{1,32}$/.test(line));
      if (names.length > 0) this.supportedFunctions = names.slice(0, 64);
    }
  }

  /** Sends one command from the closed set, after the read-only check. The only function that writes Firehose XML. */
  private async transmit(command: FirehoseCommand): Promise<void> {
    let xml = serializeFirehoseCommand(command);
    // A command whose length is a multiple of the packet size would need a zero-length packet to end it; whitespace avoids that.
    if (new TextEncoder().encode(xml).length % 512 === 0) xml += "\n";
    assertReadOnlyFirehoseXml(xml);
    await this.link.write(new TextEncoder().encode(xml));
  }

  private consumeDocument(end: number): void {
    const rest = this.link.restOfTransferAfter(end);
    let padding = 0;
    if (rest > 0 && rest <= MAX_TRAILING_PADDING) {
      const tail = this.link.view().subarray(end, end + rest);
      if (tail.every((byte) => byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20)) padding = rest;
    }
    this.link.consume(end + padding);
  }

  /** Reads and drops anything the previous exchange left behind, so a late log line is never taken for the next answer. */
  private async settle(): Promise<void> {
    await this.link.pull(25);
    let guard = 0;
    while (this.link.buffered > 0 && guard < 100) {
      guard += 1;
      const frame = scanFirehoseFrame(this.link.view());
      if (frame.kind !== "document") {
        this.link.consume(this.link.buffered);
        return;
      }
      this.consumeDocument(frame.end);
    }
  }

  private async collect(options: CollectOptions): Promise<Collected> {
    const until = Date.now() + options.timeoutMs;
    const logs: string[] = [];
    const responses: FirehoseAttributes[] = [];
    let omittedLogs = 0;
    let documents = 0;
    const startBytes = this.link.bytesReceived;
    for (;;) {
      if (this.link.buffered > 0) {
        const frame = scanFirehoseFrame(this.link.view(), options.strict === true && documents === 0);
        if (frame.kind === "document") {
          if (options.dataTail && documents === 0) {
            const short = answerBeganInsideData(options.dataTail.bytes, this.link.view().subarray(0, frame.end));
            if (short !== null) {
              throw new EdlError(`${options.dataTail.what}: the programmer's closing answer began inside the sector data (the data is ${short} byte(s) short), so the last ${short} byte(s) delivered are the programmer's own text, not the disk's. Nothing from this read can be trusted.`);
            }
          }
          documents += 1;
          for (const line of frame.document.logs) {
            if (logs.length < MAX_KEPT_LOGS) logs.push(cleanDeviceText(line, 1024));
            else omittedLogs += 1;
          }
          responses.push(...frame.document.responses);
          this.consumeDocument(frame.end);
          if (documents > MAX_DOCUMENTS_PER_EXCHANGE || this.link.bytesReceived - startBytes > MAX_BYTES_PER_EXCHANGE) {
            throw new EdlError(`${options.label}: the programmer kept talking (${documents} documents) without finishing its answer.`);
          }
          if (responses.length > 0 && options.until === "response") return { logs, omittedLogs, responses, documents };
          continue;
        }
      }
      const remaining = until - Date.now();
      if (options.until === "quiet") {
        if (remaining <= 0) return { logs, omittedLogs, responses, documents };
        // Before anything has arrived a patient wait gives the whole timeout; afterwards (or when not patient) one quiet window ends it.
        const window = documents === 0 && options.patient ? remaining : Math.min(options.quietMs ?? 400, remaining);
        const added = await this.link.pull(window);
        if (added === null) return { logs, omittedLogs, responses, documents };
        continue;
      }
      if (remaining <= 0) throw new EdlError(`${options.label} timed out waiting for the programmer's answer.`, "timeout");
      await this.link.pull(remaining);
    }
  }

  private async exchange(command: FirehoseCommand, options: Omit<CollectOptions, "until">): Promise<Collected> {
    await this.settle();
    await this.transmit(command);
    return this.collect({ ...options, until: "response" });
  }

  private requireAck(collected: Collected, name: string, rawMode?: "true" | "false"): FirehoseAttributes {
    const response = collected.responses[0]!;
    const value = (response.value ?? "").toUpperCase();
    this.noteLogs(collected.logs);
    if (value === "NAK") throw new FirehoseRejection(name, collected.logs, response);
    if (value !== "ACK") throw new EdlError(`The programmer answered ${name} with value "${cleanDeviceText(response.value ?? "", 32)}", neither ACK nor NAK.`);
    if (rawMode !== undefined && (response.rawmode ?? "false").toLowerCase() !== rawMode) {
      throw new EdlError(`The programmer answered ${name} with rawmode="${cleanDeviceText(response.rawmode ?? "", 16)}" where "${rawMode}" was expected.`);
    }
    return response;
  }

  /**
   * Right after a loader was accepted (or when a programmer was already
   * running): collect what it prints on startup, then check that it answers.
   */
  async start(): Promise<void> {
    try {
      const greeting = await this.collect({ label: "Firehose greeting", timeoutMs: edlTimeouts.greeting, until: "quiet", quietMs: edlTimeouts.greetingQuiet });
      this.greeting.push(...greeting.logs);
      this.noteLogs(greeting.logs);
    } catch (error) {
      // The greeting is a courtesy; a programmer that prints something odd on startup may still work.
      if (!(error instanceof EdlError)) throw error;
      this.say(`The programmer's startup text could not be read (${error.message}); continuing.`);
      await this.link.drain(300, 8 * 1024 * 1024);
    }
    await this.settle();
    await this.transmit({ kind: "nop" });
    const answer = await this.collect({ label: "Firehose nop", timeoutMs: edlTimeouts.nop, until: "quiet", quietMs: edlTimeouts.nopQuiet, patient: true });
    this.noteLogs(answer.logs);
    this.greeting.push(...answer.logs);
    if (answer.documents === 0) throw new EdlError("No Firehose programmer answered. The device may still be in the boot ROM, or the loader did not start.", "timeout");
  }

  /**
   * Asks whether a programmer is listening: a `nop`, and whether anything XML came
   * back. A boot ROM answers a command it does not know with binary data, which
   * counts as "no programmer".
   */
  async probe(timeoutMs: number): Promise<boolean> {
    try {
      await this.transmit({ kind: "nop" });
      const answer = await this.collect({ label: "Firehose probe", timeoutMs, until: "quiet", quietMs: edlTimeouts.nopQuiet, patient: true });
      this.noteLogs(answer.logs);
      return answer.documents > 0;
    } catch (error) {
      if (error instanceof EdlError && error.kind !== "refused") return false;
      throw error;
    }
  }

  /** Negotiates eMMC and transfer sizes. A programmer that says it supports less is asked once more with its own figure. */
  async configure(): Promise<FirehoseConfiguration> {
    let payload = 1_048_576;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const collected = await this.exchange({ kind: "configure", maxPayloadToTarget: payload, zlpAware: true, skipStorageInit: false }, { label: "Firehose configure", timeoutMs: edlTimeouts.configure });
      const response = collected.responses[0]!;
      if ((response.value ?? "").toUpperCase() === "NAK") {
        const supported = numberAttribute(response, "MaxPayloadSizeToTargetInBytesSupported");
        if (attempt === 0 && supported !== null && supported >= 1024 && supported < payload) {
          this.say(`The programmer supports payloads up to ${supported} bytes; asking again with that.`);
          payload = supported;
          continue;
        }
        const memoryProblem = collected.logs.find((line) => /not support.*(emmc|memory)/i.test(line));
        if (memoryProblem) throw new EdlError(`The programmer does not support eMMC storage (${memoryProblem}). Cody reads eMMC devices only; this may be a UFS device.`, "refused");
        throw new FirehoseRejection("configure", collected.logs, response);
      }
      this.requireAck(collected, "configure");
      const memoryName = response.MemoryName ?? null;
      if (memoryName !== null && memoryName.toLowerCase() !== "emmc") {
        throw new EdlError(`The programmer reports ${cleanDeviceText(memoryName, 16)} storage. Cody reads eMMC devices only; nothing was read.`, "refused");
      }
      this.configuration = {
        memoryName,
        targetName: response.TargetName ?? null,
        version: response.Version ?? null,
        maxPayloadFromTarget: numberAttribute(response, "MaxPayloadSizeFromTargetInBytes"),
        maxPayloadToTarget: numberAttribute(response, "MaxPayloadSizeToTargetInBytes"),
        maxXmlBytes: numberAttribute(response, "MaxXMLSizeInBytes"),
        negotiatedPayloadToTarget: payload,
      };
      return this.configuration;
    }
    throw new EdlError("The programmer would not agree to a configuration.");
  }

  async storageInfo(): Promise<FirehoseStorage> {
    const collected = await this.exchange({ kind: "getstorageinfo" }, { label: "Firehose getstorageinfo", timeoutMs: edlTimeouts.command });
    this.requireAck(collected, "getstorageinfo");
    const storage = parseStorageInfo(collected.logs);
    if (storage.memoryType.toLowerCase() !== "emmc") throw new EdlError(`The programmer reports ${storage.memoryType} storage. Cody reads eMMC devices only; nothing was read.`, "refused");
    return storage;
  }

  /**
   * Reads `sectors` sectors from `startSector` of the user area as a stream of
   * byte chunks, in segments of at most `FIREHOSE_SEGMENT_BYTES`. Each segment
   * must end with the programmer's own ACK directly after the exact number of
   * bytes promised; anything else throws and nothing past that point is trusted.
   */
  async *readSectors(startSector: number, sectors: number, sectorSize: number): AsyncGenerator<Uint8Array> {
    integer(sectors, "sectors", 1, 2 ** 40);
    integer(startSector, "start sector", 0, 2 ** 40);
    const perSegment = Math.max(1, Math.floor(FIREHOSE_SEGMENT_BYTES / sectorSize));
    for (let done = 0; done < sectors; done += perSegment) {
      const count = Math.min(perSegment, sectors - done);
      const first = startSector + done;
      const label = `Firehose read of sectors ${first}-${first + count - 1}`;
      const announced = await this.exchange({ kind: "read", sectorSize, startSector: first, sectors: count }, { label, timeoutMs: edlTimeouts.firstAnswer });
      this.requireAck(announced, label, "true");
      let remaining = count * sectorSize;
      let tail: Uint8Array = new Uint8Array(0);
      while (remaining > 0) {
        const chunk = await this.link.readSome(Math.min(remaining, 64 * 1024), edlTimeouts.dataInactivity, `${label} (${remaining} byte(s) still to come)`);
        remaining -= chunk.byteLength;
        tail = lastBytes(tail, chunk, DATA_TAIL_BYTES);
        yield chunk;
      }
      const closing = await this.collect({ label: `${label}, closing answer`, timeoutMs: edlTimeouts.command, until: "response", strict: true, dataTail: { bytes: tail, what: label } });
      this.requireAck(closing, label, "false");
    }
  }

  /** `power value="reset"`: the device leaves EDL. It may drop off the bus before or after it answers. */
  async reset(): Promise<void> {
    await this.settle();
    await this.transmit({ kind: "power-reset" });
    try {
      const collected = await this.collect({ label: "Firehose reset", timeoutMs: 4_000, until: "response" });
      this.requireAck(collected, "reset");
    } catch (error) {
      if (!(error instanceof EdlError) || error.kind !== "timeout") throw error;
    }
  }
}

export { FIREHOSE_XML_LIMITS };
