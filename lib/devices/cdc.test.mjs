import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {cdcUnionControl,cdcSerialTransport}=await jiti.import("./cdc.ts");
test("CDC Union pairing follows the descriptor, not neighboring interface numbers",()=>{
  const bytes=Uint8Array.from([9,2,19,0,4,1,0,0x80,50,5,0x24,6,7,2,5,0x24,6,9,4]);
  assert.equal(cdcUnionControl(bytes,2),7);assert.equal(cdcUnionControl(bytes,4),9);
  assert.throws(()=>cdcUnionControl(bytes,3),/no unique/);
  assert.throws(()=>cdcUnionControl(bytes.subarray(0,18),4),/Malformed/);
});
test("CDC line coding and DTR/RTS/break use the control interface while bulk data stays unchanged",async()=>{
  const control=[],written=[];
  const raw={kind:"usb",interfaceNumber:2,async controlOut(setup,bytes){control.push({setup,bytes:[...bytes]});},async write(bytes){written.push([...bytes]);},async read(){return Uint8Array.of(35,32);}};
  const serial=cdcSerialTransport(raw,7);await serial.setBaudRate(921600);await serial.setSignals({dtr:true});await serial.setSignals({rts:true});await serial.setSignals({brk:true});await serial.setSignals({brk:false});
  await serial.write(Uint8Array.of(105,100,10),new AbortController().signal);assert.deepEqual(written,[[105,100,10]]);assert.deepEqual([...(await serial.read())],[35,32]);
  assert.deepEqual(control.map(x=>[x.setup.request,x.setup.value,x.setup.index,x.bytes]),[[0x20,0,7,[0,16,14,0,0,0,8]],[0x22,1,7,[]],[0x22,3,7,[]],[0x23,65535,7,[]],[0x23,0,7,[]]]);
});
