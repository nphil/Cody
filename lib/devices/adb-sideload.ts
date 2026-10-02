import type { Adb } from "@yume-chan/adb";
import { Consumable } from "@yume-chan/stream-extra";
import type { HardwareContext, HardwareRequest, HardwareResult } from "./flasher";
import { hashFirmware } from "./hardware-safety";

const BLOCK_SIZE = 65536;
/** AOSP sideload-host protocol: the recovery asks for eight-digit block
 * numbers, including repeat/random reads, then sends DONEDONE. */
export async function sideloadAdb(request: HardwareRequest, context: HardwareContext, adb: Adb): Promise<HardwareResult> {
  const input = context.input;
  if (!input?.size) throw new Error("ADB sideload requires a non-empty session artifact.");
  const sha256 = await hashFirmware(input, request.sha256);
  await context.confirm({ action: "adb.sideload", target: request.target ?? "recovery installer", sha256, length: input.size, backup: "backup unavailable: recovery controls the partitions changed by this package; back them up before installing", details: "Install the selected package in recovery. The transfer hash does not verify installation or partition contents." });
  context.signal.throwIfAborted();
  const socket = await adb.createSocket("sideload-host:" + input.size + ":" + BLOCK_SIZE);
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let pending = "";
  let transferred = 0;
  try {
    for (;;) {
      context.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) throw new Error("Recovery disconnected before DONEDONE; installation outcome is unknown.");
      pending += new TextDecoder("ascii", { fatal: true }).decode(next.value);
      while (pending.length >= 8) {
        const command = pending.slice(0, 8); pending = pending.slice(8);
        if (command === "DONEDONE") return { summary: "Sideload transfer finished. Check the recovery screen for the installation result.", sha256, verified: false, details: { transferred, length: input.size, installationVerified: false } };
        if (!/^\d{8}$/.test(command)) throw new Error("Recovery sent an invalid sideload block request.");
        const offset = Number(command) * BLOCK_SIZE;
        if (offset >= input.size) throw new Error("Recovery requested a sideload block beyond the artifact.");
        const block = new Uint8Array(await input.slice(offset, offset + BLOCK_SIZE).arrayBuffer());
        await Consumable.WritableStream.write(writer, block);
        transferred += block.length;
        context.progress({ phase: "adb.sideload", completed: Math.min(input.size, transferred), total: input.size, message: "Served " + transferred + " bytes (recovery may reread blocks)" });
      }
    }
  } finally { reader.releaseLock(); writer.releaseLock(); await socket.close().catch(() => undefined); }
}
