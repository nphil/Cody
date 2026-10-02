import type { Flasher, HardwareContext } from "./flasher";
import { requireSerial, setBaudRate } from "./serial";
export type SerialSignals = { dtr?:boolean; rts?:boolean; brk?:boolean };
export function serialSignals(value:unknown):SerialSignals {
  if(typeof value!=="object" || value===null || Array.isArray(value)) throw new Error("Serial signals must be an object of dtr, rts, and brk booleans.");
  const result:SerialSignals={};
  for(const [key,flag] of Object.entries(value)) {
    if(!["dtr","rts","brk"].includes(key) || typeof flag!=="boolean") throw new Error("Serial signals accept only boolean dtr, rts, and brk values.");
    result[key as keyof SerialSignals]=flag;
  }
  if(!Object.keys(result).length) throw new Error("At least one serial signal is required.");
  return result;
}
async function applySignals(context:HardwareContext,value:unknown) {
  const signals=serialSignals(value);
  if(!context.transport.setSignals) throw new Error("This adapter does not expose DTR/RTS/break control.");
  context.signal.throwIfAborted(); await context.transport.setSignals(signals, context.signal);
}
export const serialFlasher:Flasher={protocol:"serial",actions:["monitor","exec"],async run(request,context) {
  requireSerial(context.transport);
  if(request.action==="exec") {
    if(request.command!=="signals" && request.command!=="baud") throw new Error("Serial exec supports signals (options.signals) and baud (baudRate).");
    if(request.command==="signals") serialSignals(request.options?.signals);
    if(request.command==="baud" && !request.baudRate) throw new Error("Serial baud needs baudRate.");
    await context.confirm({action:"serial "+request.command,target:request.target??"serial-port",backup:"Not applicable: line settings are reversible, but signal changes can reset the attached device.",details:request.command==="baud"?"Baud rate: "+request.baudRate:JSON.stringify(request.options?.signals)});
    if(request.command==="baud") await setBaudRate(context,request.baudRate);else await applySignals(context,request.options?.signals);
    return {summary:"Serial "+request.command+" applied.",verified:false};
  }
  if(request.action!=="monitor") throw new Error("Unsupported serial action: "+request.action);
  await setBaudRate(context,request.baudRate);
  if(request.options?.signals!==undefined) await applySignals(context,request.options.signals);
  context.progress({phase:"monitoring",message:"Serial terminal connected"});
  const decoder=new TextDecoder();
  while(!context.signal.aborted) {
    const bytes=await context.transport.read(4096,1000,context.signal);
    if(bytes) {const text=decoder.decode(bytes,{stream:true});if(text)context.output?.(text);}
  }
  throw new DOMException("Operation cancelled.","AbortError");
}};
