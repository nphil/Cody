import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport } from "./flasher";
import { classifyProtectedRegionName, parseFlashSafety } from "./hardware-safety";
import { hashBlob } from "./blob-stream";
import { imageFootprint, type ImageFootprint } from "./sparse-image";
import { sha256 as incrementalSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deadline, readExact, throwIfAborted } from "./serial";
const FETCH_CHUNK_BYTES = 4 * 1024 * 1024;

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

async function saveFetch(context: HardwareContext, target:string, offset:number, length:number, capability:FastbootReadback, name:string) {
  const chunks=fetchChunks(context,target,offset,length,capability);
  if (context.saveStream) return context.saveStream(name,chunks);
  // Small direct Flasher consumers may provide Blob escrow only. The browser manager streams.
  if (length>8*1024*1024) throw new FastbootProtocolError("This client must provide streaming artifact escrow for this backup.");
  const data:Uint8Array<ArrayBuffer>[]=[]; for await(const chunk of chunks) data.push(chunk);
  const blob=new Blob(data); return {fileId:await context.save(name,blob),sha256:await hashBlob(blob),length};
}

async function download(context: HardwareContext, firmware:Blob):Promise<void> {
  if (!firmware.size || firmware.size>0xffffffff) throw new FastbootProtocolError("One Fastboot download must contain 1 through 0xffffffff bytes; larger images need host-side sparse splitting.");
  await context.transport.write(requireCommand("download:"+firmware.size.toString(16).padStart(8,"0")),context.signal);
  const response=await readResponse(context);
  if(response.type==="FAIL") throw new FastbootCommandFailure(response.message);
  if(response.type!=="DATA" || response.size!==firmware.size) throw new FastbootProtocolError("Fastboot did not acknowledge the exact download byte count.");
  const reader=firmware.stream().getReader(); let completed=0;
  try { for (;;) { context.signal.throwIfAborted(); const next=await reader.read(); if(next.done)break; await context.transport.write(next.value,context.signal); completed+=next.value.length; context.progress({phase:"download",completed,total:firmware.size}); } }
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
  const saved = await saveFetch(context,target,offset,length,capability,`${target}.bin`);
  return { summary:`Read ${length} bytes from Fastboot ${target}.`,verified:true,sha256:saved.sha256,fileId:saved.fileId,details:{offset,length} };
}

function protectedOverride(target:string):string|undefined {
  const protection=classifyProtectedRegionName(target);
  if (protection) return "write:"+target;
  return /^(?:rpmb|gpt|pgpt|sgpt|boot[01]|mmcblk\d+boot[01])(?:[_:-].*)?$/i.test(target) ? "write:"+target : undefined;
}

async function backupPartition(context:HardwareContext,target:string) {
  const info=await inspectPartition(context,target);
  if (!info.capability) return {...info,backup:"Backup unavailable: this bootloader does not support exact fetch readback. Back up with TWRP/ADB before continuing."};
  const saved=await saveFetch(context,target,0,info.capability.partitionSize,info.capability,target+".preflash.bin");
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

async function flash(request:HardwareRequest,context:HardwareContext):Promise<HardwareResult> {
  const target=requireTarget(request.target);
  if ((request.offset??0)!==0) throw new FastbootProtocolError("The Fastboot flash protocol addresses named partitions, not a nonzero byte offset.");
  const input=context.input;
  if (!input?.size) throw new FastbootProtocolError("Fastboot flash requires a nonempty image.");
  const expected=parseFlashSafety(request.options);
  const chip=await optionalGetvar(context,"product");
  if(expected.expectedChip && expected.expectedChip.toLowerCase()!==chip?.trim().toLowerCase()) throw new FastbootProtocolError("Fastboot product does not match expectedChip.");
  const plan=await imageFootprint(input), digest=await hashBlob(input);
  const info=await backupPartition(context,target);
  if (info.partitionSize && plan.length>info.partitionSize) throw new FastbootProtocolError("Image expanded size exceeds the reported partition size.");
  const unverified=!info.capability;
  await context.confirm({action:"fastboot flash",target,offset:0,length:input.size,sha256:digest,backup:info.backup,protectedOverride:protectedOverride(target),details:[
    "Product: "+(chip||"unreported")+". Partition size: "+(info.partitionSize??"unreported")+". Expanded image bytes: "+plan.length+".",
    unverified ? "UNVERIFIED WRITE: this bootloader has no fetch readback. An OKAY response is not verification. Reboot to TWRP and verify the written bytes over ADB afterwards." : "The full partition is backed up. Readback will verify the image-defined bytes; sparse skip regions and bytes beyond the image are not assumed preserved.",
  ].join(" ")});
  await download(context,input); await command(context,"flash:"+target);
  if(info.capability) await verifyImage(context,target,input,plan,info.capability);
  return {summary:unverified ? "Fastboot accepted the write to "+target+". UNVERIFIED: use ADB verify in recovery before booting it." : "Flashed and verified the image-defined bytes in Fastboot "+target+".",verified:!unverified,sha256:digest,details:{chip,backupId:info.backupId,partitionSize:info.partitionSize,length:plan.length,sparse:plan.sparse,skippedBytes:plan.skipped,followup:unverified ? "Boot TWRP, locate "+target+" in /dev/block/by-name, then device_verify the image byte range using this SHA-256. Sparse images require expanded-image verification, not the compressed file hash." : undefined}};
}

async function execute(request:HardwareRequest,context:HardwareContext):Promise<HardwareResult> {
  const value=(request.command??"").trim().replace(/^fastboot\s+/,"");
  requireCommand(value);
  const get=/^getvar(?::|\s+)(.+)$/.exec(value);
  if(get) { const reply=await command(context,"getvar:"+get[1]);return {summary:[...reply.infos,reply.okay].join("\n")||"getvar completed.",details:{...reply}}; }
  const flashTarget=/^flash(?::|\s+)(.+)$/.exec(value);
  if(value==="flash"||flashTarget) return flash({...request,action:"flash",target:flashTarget?.[1]??request.target},context);
  if(value==="download"||value==="boot") {
    if(!context.input?.size) throw new FastbootProtocolError("Fastboot "+value+" needs an image artifact.");
    const digest=await hashBlob(context.input);
    await context.confirm({action:"fastboot "+value,target:value==="boot"?"temporary boot image":"fastboot-download-buffer",sha256:digest,offset:0,length:context.input.size,backup:"Not applicable: image is loaded into RAM. A booted image can itself change storage.",details:value==="boot"?"Execute the uploaded boot image without flashing a partition.":"Stage the uploaded image in the volatile download buffer."});
    await download(context,context.input);if(value==="boot")await command(context,"boot");
    return {summary:"Fastboot accepted "+value+".",verified:false,sha256:digest,details:{length:context.input.size}};
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
