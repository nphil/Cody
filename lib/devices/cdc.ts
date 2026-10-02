import type { HardwareTransport } from "./flasher";

/** CDC Union functional descriptors bind the control interface to data interfaces. */
export function cdcUnionControl(bytes: Uint8Array, dataInterface: number): number {
  const matches = new Set<number>();
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes[offset]!;
    if (length < 2 || offset + length > bytes.length) throw new Error("Malformed USB configuration descriptor.");
    if (bytes[offset + 1] === 0x24 && bytes[offset + 2] === 6 && length >= 5) {
      for (let i = offset + 4; i < offset + length; i++) if (bytes[i] === dataInterface) matches.add(bytes[offset + 3]!);
    }
    offset += length;
  }
  if (matches.size !== 1) throw new Error("The selected CDC data interface has no unique Union control interface.");
  return [...matches][0]!;
}

export async function cdcControlInterface(device: USBDevice, dataInterface: number): Promise<number> {
  const configuration = device.configuration;
  if (!configuration) throw new Error("CDC requires an active USB configuration.");
  const controls = configuration.interfaces.filter(iface => iface.alternates.some(alt => alt.interfaceClass === 2 && alt.interfaceSubclass === 2));
  const data = configuration.interfaces.filter(iface => iface.alternates.some(alt => alt.interfaceClass === 0x0a));
  if (controls.length === 1 && data.length === 1 && data[0]!.interfaceNumber === dataInterface) return controls[0]!.interfaceNumber;
  const index = device.configurations.findIndex(candidate => candidate.configurationValue === configuration.configurationValue);
  if (index < 0) throw new Error("Active CDC configuration is not listed by the device.");
  const setup: USBControlTransferParameters = { requestType: "standard", recipient: "device", request: 6, value: 0x200 | index, index: 0 };
  const header = await device.controlTransferIn(setup, 9);
  if (header.status !== "ok" || !header.data || header.data.byteLength < 9) throw new Error("Could not read CDC configuration header.");
  const result = await device.controlTransferIn(setup, header.data.getUint16(2, true));
  if (result.status !== "ok" || !result.data) throw new Error("Could not read CDC configuration descriptors.");
  const control = cdcUnionControl(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength), dataInterface);
  if (!controls.some(iface => iface.interfaceNumber === control)) throw new Error("CDC Union names an interface which is not an ACM control interface.");
  return control;
}

/** Adapt only a descriptor-identified CDC pair, never arbitrary USB bulk endpoints. */
export function cdcSerialTransport(raw: HardwareTransport, controlInterface: number): HardwareTransport {
  if (!raw.controlOut) throw new Error("CDC requires USB control transfers.");
  const idle = new AbortController().signal;
  let dtr = false, rts = false;
  const transfer = (request: number, value: number, bytes: Uint8Array, signal = idle) => raw.controlOut!({ requestType: "class", recipient: "interface", request, value, index: controlInterface }, bytes, signal);
  return {
    ...raw,
    kind: "serial",
    async setBaudRate(baudRate, signal) {
      if (!Number.isInteger(baudRate) || baudRate < 1 || baudRate > 0xffffffff) throw new Error("CDC baud rate must fit its unsigned 32-bit line-coding field.");
      const bytes = new Uint8Array(7);
      new DataView(bytes.buffer).setUint32(0, baudRate, true);
      bytes[6] = 8; // one stop bit, no parity, eight data bits
      await transfer(0x20, 0, bytes, signal);
    },
    async setSignals(signals, signal) {
      if (signals.dtr !== undefined || signals.rts !== undefined) {
        const nextDtr = signals.dtr ?? dtr, nextRts = signals.rts ?? rts;
        await transfer(0x22, Number(nextDtr) | (Number(nextRts) << 1), new Uint8Array(), signal);
        dtr = nextDtr; rts = nextRts;
      }
      if (signals.brk !== undefined) await transfer(0x23, signals.brk ? 0xffff : 0, new Uint8Array(), signal);
    },
  };
}
