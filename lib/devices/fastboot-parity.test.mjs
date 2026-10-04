import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {fastbootFlasher}=await jiti.import("./fastboot.ts");
const {imageFootprint}=await jiti.import("./sparse-image.ts");
const b=(value)=>typeof value==="string"?new TextEncoder().encode(value):value;
const text=(bytes)=>new TextDecoder().decode(bytes);
const hash=(value)=>createHash("sha256").update(value).digest("hex");
function fixture(responses,extra={}) {
  const writes=[],risks=[],saved=[];
  return {signal:new AbortController().signal,transport:{kind:"usb",async read(){return responses.shift()??null;},async write(data){writes.push(new Uint8Array(data));}},writes,risks,saved,
    progress(){},async confirm(risk){risks.push(risk);},async save(name,data){saved.push({name,data});return name;},...extra};
}
const responses=(...items)=>items.map(b);
/** A bootloader's answer to getvar:max-download-size: 256 MiB, which no image in these tests approaches. */
const MAX="OKAY0x10000000";

test("no-fetch bootloader asks about an UNVERIFIED write before download and retains the image hash",async()=>{
  let release;
  const context=fixture(responses("OKAYcronos",MAX,"OKAY01000000","FAILunknown variable","DATA00000004","OKAY","OKAY"),{input:new Blob(["BOOT"]),async confirm(risk){this.risks.push(risk);await new Promise(r=>{release=r;});}});
  const pending=fastbootFlasher.run({protocol:"fastboot",action:"flash",target:"boot"},context);
  while(!release)await new Promise(r=>setTimeout(r,1));
  assert.deepEqual(context.writes.map(text),["getvar:product","getvar:max-download-size","getvar:partition-size:boot","getvar:fetch-size"]);
  assert.match(context.risks[0].details,/UNVERIFIED WRITE/);assert.match(context.risks[0].backup,/Backup unavailable/);
  assert.equal(context.risks[0].sha256,hash("BOOT"));assert.equal(context.risks[0].protectedOverride,undefined);
  release();const result=await pending;
  assert.equal(result.verified,false);assert.equal(result.sha256,hash("BOOT"));assert.match(result.details.followup,/device_verify/);
  assert.deepEqual(context.writes.slice(4).map(text),["download:00000004","BOOT","flash:boot"]);
});

test("a failed transport probe does not become permission for a no-fetch write",async()=>{
  const context=fixture(responses("OKAYcronos",MAX,"OKAY01000000"),{input:new Blob(["BOOT"])});
  await assert.rejects(fastbootFlasher.run({protocol:"fastboot",action:"flash",target:"boot"},context),/timed out/);
  assert.equal(context.risks.length,0);assert.equal(context.writes.some(data=>text(data).startsWith("download:")),false);
});

test("declining no-fetch confirmation never transfers the image",async()=>{
  const context=fixture(responses("OKAYcronos",MAX,"OKAY01000000","FAILunknown variable"),{input:new Blob(["BOOT"]),async confirm(){throw new DOMException("Declined","AbortError");}});
  await assert.rejects(fastbootFlasher.run({protocol:"fastboot",action:"flash",target:"boot"},context),/Declined/);
  assert.equal(context.writes.length,4);
});

test("protected logical partitions each demand their exact target override",async()=>{
  for(const target of ["preloader","lk_a","tee_b","rpmb","pgpt","boot0","boot1","efuse"]){
    const context=fixture(responses("OKAYcronos",MAX,"OKAY00000004","FAILunsupported","DATA00000004","OKAY","OKAY"),{input:new Blob(["BOOT"])});
    await fastbootFlasher.run({protocol:"fastboot",action:"flash",target},context);
    assert.equal(context.risks[0].protectedOverride,"write:"+target);
  }
});

test("partial raw image keeps a full backup and verifies the written image prefix",async()=>{
  const context=fixture(responses("OKAYcronos",MAX,"OKAY00000004","OKAY00000004","DATA00000004","old!","OKAY","DATA00000002","OKAY","OKAY","DATA00000002","hi","OKAY"),{input:new Blob(["hi"])});
  const result=await fastbootFlasher.run({protocol:"fastboot",action:"flash",target:"boot"},context);
  assert.equal(result.verified,true);assert.equal(await context.saved[0].data.text(),"old!");
  assert.equal(context.writes.map(text).at(-1),"fetch:boot:0:2");
});

function sparseImage(){
  const header=Buffer.alloc(28);header.writeUInt32LE(0xed26ff3a,0);header.writeUInt16LE(1,4);header.writeUInt16LE(28,8);header.writeUInt16LE(12,10);header.writeUInt32LE(4,12);header.writeUInt32LE(3,16);header.writeUInt32LE(3,20);
  const chunk=(type,data)=>{const h=Buffer.alloc(12);h.writeUInt16LE(type);h.writeUInt32LE(1,4);h.writeUInt32LE(12+data.length,8);return Buffer.concat([h,data]);};
  return Buffer.concat([header,chunk(0xcac1,Buffer.from("BOOT")),chunk(0xcac2,Buffer.from("1234")),chunk(0xcac3,Buffer.alloc(0))]);
}
test("sparse RAW/FILL ranges are verified while DONT_CARE ranges are explicitly excluded",async()=>{
  const image=sparseImage(),size=image.length.toString(16).padStart(8,"0");
  const context=fixture(responses("OKAYcronos",MAX,"OKAY0000000c","OKAY0000000c","DATA0000000c","old contents","OKAY","DATA"+size,"OKAY","OKAY","DATA00000004","BOOT","OKAY","DATA00000004","1234","OKAY"),{input:new Blob([image])});
  const result=await fastbootFlasher.run({protocol:"fastboot",action:"flash",target:"system"},context);
  assert.equal(result.verified,true);assert.equal(result.details.skippedBytes,4);assert.equal(result.sha256,hash(image));
  assert.deepEqual(context.writes.map(text).filter(s=>s.startsWith("fetch:")),["fetch:system:0:c","fetch:system:0:4","fetch:system:4:4"]);
  const malformed=Buffer.from(image);malformed.writeUInt32LE(99,16);
  await assert.rejects(imageFootprint(new Blob([malformed])),/length does not match/);
});

test("arbitrary getvar is read-only, boot uses the chosen image, and OEM/unlock require exact command text",async()=>{
  const read=fixture(responses("OKAY42"));const variable=await fastbootFlasher.run({protocol:"fastboot",action:"exec",command:"getvar vendor-feature"},read);
  assert.equal(variable.summary,"42");assert.equal(read.risks.length,0);assert.deepEqual(read.writes.map(text),["getvar:vendor-feature"]);
  const boot=fixture(responses("DATA00000004","OKAY","OKAY"),{input:new Blob(["BOOT"])});
  await fastbootFlasher.run({protocol:"fastboot",action:"exec",command:"boot"},boot);assert.deepEqual(boot.writes.map(text),["download:00000004","BOOT","boot"]);
  for(const command of ["oem unlock","flashing lock_critical"]){const c=fixture(responses("OKAY"));await fastbootFlasher.run({protocol:"fastboot",action:"exec",command},c);assert.equal(c.risks[0].protectedOverride,"fastboot "+command);assert.deepEqual(c.writes.map(text),[command]);}
});
