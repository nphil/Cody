import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PathMentions } = await jiti.import("./mentions.ts");
const { indexSessionFiles, lastActivityBySession, planTails, readTranscriptMentions } = await jiti.import("./transcripts.ts");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cody-transcripts-test-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const TMP = "/var/fake-tmp";
const HOUR = 3600_000;

function write(file, text, modifiedMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const when = new Date(modifiedMs);
  fs.utimesSync(file, when, when);
}

test("a chat's own file and its subagents' files all belong to the chat, and the newest write is its activity", async () => {
  const sessions = path.join(base, "sessions-a");
  const now = Date.now();
  write(path.join(sessions, "-proj", "2026-11-01T00-00-00-000Z_chat-one.jsonl"), "{}\n", now - 50 * HOUR);
  write(path.join(sessions, "-proj", "2026-11-01T00-00-00-000Z_chat-one", "Worker.jsonl"), "{}\n", now - 2 * HOUR);
  write(path.join(sessions, "-proj", "2026-11-02T00-00-00-000Z_chat-two.jsonl"), "{}\n", now - 30 * HOUR);
  write(path.join(sessions, "-proj", "notes.txt"), "not a transcript", now);

  const files = await indexSessionFiles(sessions);
  assert.equal(files.length, 3, "only .jsonl files");
  const activity = lastActivityBySession(files);
  assert.ok(Math.abs(activity.get("chat-one") - (now - 2 * HOUR)) < 2000, "the subagent's write is the chat's activity");
  assert.ok(Math.abs(activity.get("chat-two") - (now - 30 * HOUR)) < 2000);

  assert.deepEqual(await indexSessionFiles(path.join(base, "no-sessions-here")), [], "a missing dir is an empty answer");
});

test("tail planning never exceeds the budget, reads small files whole, and shares what is left", () => {
  const sizes = [10, 100, 1_000_000, 5_000_000];
  const tails = planTails(sizes, 1_000, 2_000_000, 1);
  assert.equal(tails.length, sizes.length);
  assert.ok(tails.reduce((sum, bytes) => sum + bytes, 0) <= 1_000);
  assert.equal(tails[0], 10, "a file smaller than its share is read whole");
  assert.equal(tails[1], 100);
  assert.ok(tails[2] > 0 && tails[2] === tails[3], "the big ones split the rest evenly");
  assert.ok(tails.every((bytes, index) => bytes <= sizes[index]));

  assert.deepEqual(planTails([300, 400], 10_000_000, 2_000_000, 1), [300, 400], "plenty of budget: everything whole");
  assert.deepEqual(planTails([5_000_000], 10_000_000, 2_000_000, 1), [2_000_000], "no tail is longer than the cap");
  assert.deepEqual(planTails([], 1000, 10, 1), []);
});

test("only the recent end of recently-active transcripts is read", async () => {
  const sessions = path.join(base, "sessions-b");
  const now = Date.now();
  const padding = "x".repeat(200 * 1024) + "\n";
  write(
    path.join(sessions, "-p", "2026-11-04T00-00-00-000Z_fresh.jsonl"),
    `{"t":"${TMP}/only-at-the-start"}\n${padding}{"t":"${TMP}/at-the-end/bin/python"}\n`,
    now - HOUR,
  );
  write(path.join(sessions, "-p", "2026-10-01T00-00-00-000Z_stale.jsonl"), `{"t":"${TMP}/stale-chat-mention"}\n`, now - 10 * 24 * HOUR);
  const mentions = new PathMentions([{ path: TMP }]);

  const files = await indexSessionFiles(sessions);
  const read = await readTranscriptMentions(files, mentions, { now, windowMs: 72 * HOUR, maxTailBytes: 64 * 1024 });
  assert.equal(read.files, 1, "the stale chat is not read at all");
  assert.equal(mentions.has(`${TMP}/at-the-end`), true);
  assert.equal(mentions.has(`${TMP}/only-at-the-start`), false, "beyond the tail");
  assert.equal(mentions.has(`${TMP}/stale-chat-mention`), false, "outside the window");
});

test("however many chats are busy, the bytes read stay inside the budget and the newest are read first", async () => {
  const sessions = path.join(base, "sessions-c");
  const now = Date.now();
  for (let index = 0; index < 8; index++) {
    write(path.join(sessions, "-p", `2026-11-04T00-00-0${index}-000Z_busy-${index}.jsonl`), `${"y".repeat(40_000)}\n{"t":"${TMP}/mention-${index}"}\n`, now - index * HOUR);
  }
  const mentions = new PathMentions([{ path: TMP }]);
  const files = await indexSessionFiles(sessions);

  // Room for three tails of 10 KB each: the three most recently written.
  const read = await readTranscriptMentions(files, mentions, { now, windowMs: 72 * HOUR, budgetBytes: 30_000, maxTailBytes: 10_000, minTailBytes: 10_000 });
  assert.ok(read.bytes <= 30_000);
  assert.equal(read.files, 3);
  for (const index of [0, 1, 2]) assert.equal(mentions.has(`${TMP}/mention-${index}`), true, `newest chat ${index}`);
  assert.equal(mentions.has(`${TMP}/mention-5`), false);
});

test("a snapcompact-sized last line is read from its end only, never loaded whole", async () => {
  // omp 18.10.3+ stores up to 12 MB of base64 PNG frames inside one compaction
  // entry, so a transcript's last line can be far longer than the tail. The tail
  // is raw text, cut mid-line, and scanned by needle: that must neither throw nor
  // read more than the tail, and the `/` runs a base64 frame is full of must not
  // look like a temp path.
  const sessions = path.join(base, "sessions-d");
  const now = Date.now();
  const frames = Buffer.alloc(512 * 1024, 0xff).toString("base64");
  write(
    path.join(sessions, "-p", "2026-11-04T00-00-00-000Z_big-line.jsonl"),
    `{"t":"${TMP}/before-the-big-line"}\n{"type":"compaction","preserveData":{"snapcompact":{"frames":["${frames}"]}}}\n`,
    now - HOUR,
  );
  const mentions = new PathMentions([{ path: TMP }]);
  const files = await indexSessionFiles(sessions);

  const read = await readTranscriptMentions(files, mentions, { now, windowMs: 72 * HOUR, maxTailBytes: 64 * 1024 });
  assert.deepEqual(read, { files: 1, bytes: 64 * 1024 }, "exactly the tail, however long the last line is");
  assert.equal(mentions.has(`${TMP}/before-the-big-line`), false, "cut away with the head of that line");
});
