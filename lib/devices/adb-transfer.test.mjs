import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra";
import { fakeAdb, waitFor } from "./adb.test-helper.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { adbFlasher } = await jiti.import("./adb.ts");
const { sideloadAdb } = await jiti.import("./adb-sideload.ts");
const { hashBlob } = await jiti.import("./blob-stream.ts");
const encoder = new TextEncoder();
const digest = (data) => createHash("sha256").update(data).digest("hex");
function syncPacket(id, bytes = new Uint8Array()) {
  const header = Buffer.alloc(8); header.write(id); header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

test("follow-up verification starts through the manager with a hash and no uploaded file",async()=>{
  const {DeviceOperationManager}=await jiti.import("./operations.ts");const expected=digest("BOOT");
  const transport=fakeAdb({output:service=>(service.includes("HASH:%s")?"HASH:sha256sum":expected)+"\n__CODY_ADB_STATUS__0\n"});
  const manager=new DeviceOperationManager("recovery",{async borrowHardwareTransport(){return {transport,async release(){transport.close();}};}},{async getInput(){throw new Error("No artifact required");},async save(){}},[adbFlasher]);
  manager.setShellAccess("cronos",true);
  const {id}=manager.start({deviceId:"cronos",protocol:"adb",action:"verify",target:"/dev/block/mmcblk0p9",length:4,sha256:expected});
  await waitFor(()=>manager.status(id)?.state==="succeeded");assert.equal(manager.status(id).result.verified,true);
});

test("ADB follow-up verification checks the requested raw image hash against recovery storage", async () => {
  for (const matches of [true,false]) {
    const expected=digest("BOOT");
    const transport=fakeAdb({ output(service) {return (service.includes("HASH:%s")?"HASH:sha256sum":matches?expected:digest("BAD!"))+"\n__CODY_ADB_STATUS__0\n";} });
    const request={protocol:"adb",action:"verify",target:"/dev/block/mmcblk0p9",length:4,sha256:expected};
    const context={transport,signal:new AbortController().signal,shellAccess:()=>true,progress(){},async confirm(){throw new Error("Read-only verify should not confirm");}};
    if(matches){const result=await adbFlasher.run(request,context);assert.equal(result.verified,true);assert.equal(result.sha256,expected);}
    else await assert.rejects(adbFlasher.run(request,context),/does not match/);
    assert.ok(transport.services.some(service=>service.includes("head -c 4 '/dev/block/mmcblk0p9'")));
    transport.close();
  }
});

test("raw block push backs up first and writes bytes only after exact risk approval", async () => {
  const image = Buffer.from("new boot image");
  const written = [];
  let pending = Buffer.alloc(0), sentTarget, release, backedUp = false;
  const transport = fakeAdb({
    output(service) {
      if (service === "sync:") return undefined;
      const status = service.includes("test -c ") ? 1 : 0;
      const output = service.includes("HASH:%s") ? "HASH:sha256sum" : service.includes("head -c ") ? digest(image) + "  -" : "";
      return output + "\n__CODY_ADB_STATUS__" + status + "\n";
    },
    onInput(_service, data, send) {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 8) {
        const id = pending.toString("ascii", 0, 4), size = pending.readUInt32LE(4);
        const length = id === "DONE" ? 0 : size;
        if (pending.length < 8 + length) return;
        const payload = pending.subarray(8, 8 + length); pending = pending.subarray(8 + length);
        if (id === "RECV") send(Buffer.concat([syncPacket("DATA", Buffer.from("old partition")), syncPacket("DONE")]));
        else if (id === "SEND") sentTarget = payload.toString();
        else if (id === "DATA") written.push(Buffer.from(payload));
        else if (id === "DONE") send(syncPacket("OKAY"));
      }
    },
  });
  const context = { transport, input:new Blob([image]), signal:new AbortController().signal, shellAccess:()=>true, progress(){},
    async saveStream(_name, incoming) { for await (const chunk of incoming) assert.equal(Buffer.from(chunk).toString(),"old partition"); backedUp=true; return {fileId:"full-backup",sha256:"hash",length:13}; },
    async confirm(risk) { assert.equal(backedUp,true); assert.equal(risk.protectedOverride,"write:/dev/block/mmcblk0p9"); assert.match(risk.backup,/full-backup/); await new Promise((r)=>{release=r;}); },
  };
  const promise = adbFlasher.run({protocol:"adb",action:"push",target:"/dev/block/mmcblk0p9"},context);
  while (!release) await new Promise((r)=>setTimeout(r,1));
  assert.equal(sentTarget,undefined); assert.deepEqual(written,[]); release();
  const result = await promise; transport.close();
  assert.match(sentTarget,/^\/dev\/block\/mmcblk0p9,/);
  assert.deepEqual(Buffer.concat(written),image); assert.equal(result.verified,true); assert.equal(result.sha256,digest(image));
});

test("pull streams /dev/block bytes only with shell authority and reports their SHA-256", async () => {
  const chunks = [Buffer.from("partition "), Buffer.from("data")];
  let pending = Buffer.alloc(0), path;
  const transport = fakeAdb({ output: () => undefined, onInput(service, data, send) {
    assert.equal(service, "sync:"); pending = Buffer.concat([pending, data]);
    if (pending.length < 8) return;
    const length = pending.readUInt32LE(4);
    if (pending.length < 8 + length || pending.toString("ascii", 0, 4) !== "RECV") return;
    path = pending.toString("utf8", 8, 8 + length); pending = pending.subarray(8 + length);
    send(Buffer.concat([...chunks.map((c) => syncPacket("DATA", c)), syncPacket("DONE")]));
  }});
  const context = { transport, signal: new AbortController().signal, progress() {}, async confirm() {}, async save() {},
    async saveStream(name, incoming) {
      const hash = createHash("sha256"); let length = 0;
      for await (const chunk of incoming) { hash.update(chunk); length += chunk.length; }
      return { fileId: name, sha256: hash.digest("hex"), length };
    } };
  const request = { protocol: "adb", action: "pull", target: "/dev/block/mmcblk0p9" };
  await assert.rejects(adbFlasher.run(request, context), /protected raw storage/);
  assert.deepEqual(transport.services, []);
  const result = await adbFlasher.run(request, { ...context, shellAccess: () => true });
  transport.close();
  assert.equal(path, request.target);
  assert.equal(result.sha256, digest(Buffer.concat(chunks)));
  assert.equal(result.details.length, 14);
});

test("incremental hash handles a multi-chunk image without requesting a whole-file buffer", async () => {
  const data = Buffer.alloc(10 * 1024 * 1024, 0x95);
  const blob = new Blob([data]);
  blob.arrayBuffer = () => { throw new Error("Whole-file allocation"); };
  assert.equal(await hashBlob(blob), digest(data));
});

test("sideload waits for approval, serves random/repeated blocks and distinguishes transfer from installation", async () => {
  const input = new Blob([new Uint8Array(65536).fill(0x61), new Uint8Array([1,2,3])]);
  let allow, opened = false;
  const sent = [];
  const adb = { async createSocket(service) {
    opened = true; assert.equal(service, "sideload-host:65539:65536");
    return { readable: new ReadableStream({ start(c) { for (const s of ["000", "000010000000000000001", "DONE", "DONE"]) c.enqueue(encoder.encode(s)); } }),
      writable: new WritableStream({ write(chunk) { chunk.tryConsume((bytes) => sent.push(new Uint8Array(bytes))); } }), async close() {} };
  }};
  const context = { input, signal: new AbortController().signal, progress() {}, async confirm(risk) { assert.match(risk.backup, /backup unavailable/); await new Promise((r) => { allow = r; }); } };
  const promise = sideloadAdb({ protocol: "adb", action: "sideload" }, context, adb);
  while (!allow) await new Promise((r) => setTimeout(r, 1));
  assert.equal(opened, false); allow();
  const result = await promise;
  assert.deepEqual(sent.map((v) => v.length), [3,65536,3]);
  assert.deepEqual([...sent[0]], [1,2,3]);
  assert.equal(result.sha256, await hashBlob(input));
  assert.equal(result.verified, false);
});

test("sideload rejects out-of-range requests without writing any bytes", async () => {
  let writes = 0;
  const adb = { async createSocket() { return { readable: new ReadableStream({ start(c) { c.enqueue(encoder.encode("99999999")); } }), writable: new WritableStream({ write(){writes++;} }), async close() {} }; } };
  await assert.rejects(sideloadAdb({protocol:"adb",action:"sideload"},{ input:new Blob(["small"]), signal:new AbortController().signal, progress(){}, async confirm(){} },adb), /beyond/);
  assert.equal(writes, 0);
});
