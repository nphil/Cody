import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport } from "./flasher";
import { classifyProtectedRegionName, parseFlashSafety } from "./hardware-safety";
import { hashBlob } from "./blob-stream";
import { buildSparsePiece, imageFootprint, planImageSplit, type ImageFootprint, type SparseSplit } from "./sparse-image";
import { openZip, type ZipEntry } from "./zip-archive";
import { checkRequirements, MAX_ANDROID_INFO_BYTES, MAX_ANDROID_INFO_REQUIREMENTS, parseAndroidInfo, SKIPPED_BY_UPDATE, UPDATE_IMAGES } from "./android-info";
import { sha256 as incrementalSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deadline, readExact, throwIfAborted } from "./serial";
const FETCH_CHUNK_BYTES = 4 * 1024 * 1024;
/** fastboot never resparses into pieces larger than this, whatever the device would accept (RESPARSE_LIMIT). */
const MAX_RESPARSE_PIECE_BYTES = 1024 * 1024 * 1024;
/** The largest staged upload (`get_staged`) Cody accepts from a bootloader, and the size it reads at a time. */
const MAX_STAGED_UPLOAD_BYTES = 1024 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const FASTBOOT_PACKET_BYTES = 64;

const FASTBOOT_TIMEOUT_MS = 15_000;

export class FastbootProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FastbootProtocolError";
  }
}
class FastbootCommandFailure extends FastbootProtocolError {}

export type FastbootResponse =
  | { type: "INFO"; message: string }
  | { type: "OKAY"; message: string }
  | { type: "FAIL"; message: string }
  | { type: "DATA"; size: number };

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new FastbootProtocolError("Fastboot sent non-UTF-8 response text.");
  }
}



/** Parses exactly one 4-byte-tagged Fastboot response packet. */
export function parseFastbootResponse(packet: Uint8Array): FastbootResponse {
  if (packet.length < 4) throw new FastbootProtocolError("Fastboot response is shorter than its 4-byte tag.");
  const type = String.fromCharCode(packet[0]!, packet[1]!, packet[2]!, packet[3]!);
  const body = packet.subarray(4);
  if (type === "DATA") {
    const hexSize = decode(body);
    if (!/^[0-9a-fA-F]{8}$/.test(hexSize)) {
      throw new FastbootProtocolError(`Fastboot DATA length must be eight hexadecimal digits, received ${JSON.stringify(hexSize)}.`);
    }
    return { type, size: Number.parseInt(hexSize, 16) };
  }
  if (type === "INFO" || type === "OKAY" || type === "FAIL") return { type, message: decode(body) };
  throw new FastbootProtocolError(`Unknown Fastboot response tag ${JSON.stringify(type)}.`);
}

function requireUsb(transport: HardwareTransport): void {
  if (transport.kind !== "usb") throw new FastbootProtocolError("Fastboot requires a USB bulk transport.");
}

function requireTarget(target: string | undefined, label = "partition"): string {
  if (!target || !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(target)) {
    throw new FastbootProtocolError(`A Fastboot ${label} containing only letters, numbers, '.', '_', '-', and one slot ':' suffix is required.`);
  }
  return target;
}

function requireCommand(command: string): Uint8Array {
  const encoded = encoder.encode(command);
  if (encoded.length === 0 || encoded.length > FASTBOOT_PACKET_BYTES) {
    throw new FastbootProtocolError(`Fastboot command length must be 1-${FASTBOOT_PACKET_BYTES} bytes.`);
  }
  return encoded;
}

async function readResponse(context: HardwareContext): Promise<FastbootResponse> {
  throwIfAborted(context.signal);
  const packet = await context.transport.read(FASTBOOT_PACKET_BYTES, FASTBOOT_TIMEOUT_MS, context.signal);
  if (!packet) throw new FastbootProtocolError("Fastboot response timed out.");
  return parseFastbootResponse(packet);
}

interface FastbootTerminal {
  infos: string[];
  okay: string;
}

/** Reads INFO frames until the one terminal Fastboot reply. FAIL remains an
 * error: completion after a failed command is unknown and must not continue. */
async function readTerminal(context: HardwareContext): Promise<FastbootTerminal> {
  const infos: string[] = [];
  for (;;) {
    const response = await readResponse(context);
    if (response.type === "INFO") {
      context.output?.(response.message + "\n");
      infos.push(response.message);
      continue;
    }
    if (response.type === "OKAY") return { infos, okay: response.message };
    if (response.type === "FAIL") throw new FastbootCommandFailure(`Fastboot rejected the command: ${response.message || "unspecified failure"}.`);
    throw new FastbootProtocolError("Fastboot returned DATA where a terminal response was required.");
  }
}
async function command(context: HardwareContext, value: string): Promise<FastbootTerminal> {
  throwIfAborted(context.signal);
  context.output?.("> fastboot " + value + "\n");
  await context.transport.write(requireCommand(value), context.signal);
  return readTerminal(context);
}

async function getvar(context: HardwareContext, name: string): Promise<string> {
  const terminal = await command(context, `getvar:${name}`);
  return terminal.okay;
}

function parseHexSize(value: string, name: string): number {
  const match = /^(?:0x)?([0-9a-fA-F]+)$/.exec(value.trim());
  if (!match) throw new FastbootProtocolError(`Fastboot getvar:${name} did not return a hexadecimal size.`);
  const size = Number.parseInt(match[1]!, 16);
  if (!Number.isSafeInteger(size) || size <= 0) throw new FastbootProtocolError(`Fastboot getvar:${name} returned an unsupported size.`);
  return size;
}

interface FastbootReadback {
  partitionSize: number;
  fetchSize: number;
}

async function optionalGetvar(context:HardwareContext,name:string):Promise<string|undefined> {
  try { return await getvar(context,name); }
  catch(error) { if (!(error instanceof FastbootCommandFailure)) throw error; return undefined; }
}

async function inspectPartition(context:HardwareContext,target:string) {
  const size=await optionalGetvar(context,"partition-size:"+target), fetch=await optionalGetvar(context,"fetch-size");
  const partitionSize=size ? parseHexSize(size,"partition-size:"+target) : undefined;
  const fetchSize=fetch ? parseHexSize(fetch,"fetch-size") : undefined;
  return {partitionSize,capability:partitionSize && fetchSize ? {partitionSize,fetchSize} : undefined};
}

async function readbackCapability(context:HardwareContext,target:string):Promise<FastbootReadback> {
  const {capability}=await inspectPartition(context,target);
  if (!capability) throw new FastbootProtocolError("Fastboot fetch readback is unavailable. Boot recovery and use ADB pull instead.");
  return capability;
}

async function* fetchChunks(context: HardwareContext, target: string, offset: number, length: number, capability: FastbootReadback): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<=0 || offset+length>capability.partitionSize) throw new FastbootProtocolError("Requested Fastboot fetch range is outside the reported partition size.");
  let position=offset;
  while (position<offset+length) {
    const requested=Math.min(capability.fetchSize,FETCH_CHUNK_BYTES,offset+length-position);
    await context.transport.write(requireCommand("fetch:" + target + ":" + position.toString(16) + ":" + requested.toString(16)),context.signal);
    const response=await readResponse(context);
    if (response.type==="FAIL") throw new FastbootCommandFailure(response.message);
    if (response.type!=="DATA" || response.size!==requested) throw new FastbootProtocolError("Fastboot fetch did not announce the exact requested byte count.");
    const data=await readExact(context.transport,requested,deadline("Fastboot fetch data",FASTBOOT_TIMEOUT_MS),context.signal);
    await readTerminal(context); position+=requested;
    yield data;
    context.progress({phase:"readback",completed:position-offset,total:length});
  }
}

/** Escrows a stream of device bytes: streamed when the browser manager offers it, otherwise one small Blob. */
async function saveChunks(context: HardwareContext, chunks:AsyncIterable<Uint8Array<ArrayBuffer>>, length:number, name:string) {
  if (context.saveStream) return context.saveStream(name,chunks);
  // Small direct Flasher consumers may provide Blob escrow only. The browser manager streams.
  if (length>8*1024*1024) throw new FastbootProtocolError("This client must provide streaming artifact escrow for this backup.");
  const data:Uint8Array<ArrayBuffer>[]=[]; for await(const chunk of chunks) data.push(chunk);
  const blob=new Blob(data); return {fileId:await context.save(name,blob),sha256:await hashBlob(blob),length};
}

async function download(context: HardwareContext, firmware:Blob, label?:string):Promise<void> {
  if (!firmware.size || firmware.size>0xffffffff) throw new FastbootProtocolError("One Fastboot download must contain 1 through 0xffffffff bytes. A larger image is sent as sparse pieces, which needs the bootloader to report its max-download-size.");
  await context.transport.write(requireCommand("download:"+firmware.size.toString(16).padStart(8,"0")),context.signal);
  const response=await readResponse(context);
  if(response.type==="FAIL") throw new FastbootCommandFailure(response.message);
  if(response.type!=="DATA" || response.size!==firmware.size) throw new FastbootProtocolError("Fastboot did not acknowledge the exact download byte count.");
  const reader=firmware.stream().getReader(); let completed=0;
  try { for (;;) { context.signal.throwIfAborted(); const next=await reader.read(); if(next.done)break; await context.transport.write(next.value,context.signal); completed+=next.value.length; context.progress({phase:"download",completed,total:firmware.size,...(label?{message:`Sending ${label}`}:{})}); } }
  finally { reader.releaseLock(); }
  await readTerminal(context);
}

function getvarAll(infos: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const info of infos) {
    const separator = info.indexOf(":");
    if (separator > 0) values[info.slice(0, separator)] = info.slice(separator + 1).trim();
  }
  return values;
}

async function detect(context: HardwareContext): Promise<HardwareResult> {
  const version = await getvar(context, "version");
  let allSupported = true;
  let all: Record<string, string> = {};
  try {
    const terminal = await command(context, "getvar:all");
    all = getvarAll(terminal.infos);
  } catch (error) {
    if (!(error instanceof FastbootCommandFailure)) throw error;
    allSupported = false;
    context.progress({ phase: "detect", message: "Fastboot getvar:all is not supported by this bootloader." });
  }
  return {
    summary: `Fastboot ${version || "device"} detected.${allSupported ? " getvar:all completed." : " getvar:all is not supported by this bootloader."}`,
    details: { version, variables: all, getvarAll: allSupported },
  };
}

async function dump(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  const target = requireTarget(request.target);
  const offset = request.offset ?? 0;
  const capability = await readbackCapability(context, target);
  const length = request.length ?? capability.partitionSize - offset;
  if (!Number.isSafeInteger(length) || length <= 0) throw new FastbootProtocolError("Fastboot dump length must be a positive integer.");
  await context.confirm({
    action: "fastboot dump",
    target,
    offset,
    length,
    backup: "not applicable: read-only Fastboot fetch",
  });
  const saved = await saveChunks(context,fetchChunks(context,target,offset,length,capability),length,`${target}.bin`);
  return { summary:`Read ${length} bytes from Fastboot ${target}.`,verified:true,sha256:saved.sha256,fileId:saved.fileId,details:{offset,length} };
}

function protectedOverride(target:string):string|undefined {
  const protection=classifyProtectedRegionName(target);
  if (protection) return "write:"+target;
  return /^(?:rpmb|gpt|pgpt|sgpt|boot[01]|mmcblk\d+boot[01])(?:[_:-].*)?$/i.test(target) ? "write:"+target : undefined;
}

/** What was learned and escrowed about a partition before it is overwritten. */
interface PartitionBackup {
  readonly partitionSize:number|undefined;
  /** Present when the bootloader supports exact fetch readback. */
  readonly capability:FastbootReadback|undefined;
  readonly backupId:string|undefined;
  /** The sentence shown in the confirmation: where the backup is, or why there is none. */
  readonly backup:string;
}

async function backupPartition(context:HardwareContext,target:string):Promise<PartitionBackup> {
  const info=await inspectPartition(context,target);
  if (!info.capability) return {...info,backupId:undefined,backup:"Backup unavailable: this bootloader does not support exact fetch readback. Back up with TWRP/ADB before continuing."};
  const saved=await saveChunks(context,fetchChunks(context,target,0,info.capability.partitionSize,info.capability),info.capability.partitionSize,target+".preflash.bin");
  return {...info,backupId:saved.fileId,backup:"Saved full "+target+" backup as "+saved.fileId+" (sha256 "+saved.sha256+")."};
}

async function verifyImage(context:HardwareContext,target:string,input:Blob,plan:ImageFootprint,capability:FastbootReadback):Promise<void> {
  for (const extent of plan.extents) {
    if (!extent.length) continue;
    const actual=incrementalSha256.create(), expected=incrementalSha256.create();
    try {
      for await (const data of fetchChunks(context,target,extent.offset,extent.length,capability)) actual.update(data);
      let expectedHash:string;
      if (extent.fill) {
        const fill=new Uint8Array(65536); for(let i=0;i<fill.length;i+=4) fill.set(extent.fill,i);
        for(let left=extent.length;left>0;left-=fill.length) expected.update(fill.subarray(0,Math.min(left,fill.length)));
        expectedHash=bytesToHex(expected.digest());
      } else expectedHash=await hashBlob(input.slice(extent.dataOffset!,extent.dataOffset!+extent.length));
      if(bytesToHex(actual.digest())!==expectedHash) throw new FastbootProtocolError("Fastboot readback SHA-256 mismatch at "+target+" offset "+extent.offset+". The device has been written; no retry was attempted.");
    } finally {actual.destroy();expected.destroy();}
  }
}

/** `max-download-size` as fastboot reads it: decimal, or hex with a 0x prefix. Zero means unreported or unreadable. */
function parseDownloadLimit(value:string|undefined):number {
  const text=value?.trim();
  if (!text) return 0;
  const parsed=/^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text,16) : /^\d+$/.test(text) ? Number.parseInt(text,10) : 0;
  return Number.isSafeInteger(parsed) && parsed>0 ? parsed : 0;
}

/** Everything decided about writing one image to one partition before anything is approved. */
interface PartitionFlash {
  readonly target:string;
  readonly image:Blob;
  readonly digest:string;
  readonly footprint:ImageFootprint;
  readonly backup:PartitionBackup;
  /** Present when the image is larger than the device's max-download-size. */
  readonly split?:SparseSplit;
}

async function prepareFlash(context:HardwareContext,target:string,image:Blob,limit:number):Promise<PartitionFlash> {
  const footprint=await imageFootprint(image), digest=await hashBlob(image);
  // Like fastboot's get_sparse_limit: only an image larger than the reported limit is resparsed, into pieces of at most 1 GiB.
  const split=limit>0 && image.size>limit ? await planImageSplit(image,Math.min(limit,MAX_RESPARSE_PIECE_BYTES)) : undefined;
  const backup=await backupPartition(context,target);
  if (backup.partitionSize && footprint.length>backup.partitionSize) throw new FastbootProtocolError("Image expanded size exceeds the reported partition size.");
  return {target,image,digest,footprint,backup,split};
}

/**
 * Sends the image (as one download, or as sparse pieces in turn) and flashes it.
 * A failed piece is never retried. `onFlashSent` runs just before each `flash:`
 * command goes out: from then on the partition may be modified, whatever the
 * bootloader answers or fails to answer.
 */
async function writeFlash(context:HardwareContext,flash:PartitionFlash,onFlashSent:()=>void=()=>undefined):Promise<void> {
  if (!flash.split) { await download(context,flash.image); onFlashSent(); await command(context,"flash:"+flash.target); return; }
  const {layout,pieces}=flash.split;
  for (let index=0;index<pieces.length;index+=1) {
    const label=`piece ${index+1} of ${pieces.length}`;
    try {
      await download(context,buildSparsePiece(flash.image,layout,pieces[index]!),label);
      onFlashSent();
      await command(context,"flash:"+flash.target);
    } catch (error) {
      throwIfAborted(context.signal);
      throw new FastbootProtocolError(`Sparse ${label} failed after ${index} piece(s) were written to ${flash.target}: ${error instanceof Error ? error.message : String(error)} The partition is partly written; nothing was retried.`);
    }
  }
}

function flashDetails(chip:string|undefined,flash:PartitionFlash):string {
  return [
    "Product: "+(chip||"unreported")+". Partition size: "+(flash.backup.partitionSize??"unreported")+". Expanded image bytes: "+flash.footprint.length+".",
    ...(flash.split ? [`The image is larger than the device's max-download-size, so it is sent as ${flash.split.pieces.length} sparse pieces that are flashed in turn.`] : []),
    !flash.backup.capability ? "UNVERIFIED WRITE: this bootloader has no fetch readback. An OKAY response is not verification. Reboot to TWRP and verify the written bytes over ADB afterwards." : "The full partition is backed up. Readback will verify the image-defined bytes; sparse skip regions and bytes beyond the image are not assumed preserved.",
  ].join(" ");
}

async function flash(request:HardwareRequest,context:HardwareContext):Promise<HardwareResult> {
  const target=requireTarget(request.target);
  if ((request.offset??0)!==0) throw new FastbootProtocolError("The Fastboot flash protocol addresses named partitions, not a nonzero byte offset.");
  const input=context.input;
  if (!input?.size) throw new FastbootProtocolError("Fastboot flash requires a nonempty image.");
  const expected=parseFlashSafety(request.options);
  const chip=await optionalGetvar(context,"product");
  if(expected.expectedChip && expected.expectedChip.toLowerCase()!==chip?.trim().toLowerCase()) throw new FastbootProtocolError("Fastboot product does not match expectedChip.");
  const prepared=await prepareFlash(context,target,input,parseDownloadLimit(await optionalGetvar(context,"max-download-size")));
  const unverified=!prepared.backup.capability;
  await context.confirm({action:"fastboot flash",target,offset:0,length:input.size,sha256:prepared.digest,backup:prepared.backup.backup,protectedOverride:protectedOverride(target),details:flashDetails(chip,prepared)});
  await writeFlash(context,prepared);
  if(prepared.backup.capability) await verifyImage(context,target,input,prepared.footprint,prepared.backup.capability);
  return {summary:unverified ? "Fastboot accepted the write to "+target+". UNVERIFIED: use ADB verify in recovery before booting it." : "Flashed and verified the image-defined bytes in Fastboot "+target+".",verified:!unverified,sha256:prepared.digest,details:{chip,backupId:prepared.backup.backupId,partitionSize:prepared.backup.partitionSize,length:prepared.footprint.length,sparse:prepared.footprint.sparse,skippedBytes:prepared.footprint.skipped,pieces:prepared.split?.pieces.length??1,followup:unverified ? "Boot TWRP, locate "+target+" in /dev/block/by-name, then device_verify the image byte range using this SHA-256. Sparse images require expanded-image verification, not the compressed file hash." : undefined}};
}

/** The data the previous command left staged in the bootloader (`fastboot get_staged`; the protocol's `upload`). */
async function getStaged(context:HardwareContext):Promise<HardwareResult> {
  await context.confirm({action:"fastboot get_staged",target:"staged data",backup:"Not applicable: read-only; nothing is written to the device.",details:"Reads back the data the previous command left staged in the bootloader, for example the output of an oem command."});
  throwIfAborted(context.signal);
  await context.transport.write(requireCommand("upload"),context.signal);
  let reply=await readResponse(context);
  while (reply.type==="INFO") { context.output?.(reply.message+"\n"); reply=await readResponse(context); }
  if (reply.type==="FAIL") throw new FastbootCommandFailure(`Fastboot has no staged data to read: ${reply.message||"unspecified failure"}.`);
  if (reply.type!=="DATA") throw new FastbootProtocolError("Fastboot did not announce staged data in answer to upload.");
  const size=reply.size;
  if (size<=0 || size>MAX_STAGED_UPLOAD_BYTES) throw new FastbootProtocolError(`Fastboot announced ${size} staged bytes; Cody reads from 1 to ${MAX_STAGED_UPLOAD_BYTES}.`);
  async function* chunks():AsyncGenerator<Uint8Array<ArrayBuffer>> {
    for (let offset=0;offset<size;) {
      const wanted=Math.min(UPLOAD_CHUNK_BYTES,size-offset);
      yield await readExact(context.transport,wanted,deadline("Fastboot staged upload",FASTBOOT_TIMEOUT_MS),context.signal);
      offset+=wanted; context.progress({phase:"upload",completed:offset,total:size});
    }
  }
  const saved=await saveChunks(context,chunks(),size,"fastboot-staged.bin");
  await readTerminal(context);
  return {summary:`Read ${size} staged bytes from Fastboot.`,sha256:saved.sha256,fileId:saved.fileId,details:{length:size}};
}

/**
 * `fastboot update` / `flashall`: flashes the images of an update package after
 * one approval. The package's android-info.txt must be met by this device; every
 * partition is backed up (when the bootloader can fetch) before the approval, is
 * written once, and is read back before the next one starts.
 */
async function updateFromPackage(context:HardwareContext):Promise<HardwareResult> {
  const archive=context.input;
  if (!archive?.size) throw new FastbootProtocolError("Fastboot update needs a package artifact: a ZIP holding android-info.txt and the partition images.");
  const zip=await openZip(archive).catch((error:unknown)=>{throw new FastbootProtocolError(`The selected file is not an update package: ${error instanceof Error ? error.message : String(error)}`);});
  const infoEntry=zip.find("android-info.txt");
  if (!infoEntry) throw new FastbootProtocolError("The package has no android-info.txt, so Cody cannot confirm its images are for this device (fastboot update refuses this too). Flash single images with device_flash instead.");
  // The package metadata is read into a string before anything is approved, so it
  // gets its own small bound (never the firmware-image limits) and a cap on how
  // many requirements the device will be asked about.
  const info=parseAndroidInfo(await zip.text(infoEntry,MAX_ANDROID_INFO_BYTES).catch((error:unknown)=>{throw new FastbootProtocolError(`The package's android-info.txt cannot be read: ${error instanceof Error ? error.message : String(error)} Nothing was written.`);}));
  if (info.requirements.length>MAX_ANDROID_INFO_REQUIREMENTS) throw new FastbootProtocolError(`The package's android-info.txt lists ${info.requirements.length} requirements; Cody reads at most ${MAX_ANDROID_INFO_REQUIREMENTS} (a real one has a handful). Nothing was written.`);
  const product=(await optionalGetvar(context,"product"))?.trim();
  const unmet=(await checkRequirements(info,product,(name)=>optionalGetvar(context,name))).filter((outcome)=>!outcome.met);
  if (unmet.length>0) throw new FastbootProtocolError(`This package is not for this device, so nothing was written: ${unmet.map((outcome)=>`${outcome.line} (${outcome.detail})`).join("; ")}.`);
  const present=UPDATE_IMAGES.flatMap((image)=>{const entry=zip.find(image.file);return entry ? [{partition:image.partition,entry}] : [];});
  // AOSP treats partition-exists as a package requirement too: it cannot be
  // satisfied by merely discovering the partition on the device. Like its
  // HandlePartitionExists, only the first value names the partition.
  for (const requirement of info.requirements.filter((item) => item.name === "partition-exists")) {
    const partition = requirement.options[0]!;
    if (!UPDATE_IMAGES.some((image) => image.partition === partition)) throw new FastbootProtocolError(`The package requires unsupported partition ${partition}; nothing was written.`);
    if (!present.some((image) => image.partition === partition)) throw new FastbootProtocolError(`The package requires partition ${partition}, but contains no ${partition}.img; nothing was written.`);
  }
  if (present.length===0) {
    const nested=zip.entries.find((entry)=>/^image-.*\.zip$/.test(entry.name));
    throw new FastbootProtocolError(nested ? `The package holds no partition images, but it contains ${nested.name}: that inner ZIP is what fastboot update flashes. Extract it and select it instead.` : "The package holds none of the images fastboot update flashes (boot.img, system.img, vendor.img, ...).");
  }
  const limit=parseDownloadLimit(await optionalGetvar(context,"max-download-size"));
  const slot=(await optionalGetvar(context,"current-slot"))?.trim().replace(/^_/,"");
  const userspace=(await optionalGetvar(context,"is-userspace"))?.trim()==="yes";
  const targets:{target:string;entry:ZipEntry}[]=[];
  for (const image of present) {
    const slotted=(await optionalGetvar(context,"has-slot:"+image.partition))?.trim()==="yes";
    if (slotted && !slot) throw new FastbootProtocolError(`${image.partition} has A/B slots but the device did not report current-slot, so Cody cannot choose the slot to flash.`);
    const target=requireTarget(slotted ? `${image.partition}_${slot}` : image.partition);
    if (!userspace && (await optionalGetvar(context,"is-logical:"+target))?.trim()==="yes") {
      throw new FastbootProtocolError(`${target} is a logical partition, which only userspace fastboot (fastbootd) can write. Reboot the device to fastbootd (reboot-fastboot), select it again in Devices, and run the update again. Nothing was written.`);
    }
    targets.push({target,entry:image.entry});
  }
  const prepared:PartitionFlash[]=[];
  for (const {target,entry} of targets) {
    context.progress({phase:"prepare",completed:prepared.length,total:targets.length,message:`Reading ${entry.name} and backing up ${target}`});
    prepared.push(await prepareFlash(context,target,await zip.open(entry),limit));
  }
  const digest=await hashBlob(archive);
  const unbacked=prepared.filter((flash)=>!flash.backup.capability).map((flash)=>flash.target);
  await context.confirm({
    action:"fastboot update",
    target:`update package, ${prepared.length} partition(s): ${prepared.map((flash)=>flash.target).join(", ")}`,
    sha256:digest,offset:0,length:archive.size,
    backup:unbacked.length===0 ? `Every partition is backed up in full before it is overwritten: ${prepared.map((flash)=>flash.backup.backupId).join(", ")}.` : `Backup unavailable for ${unbacked.length} of ${prepared.length} partition(s) (${unbacked.join(", ")}): this bootloader has no fetch readback, so they are written UNVERIFIED.`,
    protectedOverride:`update:${digest.slice(0,8)}`,
    details:[
      `Product: ${product||"unreported"}. The package's android-info.txt requirements (${info.requirements.length}) are all met by this device.`,
      ...prepared.map((flash)=>`${flash.target}: ${flash.footprint.length} bytes${flash.split ? ` in ${flash.split.pieces.length} sparse pieces` : ""}, sha256 ${flash.digest}, ${flash.backup.capability ? `backup ${flash.backup.backupId}, readback verified` : "NO BACKUP, UNVERIFIED"}`),
      "Partitions are written one after another and each is read back when the bootloader supports it. The first failure stops the update and leaves the later partitions untouched.",
      `Not flashed by update: ${SKIPPED_BY_UPDATE.filter((name)=>zip.find(name)).join(", ")||"nothing"} (flash those separately if you want them).`,
    ].join("\n"),
  });
  // Three states, never two: written (and read back when the bootloader can),
  // untouched, and the one partition a flash command was sent to but that has
  // not been verified - the one that most needs recovery if the update stops.
  const written:PartitionFlash[]=[];
  let inFlight:PartitionFlash|undefined;
  try {
    for (const flash of prepared) {
      context.progress({phase:"flash",completed:written.length,total:prepared.length,message:`Flashing ${flash.target}`});
      await writeFlash(context,flash,()=>{inFlight=flash;});
      if (flash.backup.capability) await verifyImage(context,flash.target,flash.image,flash.footprint,flash.backup.capability);
      written.push(flash);
      inFlight=undefined;
      // A cancel that arrived while the last readback was being hashed leaves the loop with nothing thrown: without this
      // check the operation would end as if the update had not happened, with no accounting and the result discarded.
      throwIfAborted(context.signal);
    }
  } catch (error) {
    const names=(flashes:readonly PartitionFlash[])=>flashes.map((flash)=>flash.target).join(", ")||"none";
    // Assigned inside writeFlash's callback, which control-flow analysis cannot see.
    const suspect=inFlight as PartitionFlash|undefined;
    const untouched=prepared.filter((flash)=>flash!==suspect && !written.includes(flash));
    const unverifiable=written.filter((flash)=>!flash.backup.capability);
    const stoppedAt=suspect?.target??untouched[0]?.target;
    const cancelled=context.signal.aborted;
    const account=[
      cancelled
        ? `The update was cancelled ${suspect ? `while ${suspect.target} was being flashed or verified` : stoppedAt ? `before ${stoppedAt} was flashed` : "after every partition was handled"}.`
        : `The update stopped at ${stoppedAt}: ${error instanceof Error ? error.message : String(error)}`,
      `Written and verified: ${names(written.filter((flash)=>flash.backup.capability))}.`,
      ...(unverifiable.length>0 ? [`Written but not verifiable (no fetch readback): ${names(unverifiable)}.`] : []),
      ...(suspect ? [`POSSIBLY MODIFIED (a flash command was sent and the result is not verified): ${suspect.target}; ${suspect.backup.backupId ? `its previous contents are saved as ${suspect.backup.backupId}` : "no backup of it exists, because this bootloader cannot read partitions"}.`] : []),
      `Untouched: ${names(untouched)}.`,
      "Nothing was retried.",
    ];
    // A cancel (the user's, or a USB disconnect, which cancels) leaves no error in the operation's record, and it is exactly
    // when the operator may need to recover a partition: the accounting goes to the retained output before the cancel goes on.
    if (cancelled) {
      context.output?.(`Partitions of this update and the backup taken of each before it was written: ${prepared.map((flash)=>`${flash.target} (${flash.backup.backupId ? `backup ${flash.backup.backupId}` : "no backup, this bootloader cannot read partitions"})`).join(", ")}.`);
      for (const line of account) context.output?.(line);
      throwIfAborted(context.signal);
    }
    throw new FastbootProtocolError(account.join(" "));
  }
  return {
    summary:unbacked.length===0 ? `Flashed ${prepared.length} partition(s) from the package and verified each by readback.` : `Flashed ${prepared.length} partition(s) from the package; ${unbacked.join(", ")} could not be read back and are UNVERIFIED.`,
    verified:unbacked.length===0,
    sha256:digest,
    details:{product,slot,partitions:prepared.map((flash)=>({partition:flash.target,bytes:flash.footprint.length,sha256:flash.digest,pieces:flash.split?.pieces.length??1,backupId:flash.backup.backupId,verified:Boolean(flash.backup.capability)})),notFlashed:SKIPPED_BY_UPDATE.filter((name)=>zip.find(name))},
  };
}

async function execute(request:HardwareRequest,context:HardwareContext):Promise<HardwareResult> {
  const value=(request.command??"").trim().replace(/^fastboot\s+/,"");
  requireCommand(value);
  const get=/^getvar(?::|\s+)(.+)$/.exec(value);
  if(get) { const reply=await command(context,"getvar:"+get[1]);return {summary:[...reply.infos,reply.okay].join("\n")||"getvar completed.",details:{...reply}}; }
  const flashTarget=/^flash(?::|\s+)(.+)$/.exec(value);
  if(value==="flash"||flashTarget) return flash({...request,action:"flash",target:flashTarget?.[1]??request.target},context);
  if(value==="download"||value==="stage"||value==="boot") {
    if(!context.input?.size) throw new FastbootProtocolError("Fastboot "+value+" needs an image artifact.");
    const digest=await hashBlob(context.input);
    await context.confirm({action:"fastboot "+value,target:value==="boot"?"temporary boot image":value==="stage"?"fastboot-staging-buffer":"fastboot-download-buffer",sha256:digest,offset:0,length:context.input.size,backup:"Not applicable: image is loaded into RAM. A booted image can itself change storage.",details:value==="boot"?"Execute the uploaded boot image without flashing a partition.":value==="stage"?"Stage the uploaded file in the bootloader for the next command to consume, for example an oem command.":"Stage the uploaded image in the volatile download buffer."});
    await download(context,context.input);if(value==="boot")await command(context,"boot");
    return {summary:"Fastboot accepted "+value+".",verified:false,sha256:digest,details:{length:context.input.size}};
  }
  if(value==="get_staged"||value==="upload") return getStaged(context);
  if(/^(?:update|flashall)(?:\s|$)/.test(value)) {
    if(!/^(?:update|flashall)$/.test(value)) throw new FastbootProtocolError("update and flashall take no arguments here: the package is the selected file, and -w, --force and slot options are not offered. Use erase and set_active as separate commands.");
    return updateFromPackage(context);
  }
  const eraseTarget=/^erase(?::|\s+)(.+)$/.exec(value);
  if(value==="erase"||eraseTarget) {
    const target=requireTarget(eraseTarget?.[1]??request.target), info=await backupPartition(context,target);
    await context.confirm({action:"fastboot erase",target,length:info.partitionSize,backup:info.backup,protectedOverride:protectedOverride(target),details:"Erase the exact named partition. This is destructive; no erase pattern is assumed and the result is not byte-verified."});
    await command(context,"erase:"+target); return {summary:"Fastboot accepted erase of "+target+".",verified:false,details:{backupId:info.backupId}};
  }
  const active=/^set_active(?::|\s+)(.+)$/.exec(value);
  if(value==="set_active"||active) {
    const slot=requireTarget(active?.[1]??request.target,"slot");
    await context.confirm({action:"fastboot set_active",target:slot,backup:"Not applicable: active-slot selection is reversible."});
    await command(context,"set_active:"+slot);const current=await optionalGetvar(context,"current-slot");
    if(current!==undefined && current.trim()!==slot) throw new FastbootProtocolError("Device reported a different active slot: "+current);
    return {summary:"Selected active slot "+slot+".",verified:current!==undefined,details:{currentSlot:current}};
  }
  if(/^format(?::|\s|$)/.test(value)) throw new FastbootProtocolError("fastboot format is a host filesystem-image generator, not a bootloader command. Upload an ext4/F2FS filesystem image and flash it; Cody does not yet generate filesystem images.");
  const wire=value.replace(/^reboot\s+(\S+)$/,"reboot-$1");
  const reboot=/^reboot(?:-[A-Za-z0-9_-]+)?$/.test(wire);
  await context.confirm({action:"fastboot command",target:wire,backup:reboot?"Not applicable: reboot changes mode.":"No automatic backup: vendor/unlock commands can wipe data or alter security state. Use partition backup first if the device supports fetch.",protectedOverride:reboot?undefined:"fastboot "+wire,details:reboot?"Switch device mode; reconnect after USB re-enumerates.":"Run this exact bootloader command. OEM and flashing unlock/lock commands may irreversibly alter boot security or erase all user data."});
  const result=await command(context,wire);
  return {summary:[...result.infos,result.okay].join("\n")||"Fastboot accepted "+wire+".",verified:false,details:{...result}};
}


async function runFastboot(request: HardwareRequest, context: HardwareContext) {
  requireUsb(context.transport);
  switch (request.action) {
    case "detect": return detect(context);
    case "dump": return dump(request, context);
    case "flash": return flash(request, context);
    case "exec": return execute(request, context);
    default: throw new FastbootProtocolError(`Fastboot does not support ${request.action}.`);
  }
}

export const fastbootFlasher: Flasher = {
  protocol: "fastboot",
  actions: ["detect", "flash", "dump", "exec"],
  run: runFastboot,
};
