import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { waitFor } from "./adb.test-helper.mjs";
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {DeviceOperationManager}=await jiti.import("./operations.ts");
function fixture(){
  const sent=[],signals=[],bauds=[];let initial=true;
  const manager=new DeviceOperationManager("serial-test",{async borrowHardwareTransport(){return {transport:{kind:"serial",async read(_length,_timeout,signal){if(initial){initial=false;return new TextEncoder().encode("\x1b[32mroot@cronos:/ # ");}return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new DOMException("Cancelled","AbortError")),{once:true}));},async write(data){sent.push(new Uint8Array(data));},async setBaudRate(baud){bauds.push(baud);},async setSignals(value){signals.push(value);}},async release(){}};}},{async getInput(){},async save(){}});
  return {manager,sent,signals,bauds};
}
test("serial terminal displays a prompt immediately without waiting for a newline",async()=>{
  const {manager}=fixture();const {id}=manager.startUser({deviceId:"cdc",protocol:"serial",action:"monitor"});
  try {await waitFor(()=>manager.status(id)?.output.some(row=>row.line.includes("root@cronos:/ #")));}
  finally{manager.cancel(id);}
});


test("disconnect waits for the active serial lease to be released",async()=>{
  let release, returned=false;
  const manager=new DeviceOperationManager("disconnect",{async borrowHardwareTransport(){return {transport:{kind:"serial",async read(_length,_timeout,signal){return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new DOMException("cancelled","AbortError")),{once:true}));},async write(){}},async release(){await new Promise(r=>{release=r;});}};}},{async getInput(){},async save(){}});
  const {id}=manager.startUser({protocol:"serial",action:"monitor",deviceId:"cdc"});await waitFor(()=>manager.status(id)?.progress?.phase==="monitoring");
  const disconnected=Promise.resolve(manager.deviceDisconnected("cdc")).then(()=>{returned=true;});
  try {await waitFor(()=>release);assert.equal(returned,false);}
  finally {release?.();await disconnected;}
});


test("user serial input, arbitrary baud, and line controls preserve exact bytes and stop after disconnect",async()=>{
  const {manager,sent,signals,bauds}=fixture();
  const {id}=manager.startUser({deviceId:"cdc",protocol:"serial",action:"monitor",baudRate:921600,options:{signals:{dtr:true,rts:false}}});
  await waitFor(()=>manager.status(id)?.progress?.phase==="monitoring");
  await manager.sendUser(id,"id\r\n");await manager.send(id,"\x03");await manager.setSignalsUser(id,{brk:true});await manager.setSignalsUser(id,{brk:false,rts:true});
  assert.deepEqual(bauds,[921600]);assert.deepEqual(sent.map(bytes=>[...bytes]),[[105,100,13,10],[3]]);
  assert.deepEqual(signals,[{dtr:true,rts:false},{brk:true},{brk:false,rts:true}]);
  await manager.deviceDisconnected("cdc");
  await assert.rejects(manager.sendUser(id,"no"),/not accepting/);await assert.rejects(manager.setSignalsUser(id,{dtr:false}),/closed/);
  assert.equal(manager.status(id).state,"cancelled");
});


