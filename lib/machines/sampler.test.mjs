import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * The sampler is what makes CPU and memory live without leaving anything
 * running: it starts when a page starts watching, stops a minute after the
 * last page leaves, and never invents a number. What matters: one collector per
 * machine and none without a viewer, readings that arrive together are sent
 * together, a machine that drops loses its numbers instead of keeping stale
 * ones, retries back off (and back off a lot for failures only a person can
 * fix), and every connection is killed when its collector stops.
 *
 * Time is fake and collectors are fakes: nothing here waits, spawns or reads
 * /proc. (`ssh.test.mjs` covers the real loop.)
 */
const jiti = createJiti(import.meta.url);
const sampler = await jiti.import("./sampler.ts");

// Every real timer in the sampler is unref'd (it must never hold the server
// open), so while a test awaits one nothing else keeps the event loop alive
// and the runner would call the wait abandoned.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

class FakeTimers {
  time = 1_000_000;
  queue = [];
  seq = 0;
  now() { return this.time; }
  after(ms, fn) {
    const entry = { at: this.time + ms, fn, seq: this.seq++ };
    this.queue.push(entry);
    return () => {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
    };
  }
  advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const due = this.queue.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.queue.splice(this.queue.indexOf(due), 1);
      this.time = due.at;
      due.fn();
    }
    this.time = target;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A reading with the given tick counters and 40% of memory free. */
function raw(total, idle, memAvailableKb = 400) {
  return { cpu: { total, idle }, cores: 4, memTotalKb: 1000, memAvailableKb, load1: 0.5 };
}

const LOCAL = { id: "local", kind: "local", name: "This server" };
const PVE = { id: "m-aaaaaa", kind: "ssh", name: "Proxmox", destination: "proxmox" };
const PI = { id: "m-bbbbbb", kind: "ssh", name: "Pi", destination: "pi@raspberrypi.local" };

function rig(configs = [LOCAL, PVE]) {
  const timers = new FakeTimers();
  const created = [];
  const state = { configs };
  const collect = (config, events) => {
    const record = { config, events, stopped: false };
    created.push(record);
    return { stop() { record.stopped = true; } };
  };
  const instance = new sampler.MachineSampler({ readConfig: () => state.configs, collect, timers });
  return { timers, created, state, instance };
}

test("nothing runs until a page watches, then there is one collector per machine, all connecting", () => {
  const { created, instance } = rig();
  assert.equal(created.length, 0);
  assert.equal(instance.isRunning, false);
  assert.deepEqual(instance.states().map((s) => [s.id, s.status]), [["local", "connecting"], ["m-aaaaaa", "connecting"]]);

  instance.subscribe(() => {});
  assert.deepEqual(created.map((record) => record.config.id), ["local", "m-aaaaaa"]);
  assert.deepEqual(instance.states().map((s) => [s.status, s.reason, s.metrics]), [["connecting", "starting", null], ["connecting", "starting", null]]);
});

test("a reading puts a machine online; CPU needs a second reading; readings that land together are sent as one frame", () => {
  const { timers, created, instance } = rig();
  const frames = [];
  instance.subscribe((states) => frames.push(states));

  created[0].events.sample(raw(1000, 800));
  timers.advance(100);
  created[0].events.sample(raw(1200, 900)); // 200 ticks, 100 idle
  assert.equal(frames.length, 0, "frames wait out the coalescing delay");
  timers.advance(200);
  assert.equal(frames.length, 1, "one frame for both readings");

  const [local, pve] = frames[0];
  assert.equal(local.status, "online");
  assert.equal(local.reason, null);
  assert.equal(local.metrics.cpuPercent, 50);
  assert.equal(local.metrics.memPercent, 60);
  assert.equal(local.metrics.cores, 4);
  assert.equal(pve.status, "connecting", "a machine nobody has heard from stays connecting");
});

test("the very first reading has no CPU figure yet, only memory", () => {
  const { timers, created, instance } = rig();
  const frames = [];
  instance.subscribe((states) => frames.push(states));
  created[1].events.sample(raw(5000, 4000));
  timers.advance(300);
  assert.equal(frames[0][1].status, "online");
  assert.equal(frames[0][1].metrics.cpuPercent, null);
  assert.equal(frames[0][1].metrics.memPercent, 60);
});

test("a machine that goes down loses its numbers, and its first reading afterwards has nothing to subtract from", () => {
  const { timers, created, instance } = rig();
  instance.subscribe(() => {});
  created[1].events.sample(raw(1000, 800));
  created[1].events.sample(raw(1200, 900));
  timers.advance(300);
  assert.equal(instance.states()[1].metrics.cpuPercent, 50);

  created[1].events.state("offline", "auth");
  assert.deepEqual([instance.states()[1].status, instance.states()[1].reason, instance.states()[1].metrics], ["offline", "auth", null]);

  // Counters after a reboot restart from zero: subtracting them from the old
  // ones would be nonsense, so the first reading back reports no CPU.
  created[1].events.sample(raw(10, 5));
  assert.equal(instance.states()[1].status, "online");
  assert.equal(instance.states()[1].metrics.cpuPercent, null);
});

test("the last page leaving stops every collector after a minute, and a page returning in time cancels that", () => {
  const { timers, created, instance } = rig();
  const leave = instance.subscribe(() => {});
  leave();
  timers.advance(59_000);
  assert.ok(created.every((record) => !record.stopped), "still running inside the grace period (a reload must not tear ssh down)");
  assert.equal(instance.isRunning, true);

  const back = instance.subscribe(() => {});
  timers.advance(10 * 60_000);
  assert.ok(created.every((record) => !record.stopped), "the countdown was cancelled by the returning page");

  back();
  timers.advance(sampler.IDLE_STOP_MS);
  assert.ok(created.every((record) => record.stopped), "nobody looked for a minute: everything stopped");
  assert.equal(instance.isRunning, false);

  instance.subscribe(() => {});
  assert.equal(created.length, 4, "a new viewer starts a fresh set");
});

test("one of two pages leaving does not start the countdown", () => {
  const { timers, created, instance } = rig();
  const first = instance.subscribe(() => {});
  instance.subscribe(() => {});
  first();
  timers.advance(10 * 60_000);
  assert.ok(created.every((record) => !record.stopped));
});

test("a changed list starts what was added, stops what was removed and renames in place", () => {
  const { created, state, instance } = rig([LOCAL, PVE]);
  instance.subscribe(() => {});

  state.configs = [{ ...LOCAL, name: "Unraid" }, PVE, PI];
  instance.reconcile();
  assert.equal(created.length, 3, "only the new machine got a collector");
  assert.equal(created[2].config.id, "m-bbbbbb");
  assert.ok(!created[0].stopped && !created[1].stopped, "renaming restarts nothing");
  assert.deepEqual(instance.states().map((s) => s.name), ["Unraid", "Proxmox", "Pi"]);

  state.configs = [{ ...LOCAL, name: "Unraid" }, PI];
  instance.reconcile();
  assert.equal(created[1].stopped, true, "a removed machine's connection is killed");
  assert.deepEqual(instance.states().map((s) => s.id), ["local", "m-bbbbbb"]);
});

test("a machine that now points somewhere else is restarted and forgets its numbers", () => {
  const { timers, created, state, instance } = rig([LOCAL, PVE]);
  instance.subscribe(() => {});
  created[1].events.sample(raw(1000, 800));
  timers.advance(300);
  assert.equal(instance.states()[1].status, "online");

  state.configs = [LOCAL, { ...PVE, destination: "root@10.0.0.9" }];
  instance.reconcile();
  assert.equal(created[1].stopped, true);
  assert.equal(created.length, 3);
  assert.equal(created[2].config.destination, "root@10.0.0.9");
  assert.deepEqual([instance.states()[1].status, instance.states()[1].metrics], ["connecting", null]);

  created[1].events.sample(raw(9999, 1));
  assert.equal(instance.states()[1].status, "connecting", "the old collector can no longer write to the machine");
});

test("shutdown stops every collector; viewers stay subscribed and a new page starts them again", () => {
  const { created, instance } = rig();
  instance.subscribe(() => {});
  instance.stop();
  assert.ok(created.every((record) => record.stopped));
  assert.equal(instance.isRunning, false);
  instance.subscribe(() => {});
  assert.equal(created.length, 4);
});

test("a viewer that throws does not stop the others hearing", () => {
  const { timers, created, instance } = rig();
  const heard = [];
  instance.subscribe(() => { throw new Error("gone"); });
  instance.subscribe((states) => heard.push(states));
  created[0].events.sample(raw(1, 1));
  timers.advance(300);
  assert.equal(heard.length, 1);
});

test("there is a ceiling on how many pages can watch at once", () => {
  const { instance } = rig();
  const leavers = Array.from({ length: 64 }, () => instance.subscribe(() => {}));
  assert.ok(leavers.every((leave) => typeof leave === "function"));
  assert.equal(instance.subscribe(() => {}), null);
  leavers[0]();
  assert.equal(typeof instance.subscribe(() => {}), "function", "room again once one leaves");
});

// ── this server ──────────────────────────────────────────────────────────────

function recorder() {
  const log = [];
  return {
    log,
    events: {
      sample: (reading) => log.push(["sample", reading.cpu.total]),
      state: (status, reason) => log.push(["state", status, reason]),
    },
  };
}

test("this server on anything but Linux says unavailable instead of guessing", () => {
  const { log, events } = recorder();
  sampler.startLocalCollector(events, new FakeTimers(), async () => raw(1, 1), "darwin");
  assert.deepEqual(log, [["state", "unavailable", "not_linux"]]);
});

test("this server is read at once, again after half a second, then every two seconds until stopped", async () => {
  const timers = new FakeTimers();
  const { log, events } = recorder();
  let total = 0;
  const collector = sampler.startLocalCollector(events, timers, async () => raw((total += 100), 0), "linux");
  await flush();
  assert.deepEqual(log, [["sample", 100]]);
  timers.advance(499);
  await flush();
  assert.equal(log.length, 1);
  timers.advance(1);
  await flush();
  assert.equal(log.length, 2, "the warm-up reading, so CPU shows almost at once");
  timers.advance(1_999);
  await flush();
  assert.equal(log.length, 2);
  timers.advance(1);
  await flush();
  assert.equal(log.length, 3);

  collector.stop();
  timers.advance(60_000);
  await flush();
  assert.equal(log.length, 3, "stopped means stopped");
});

test("this server: no /proc at all is final, a failed read is retried", async () => {
  const timers = new FakeTimers();
  const missing = recorder();
  sampler.startLocalCollector(missing.events, timers, async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); }, "linux");
  await flush();
  timers.advance(60_000);
  await flush();
  assert.deepEqual(missing.log, [["state", "unavailable", "not_linux"]], "waiting will not conjure /proc");

  const flaky = recorder();
  let calls = 0;
  sampler.startLocalCollector(flaky.events, timers, async () => { if (++calls === 1) throw new Error("EIO"); return raw(7, 0); }, "linux");
  await flush();
  timers.advance(2_000);
  await flush();
  assert.deepEqual(flaky.log, [["state", "unavailable", "read_failed"], ["sample", 7]]);
});

// ── a machine over ssh ───────────────────────────────────────────────────────

function fakeSsh() {
  const runs = [];
  const connect = (destination, handlers) => {
    const run = { destination, handlers, stopped: false, stop() { this.stopped = true; } };
    runs.push(run);
    return run;
  };
  return { runs, connect };
}

function sshRig() {
  const timers = new FakeTimers();
  const { log, events } = recorder();
  const ssh = fakeSsh();
  const collector = sampler.startSshCollector("proxmox", events, timers, ssh.connect);
  return { timers, log, ssh, collector };
}

const closed = (reason, samples = 0) => ({ reason, detail: "", samples });

test("an ssh machine connects at once, with its destination, once", () => {
  const { ssh } = sshRig();
  assert.equal(ssh.runs.length, 1);
  assert.equal(ssh.runs[0].destination, "proxmox");
});

test("a connection that keeps failing is retried with growing gaps up to a ceiling", () => {
  const { timers, log, ssh } = sshRig();
  const gaps = sampler.RETRY_BACKOFF_MS;
  for (let attempt = 0; attempt < gaps.length + 2; attempt += 1) {
    const expected = gaps[Math.min(attempt, gaps.length - 1)];
    ssh.runs.at(-1).handlers.onClose(closed("refused"));
    const before = ssh.runs.length;
    timers.advance(expected - 1);
    assert.equal(ssh.runs.length, before, `attempt ${attempt}: not yet at ${expected} ms`);
    timers.advance(1);
    assert.equal(ssh.runs.length, before + 1, `attempt ${attempt}: retried at ${expected} ms`);
  }
  assert.deepEqual(log[0], ["state", "offline", "refused"]);
});

test("a reading resets the backoff", () => {
  const { timers, ssh } = sshRig();
  ssh.runs[0].handlers.onClose(closed("refused"));
  timers.advance(1_000);
  ssh.runs[1].handlers.onClose(closed("refused"));
  timers.advance(2_000);
  assert.equal(ssh.runs.length, 3);
  ssh.runs[2].handlers.onSample(raw(1, 1));
  ssh.runs[2].handlers.onClose(closed("dropped", 1));
  timers.advance(1_000);
  assert.equal(ssh.runs.length, 4, "back to the first, shortest gap");
});

test("a machine that was working and merely dropped gets one quiet retry shown as connecting, not offline", () => {
  const { timers, log, ssh } = sshRig();
  ssh.runs[0].handlers.onSample(raw(1, 1));
  ssh.runs[0].handlers.onClose(closed("dropped", 1));
  assert.deepEqual(log.at(-1), ["state", "connecting", "dropped"]);
  timers.advance(1_000);
  ssh.runs[1].handlers.onClose(closed("refused", 0));
  assert.deepEqual(log.at(-1), ["state", "offline", "refused"], "the retry failing is the news");
});

test("failures only a person can fix are retried every five minutes, not every few seconds", () => {
  for (const reason of ["auth", "host_key", "unknown_host", "no_ssh"]) {
    const { timers, ssh } = sshRig();
    ssh.runs[0].handlers.onClose(closed(reason));
    timers.advance(sampler.RETRY_SLOW_MS - 1);
    assert.equal(ssh.runs.length, 1, `${reason}: still waiting (a refused login must not fill the far side's auth log)`);
    timers.advance(1);
    assert.equal(ssh.runs.length, 2, `${reason}: retried after five minutes`);
  }
});

test("a connection that is alive but silent is killed and treated as unreachable", () => {
  const { timers, log, ssh } = sshRig();
  timers.advance(sampler.STALL_MS);
  assert.equal(ssh.runs[0].stopped, false, "not stuck yet");
  timers.advance(10_000);
  assert.equal(ssh.runs[0].stopped, true);
  assert.deepEqual(log.at(-1), ["state", "offline", "unreachable"]);
  // Whatever the dead connection says afterwards is ignored.
  ssh.runs[0].handlers.onSample(raw(1, 1));
  assert.equal(log.filter((entry) => entry[0] === "sample").length, 0);
});

test("a steady stream of readings is never mistaken for a stall", () => {
  const { timers, ssh } = sshRig();
  for (let i = 0; i < 20; i += 1) {
    ssh.runs[0].handlers.onSample(raw(i, i));
    timers.advance(2_000);
  }
  assert.equal(ssh.runs[0].stopped, false);
  assert.equal(ssh.runs.length, 1);
});

test("a machine that is not Linux is unavailable, and that is final", () => {
  const { timers, log, ssh } = sshRig();
  ssh.runs[0].handlers.onNoProc();
  assert.deepEqual(log, [["state", "unavailable", "not_linux"]]);
  assert.equal(ssh.runs[0].stopped, true);
  timers.advance(60 * 60_000);
  assert.equal(ssh.runs.length, 1);
});

test("stopping kills the connection, cancels retries and silences everything after", () => {
  const live = sshRig();
  live.ssh.runs[0].handlers.onSample(raw(1, 1));
  live.collector.stop();
  assert.equal(live.ssh.runs[0].stopped, true);
  live.ssh.runs[0].handlers.onSample(raw(2, 2));
  live.ssh.runs[0].handlers.onClose(closed("dropped", 1));
  assert.equal(live.log.length, 1, "only the reading from before the stop");

  const waiting = sshRig();
  waiting.ssh.runs[0].handlers.onClose(closed("refused"));
  waiting.collector.stop();
  waiting.timers.advance(10 * 60_000);
  assert.equal(waiting.ssh.runs.length, 1, "no reconnect after stop");
});

test("ssh failing to even start is a failure, retried, never a crash", () => {
  const timers = new FakeTimers();
  const { log, events } = recorder();
  let attempts = 0;
  sampler.startSshCollector("proxmox", events, timers, () => { attempts += 1; throw new Error("invalid destination"); });
  assert.deepEqual(log, [["state", "offline", "failed"]]);
  timers.advance(1_000);
  assert.equal(attempts, 2);
});

// ── the Test button ──────────────────────────────────────────────────────────

test("a test succeeds on its second reading, with the CPU figure that needs it", async () => {
  const ssh = fakeSsh();
  const pending = sampler.testSshMachine("proxmox", ssh.connect, 5_000);
  ssh.runs[0].handlers.onSample(raw(1000, 800));
  ssh.runs[0].handlers.onSample(raw(1200, 900));
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.cpuPercent, 50);
  assert.equal(result.memPercent, 60);
  assert.equal(result.cores, 4);
  assert.equal(result.memTotalBytes, 1000 * 1024);
  assert.equal(ssh.runs[0].stopped, true, "the connection is closed once it has what it needs");
});

test("a test that cannot connect says why, in ssh's own words too", async () => {
  const ssh = fakeSsh();
  const pending = sampler.testSshMachine("proxmox", ssh.connect, 5_000);
  ssh.runs[0].handlers.onClose({ reason: "auth", detail: "Permission denied (publickey).", samples: 0 });
  assert.deepEqual(await pending, { ok: false, reason: "auth", detail: "Permission denied (publickey)." });
});

test("a test that connected but then lost the machine reports it as dropped", async () => {
  const ssh = fakeSsh();
  const pending = sampler.testSshMachine("proxmox", ssh.connect, 5_000);
  ssh.runs[0].handlers.onSample(raw(1, 1));
  ssh.runs[0].handlers.onClose({ reason: "failed", detail: "", samples: 1 });
  assert.deepEqual(await pending, { ok: false, reason: "dropped", detail: "" });
});

test("a test against a machine that is not Linux says so", async () => {
  const ssh = fakeSsh();
  const pending = sampler.testSshMachine("proxmox", ssh.connect, 5_000);
  ssh.runs[0].handlers.onNoProc();
  assert.deepEqual(await pending, { ok: false, reason: "not_linux", detail: "" });
});

test("a test that hears nothing gives up and kills its connection", async () => {
  const ssh = fakeSsh();
  const result = await sampler.testSshMachine("proxmox", ssh.connect, 20);
  assert.deepEqual(result, { ok: false, reason: "unreachable", detail: "" });
  assert.equal(ssh.runs[0].stopped, true);
});

test("only a couple of tests may run at once", async () => {
  const ssh = fakeSsh();
  const first = sampler.testSshMachine("one", ssh.connect, 5_000);
  const second = sampler.testSshMachine("two", ssh.connect, 5_000);
  await assert.rejects(() => sampler.testSshMachine("three", ssh.connect, 5_000), sampler.MachineTestBusyError);
  ssh.runs[0].handlers.onClose({ reason: "refused", detail: "", samples: 0 });
  await first;
  const third = sampler.testSshMachine("three", ssh.connect, 5_000);
  ssh.runs[1].handlers.onClose({ reason: "refused", detail: "", samples: 0 });
  ssh.runs[2].handlers.onClose({ reason: "refused", detail: "", samples: 0 });
  await Promise.all([second, third]);
});
