import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const {
  extractSubagentHistory, isSafeSubagentId, readCompletionArtifact, readSubagentTranscriptPage, resolveSubagentArtifact, siblingDirForSession, slimSubagentMessage,
  MAX_SUBAGENT_COMPLETION_BYTES, MAX_SUBAGENT_INLINE_IMAGE_CHARS, MAX_SUBAGENT_MESSAGE_TEXT_CHARS, MAX_SUBAGENT_TRANSCRIPT_LINE_BYTES,
  SUBAGENT_TRANSCRIPT_PAGE_BYTES, SUBAGENT_TRANSCRIPT_PAGE_LINES,
} = await jiti.import("./subagent-history.ts");

function makeSessionFixture() {
  const dir = mkdtempSync(join(tmpdir(), "cody-subagent-history-"));
  const sessionFile = join(dir, "2026-08-01T00-00-00_abc123.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-08-01T00:00:00.000Z", cwd: "C:\\work" }),
    JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "task",
        content: [],
        details: {
          projectAgentsDir: "C:\\work\\.omp\\agents",
          progress: [
            {
              index: 0,
              id: "ScoutAgent",
              agent: "scout",
              agentSource: "bundled",
              status: "running",
              task: "Map the surface",
              assignment: "Inspect files",
              tokens: 1200,
              cost: 0.012,
              durationMs: 65000,
              requests: 3,
              toolCount: 9,
              resolvedModel: "provider/gpt-x",
              modelRole: "smol",
            },
          ],
          results: [
            {
              index: 0,
              id: "ScoutAgent",
              agent: "scout",
              agentSource: "bundled",
              task: "Map the surface",
              exitCode: 0,
              tokens: 999,
              durationMs: 60000,
              requests: 3,
              toolCount: 9,
              resolvedModel: "provider/gpt-x",
              modelRole: "smol",
              structuredOutput: { status: "valid", mode: "permissive" },
              outputPath: "C:\\work\\artifacts\\ScoutAgent.md",
              usage: { cost: { input: 0.4, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
            },
          ],
          async: { state: "completed", jobId: "ScoutAgent", type: "task" },
        },
      },
    }),
    JSON.stringify({
      type: "message",
      id: "e2",
      parentId: null,
      timestamp: "2026-08-01T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "task",
        content: [],
        details: {
          results: [
            {
              index: 1,
              id: "WorkerOne",
              agent: "worker",
              agentSource: "bundled",
              task: "Write the code",
              exitCode: 1,
              error: "Test failed",
              tokens: 500,
            },
          ],
          async: { state: "failed", jobId: "WorkerOne", type: "task" },
        },
      },
    }),
  ];
  writeFileSync(sessionFile, lines.join("\n") + "\n");

  // Sibling artifacts dir with one transcript file.
  const artifactsDir = siblingDirForSession(sessionFile);
  mkdirSync(artifactsDir, { recursive: true });
  const transcript = [
    JSON.stringify({ type: "session", version: 3, id: "sub-session", timestamp: "2026-08-01T00:00:00.000Z", cwd: "C:\\work" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: "Map the surface" } }),
    JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
  ];
  writeFileSync(join(artifactsDir, "ScoutAgent.jsonl"), transcript.join("\n") + "\n");

  return { dir, sessionFile, artifactsDir };
}

test("extracts subagent roster from task toolResults with settled results winning", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const roster = extractSubagentHistory(sessionFile);
    assert.equal(roster.length, 2);

    const scout = roster.find((entry) => entry.id === "ScoutAgent");
    assert.ok(scout);
    assert.equal(scout.agent, "scout");
    assert.equal(scout.agentSource, "bundled");
    // Settled result overrides the mid-run progress snapshot.
    assert.equal(scout.status, "completed");
    assert.equal(scout.tokens, 999);
    // Settled cost rides usage.cost.total (top-level cost is absent)
    assert.equal(scout.cost, 0.5);
    assert.equal(scout.durationMs, 60000);
    assert.equal(scout.task, "Map the surface");
    assert.equal(scout.transcriptAvailable, true);
    assert.equal(scout.sessionFile, join(dir, "2026-08-01T00-00-00_abc123", "ScoutAgent.jsonl"));
    assert.equal(scout.result?.structuredOutput?.status, "valid");

    const worker = roster.find((entry) => entry.id === "WorkerOne");
    assert.ok(worker);
    assert.equal(worker.status, "failed");
    assert.equal(worker.result?.error, "Test failed");
    assert.equal(worker.transcriptAvailable, false);
    // Both spawns were async (details.async present).
    assert.equal(scout.detached, true);
    assert.equal(worker.detached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps async-only spawns (empty results) as started entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-subagent-history-"));
  const sessionFile = join(dir, "sess.jsonl");
  try {
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "p", timestamp: "2026-08-01T00:00:00.000Z", cwd: "C:\\work" }),
      JSON.stringify({
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2026-08-01T00:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "task",
          content: [],
          details: { async: { state: "running", jobId: "AsyncJob", type: "task" } },
        },
      }),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n");
    const roster = extractSubagentHistory(sessionFile);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].id, "AsyncJob");
    assert.equal(roster[0].status, "started");
    assert.equal(roster[0].transcriptAvailable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pages subagent transcripts byte-wise with UI messages", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const transcriptFile = join(siblingDirForSession(sessionFile), "ScoutAgent.jsonl");
    const page1 = readSubagentTranscriptPage(transcriptFile, 0);
    assert.equal(page1.reset, false);
    assert.equal(page1.messages.length, 2);
    assert.equal(page1.messages[0].role, "user");
    assert.equal(page1.messages[1].role, "assistant");
    assert.ok(page1.nextByte > 0);

    // Continue from the end: nothing new.
    const page2 = readSubagentTranscriptPage(transcriptFile, page1.nextByte);
    assert.equal(page2.messages.length, 0);
    assert.equal(page2.nextByte, page1.nextByte);

    // Past EOF resets to the start.
    const page3 = readSubagentTranscriptPage(transcriptFile, 999999);
    assert.equal(page3.reset, true);
    assert.equal(page3.messages.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("byte-window paging survives non-ASCII content before the offset", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const transcriptFile = join(siblingDirForSession(sessionFile), "ScoutAgent.jsonl");
    // First entry carries multi-byte UTF-8 so byte offsets and UTF-16 string
    // indices diverge (the regression that .slice(startByte) reintroduced).
    const entry1 = JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { role: "user", content: "質問：マルチバイトのテキストです" },
    });
    const entry2 = JSON.stringify({
      type: "message",
      id: "e2",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { role: "assistant", content: "plain ascii follow-up" },
    });
    writeFileSync(transcriptFile, `${entry1}\n${entry2}\n`);

    // Continue from the exact byte length of entry1's line: only entry2 may
    // come back. A UTF-16 slice would start mid-line and drop it.
    const fromByte = Buffer.byteLength(`${entry1}\n`, "utf8");
    const page = readSubagentTranscriptPage(transcriptFile, fromByte);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].role, "assistant");
    assert.equal(page.nextByte, fromByte + Buffer.byteLength(`${entry2}\n`, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page without a trailing newline still advances (no infinite paging)", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const transcriptFile = join(siblingDirForSession(sessionFile), "ScoutAgent.jsonl");
    // No trailing newline: the last line is partial until the file grows.
    writeFileSync(transcriptFile, `{"type":"message","id":"e1","parentId":null,"timestamp":"2026-08-01T00:00:00.000Z","message":{"role":"user","content":"a"}}
{"type":"message","id":"e2","parentId":null,"timestamp":"2026-08-01T00:00:01.000Z","message":{"role":"assistant","content":"b"}}`);
    const page1 = readSubagentTranscriptPage(transcriptFile, 0);
    // Only the complete first line parses; the partial tail is skipped so
    // the next page makes progress instead of looping on the same offset.
    assert.equal(page1.messages.length, 1);
    assert.ok(page1.nextByte > 0);
    const page2 = readSubagentTranscriptPage(transcriptFile, page1.nextByte);
    assert.equal(page2.nextByte, page1.nextByte);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts explicit and nested task names but rejects path escapes", () => {
  assert.equal(isSafeSubagentId("Review API: v2 (urgent)"), true);
  assert.equal(isSafeSubagentId("Parent.Task 1 / nested"), false);
  assert.equal(isSafeSubagentId("Parent.Task 1"), true);
  assert.equal(isSafeSubagentId("."), false);
  assert.equal(isSafeSubagentId(".."), false);
  assert.equal(isSafeSubagentId("safe\u0000name"), false);
  assert.equal(isSafeSubagentId("é".repeat(128)), false);
});

test("tail paging returns latest complete records and exposes earlier pages", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const transcriptFile = join(siblingDirForSession(sessionFile), "ScoutAgent.jsonl");
    const records = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ type: "message", id: "m" + i, parentId: null, timestamp: "2026-08-01T00:00:00.000Z", message: { role: "assistant", content: "line " + i } }));
    writeFileSync(transcriptFile, records.join("\n") + "\n");
    const tail = readSubagentTranscriptPage(transcriptFile, 0, { tail: true });
    assert.ok(tail.messages.length > 0);
    assert.match(String(tail.messages.at(-1)?.content), /line 2999/);
    assert.equal(tail.hasEarlier, true);
    const earlier = readSubagentTranscriptPage(transcriptFile, tail.fromByte, { before: true });
    assert.ok(earlier.messages.length > 0);
    assert.ok(earlier.fromByte < tail.fromByte);
    assert.match(String(earlier.messages.at(-1)?.content), /line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not follow artifact symlinks outside the sibling directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-subagent-history-"));
  const sessionFile = join(dir, "sess.jsonl");
  const artifactsDir = siblingDirForSession(sessionFile);
  const outside = join(dir, "outside.jsonl");
  mkdirSync(artifactsDir, { recursive: true });
  try {
    writeFileSync(outside, "private");
    symlinkSync(outside, join(artifactsDir, "Named Task.jsonl"));
    assert.equal(resolveSubagentArtifact(sessionFile, "Named Task", ".jsonl"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing transcript file yields an empty page", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-subagent-history-"));
  try {
    const page = readSubagentTranscriptPage(join(dir, "missing.jsonl"), 0);
    assert.equal(page.messages.length, 0);
    assert.equal(page.nextByte, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("completion reads keep complete trailing multibyte characters", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-subagent-completion-"));
  const sessionFile = join(dir, "sess.jsonl");
  const artifactsDir = siblingDirForSession(sessionFile);
  mkdirSync(artifactsDir, { recursive: true });
  try {
    writeFileSync(join(artifactsDir, "Scout.md"), "hello");
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Scout", ".md"))?.completion, "hello");
    writeFileSync(join(artifactsDir, "Scout.md"), "oké");
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Scout", ".md"))?.completion, "oké");
    writeFileSync(join(artifactsDir, "Scout.md"), "done😀");
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Scout", ".md"))?.completion, "done😀");
    // Missing file -> null; empty file -> null.
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Nope", ".md")), null);
    writeFileSync(join(artifactsDir, "Scout.md"), "");
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Scout", ".md")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completion caps materialized bytes without splitting a codepoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-subagent-completion-"));
  const sessionFile = join(dir, "sess.jsonl");
  const artifactsDir = siblingDirForSession(sessionFile);
  mkdirSync(artifactsDir, { recursive: true });
  try {
    // A file slightly over the cap ending with a 4-byte emoji: the read is
    // capped mid-emoji, and the partial sequence must be dropped, not shown.
    const prefix = "x".repeat(MAX_SUBAGENT_COMPLETION_BYTES);
    writeFileSync(join(artifactsDir, "Big.md"), prefix + "😀tail");
    const result = readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Big", ".md"));
    assert.equal(result?.truncated, true);
    assert.ok(result?.completion);
    assert.ok(result.completion.length <= MAX_SUBAGENT_COMPLETION_BYTES);
    assert.equal(result.completion.includes("�"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Range-read transcript pages
// ---------------------------------------------------------------------------

function userLine(id, content) {
  return JSON.stringify({ type: "message", id: String(id), parentId: null, timestamp: "2026-08-01T00:00:00.000Z", message: { role: "user", content } });
}

/** Byte offset of every line start in `buffer` (every line is `\n` terminated). */
function lineStarts(buffer) {
  const starts = [];
  let pos = 0;
  while (pos < buffer.length) {
    starts.push(pos);
    const nl = buffer.indexOf(0x0a, pos);
    pos = nl < 0 ? buffer.length : nl + 1;
  }
  return starts;
}

function withTempFile(body) {
  const dir = mkdtempSync(join(tmpdir(), "cody-subagent-pages-"));
  try {
    return body(join(dir, "T.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function walkForward(file) {
  const pages = [];
  let from = 0;
  for (;;) {
    const page = readSubagentTranscriptPage(file, from);
    pages.push(page);
    if (page.nextByte >= page.endByte) return pages;
    assert.ok(page.nextByte > from, "forward walk must make progress");
    from = page.nextByte;
  }
}

function walkBackward(file) {
  const pages = [readSubagentTranscriptPage(file, 0, { tail: true })];
  while (pages[0].fromByte > 0) {
    const page = readSubagentTranscriptPage(file, pages[0].fromByte, { before: true });
    assert.ok(page.fromByte < pages[0].fromByte, "backward walk must make progress");
    pages.unshift(page);
  }
  return pages;
}

/** Both walks must cover exactly `expectedOffsets`, contiguously, in order. */
function assertWalksCover(file, expectedOffsets) {
  const size = readFileSync(file).length;
  for (const [name, pages] of [["forward", walkForward(file)], ["backward", walkBackward(file)]]) {
    assert.equal(pages[0].fromByte, 0, `${name}: starts at 0`);
    assert.equal(pages.at(-1).nextByte, pages.at(-1).endByte, `${name}: ends at endByte`);
    for (let i = 1; i < pages.length; i++) {
      assert.equal(pages[i - 1].nextByte, pages[i].fromByte, `${name}: pages ${i - 1}/${i} are contiguous`);
    }
    for (const page of pages) {
      assert.equal(page.totalBytes, size);
      assert.equal(page.offsets.length, page.messages.length);
      assert.ok(page.nextByte - page.fromByte <= SUBAGENT_TRANSCRIPT_PAGE_BYTES || page.offsets.length === 1, "only a lone oversized line may exceed the page budget");
      assert.ok(page.messages.length <= SUBAGENT_TRANSCRIPT_PAGE_LINES);
    }
    assert.deepEqual(pages.flatMap((page) => page.offsets), expectedOffsets, `${name}: offsets`);
  }
}

test("tail page holds the newest complete lines and leaves a partial line out", () => {
  withTempFile((file) => {
    const complete = Array.from({ length: 5 }, (_, i) => userLine(i, `line ${i}`)).join("\n") + "\n";
    writeFileSync(file, complete + userLine(5, "still being written").slice(0, 40));
    const page = readSubagentTranscriptPage(file, 12345, { tail: true });
    assert.equal(page.fromByte, 0);
    assert.equal(page.endByte, Buffer.byteLength(complete));
    assert.equal(page.nextByte, page.endByte);
    assert.ok(page.totalBytes > page.endByte);
    assert.equal(page.hasEarlier, false);
    assert.deepEqual(page.messages.map((m) => m.content), ["line 0", "line 1", "line 2", "line 3", "line 4"]);
    assert.deepEqual(page.offsets, lineStarts(Buffer.from(complete)));
  });
});

test("before page ends at the boundary and aligns a mid-line boundary down", () => {
  withTempFile((file) => {
    const lines = Array.from({ length: 6 }, (_, i) => userLine(i, `row ${i}`));
    const buffer = Buffer.from(lines.join("\n") + "\n");
    writeFileSync(file, buffer);
    const starts = lineStarts(buffer);

    const exact = readSubagentTranscriptPage(file, starts[3], { before: true });
    assert.deepEqual(exact.messages.map((m) => m.content), ["row 0", "row 1", "row 2"]);
    assert.equal(exact.fromByte, 0);
    assert.equal(exact.nextByte, starts[3]);
    assert.equal(exact.hasEarlier, false);

    // Inside line 3: the page ends at the start of line 3, never splitting it.
    const mid = readSubagentTranscriptPage(file, starts[3] + 10, { before: true });
    assert.equal(mid.nextByte, starts[3]);
    assert.deepEqual(mid.offsets, starts.slice(0, 3));

    const none = readSubagentTranscriptPage(file, 0, { before: true });
    assert.deepEqual([none.messages.length, none.fromByte, none.nextByte, none.hasEarlier], [0, 0, 0, false]);

    // Past EOF clamps to the last complete line instead of resetting.
    const past = readSubagentTranscriptPage(file, buffer.length + 999, { before: true });
    assert.equal(past.reset, false);
    assert.equal(past.nextByte, buffer.length);
    assert.equal(past.messages.length, 6);
  });
});

test("forward paging after the file grows delivers appended lines exactly once", () => {
  withTempFile((file) => {
    writeFileSync(file, userLine(0, "a") + "\n" + userLine(1, "b") + "\n");
    const first = readSubagentTranscriptPage(file, 0, { tail: true });
    assert.deepEqual(first.messages.map((m) => m.content), ["a", "b"]);

    appendFileSync(file, userLine(2, "c") + "\n" + userLine(3, "d") + "\n");
    const second = readSubagentTranscriptPage(file, first.nextByte);
    assert.deepEqual(second.messages.map((m) => m.content), ["c", "d"]);

    const half = userLine(4, "e");
    appendFileSync(file, half.slice(0, 30));
    const third = readSubagentTranscriptPage(file, second.nextByte);
    assert.deepEqual(third.messages, []);
    assert.equal(third.nextByte, second.nextByte, "a partial line makes no progress");
    assert.ok(third.totalBytes > third.endByte);

    appendFileSync(file, half.slice(30) + "\n");
    const fourth = readSubagentTranscriptPage(file, third.nextByte);
    assert.deepEqual(fourth.messages.map((m) => m.content), ["e"]);
    assert.equal(fourth.nextByte, fourth.endByte);

    const fifth = readSubagentTranscriptPage(file, fourth.nextByte);
    assert.deepEqual([fifth.messages.length, fifth.nextByte], [0, fourth.nextByte]);
  });
});

test("a mid-line cursor aligns down to its line start and unparseable lines are skipped", () => {
  withTempFile((file) => {
    const lines = [userLine(0, "x"), "{not json", "", userLine(3, "y")];
    const buffer = Buffer.from(lines.join("\n") + "\n");
    writeFileSync(file, buffer);
    const starts = lineStarts(buffer);
    const page = readSubagentTranscriptPage(file, starts[1] + 3);
    assert.equal(page.fromByte, starts[1]);
    assert.deepEqual(page.messages.map((m) => m.content), ["y"]);
    assert.deepEqual(page.offsets, [starts[3]]);
    assert.equal(page.nextByte, buffer.length);
  });
});

test("a transcript over the old 16 MB limit pages without error and both walks agree", () => {
  withTempFile((file) => {
    const parts = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let total = 0;
    for (let i = 0; total < 18 * 1024 * 1024; i++) {
      const chars = 1024 + Math.floor(rand() * 99 * 1024);
      const text = i % 3 === 0 ? "日本語の文章".repeat(Math.ceil(chars / 6)).slice(0, chars) : "abc é".repeat(Math.ceil(chars / 5)).slice(0, chars);
      const line = Buffer.from(userLine(i, text) + "\n");
      parts.push(line);
      total += line.length;
    }
    const buffer = Buffer.concat(parts);
    writeFileSync(file, buffer);

    const tail = readSubagentTranscriptPage(file, 0, { tail: true });
    assert.equal(tail.error, undefined);
    assert.ok(tail.totalBytes > 16 * 1024 * 1024);
    assert.ok(tail.messages.length > 0);
    assert.equal(tail.nextByte, buffer.length);
    assertWalksCover(file, lineStarts(buffer));
  });
});

test("a line larger than the page budget comes back whole", () => {
  withTempFile((file) => {
    // 24 x 30K-char blocks: ~720 KB on one line, but no single string is cut.
    const blocks = Array.from({ length: 24 }, (_, i) => ({ type: "text", text: `${i}:` + "é".repeat(30_000) }));
    const big = userLine("big", blocks);
    assert.ok(Buffer.byteLength(big) > 2 * SUBAGENT_TRANSCRIPT_PAGE_BYTES);
    const buffer = Buffer.from([userLine(0, "before"), big, userLine(2, "after")].join("\n") + "\n");
    writeFileSync(file, buffer);
    const starts = lineStarts(buffer);

    const pages = walkForward(file);
    assert.deepEqual(pages.map((p) => p.messages.length), [1, 1, 1]);
    assert.deepEqual(pages[1].messages[0].content, blocks);
    assert.deepEqual(pages[1].offsets, [starts[1]]);

    const tail = readSubagentTranscriptPage(file, 0, { tail: true });
    assert.deepEqual(tail.messages.map((m) => m.content), ["after"]);
    const middle = readSubagentTranscriptPage(file, tail.fromByte, { before: true });
    assert.deepEqual(middle.messages[0].content, blocks);
    assertWalksCover(file, starts);
  });
});

test("over-long rendered text is cut with a visible marker", () => {
  withTempFile((file) => {
    const text = "z".repeat(MAX_SUBAGENT_MESSAGE_TEXT_CHARS + 5 * 1024);
    writeFileSync(file, userLine(0, text) + "\n");
    const [message] = readSubagentTranscriptPage(file, 0).messages;
    assert.equal(message.content, "z".repeat(MAX_SUBAGENT_MESSAGE_TEXT_CHARS) + "\n\n… truncated (5 KB more not shown)");
  });
});

test("a line over the line cap is one placeholder and paging crosses it both ways", () => {
  withTempFile((file) => {
    const huge = Buffer.concat([Buffer.alloc(MAX_SUBAGENT_TRANSCRIPT_LINE_BYTES + 1024 * 1024, 0x78), Buffer.from("\n")]);
    const buffer = Buffer.concat([Buffer.from(userLine(0, "first") + "\n"), huge, Buffer.from(userLine(2, "last") + "\n")]);
    writeFileSync(file, buffer);
    const starts = lineStarts(buffer);
    assert.equal(starts.length, 3);

    const forward = walkForward(file);
    assert.deepEqual(forward.flatMap((p) => p.offsets), starts);
    const placeholder = forward.flatMap((p) => p.messages)[1];
    assert.equal(placeholder.role, "custom");
    assert.equal(placeholder.customType, "Entry omitted");
    assert.equal(placeholder.display, true);
    assert.equal(placeholder.content, "… entry too large to display (9.0 MB)");

    const backward = walkBackward(file);
    assert.deepEqual(backward.flatMap((p) => p.offsets), starts);
    assertWalksCover(file, starts);

    // Cursors that land inside the huge line align down to its start.
    const inside = readSubagentTranscriptPage(file, starts[1] + 5_000_000);
    assert.equal(inside.fromByte, starts[1]);
    assert.equal(inside.messages[0].customType, "Entry omitted");
    assert.equal(inside.nextByte, starts[2]);
  });
});

test("the line cap keeps the lines nearest the boundary", () => {
  withTempFile((file) => {
    const lines = Array.from({ length: 3000 }, (_, i) => userLine(i, `n${i}`));
    const buffer = Buffer.from(lines.join("\n") + "\n");
    writeFileSync(file, buffer);
    const starts = lineStarts(buffer);

    const forward = readSubagentTranscriptPage(file, 0);
    assert.equal(forward.messages.length, SUBAGENT_TRANSCRIPT_PAGE_LINES);
    assert.equal(forward.nextByte, starts[SUBAGENT_TRANSCRIPT_PAGE_LINES]);

    const tail = readSubagentTranscriptPage(file, 0, { tail: true });
    assert.equal(tail.messages.length, SUBAGENT_TRANSCRIPT_PAGE_LINES);
    assert.equal(tail.messages.at(-1).content, "n2999");
    assert.equal(tail.messages[0].content, "n2800");

    const before = readSubagentTranscriptPage(file, starts[1000], { before: true });
    assert.deepEqual([before.messages[0].content, before.messages.at(-1).content], ["n800", "n999"]);
    assertWalksCover(file, starts);
  });
});

test("lines that exactly fill a page end the page on a line boundary", () => {
  withTempFile((file) => {
    const lineBytes = 2048;
    const padded = (i) => {
      const base = Buffer.byteLength(userLine(String(i).padStart(4, "0"), ""));
      return userLine(String(i).padStart(4, "0"), "p".repeat(lineBytes - 1 - base));
    };
    const buffer = Buffer.from(Array.from({ length: 300 }, (_, i) => padded(i)).join("\n") + "\n");
    assert.equal(buffer.length, 300 * lineBytes);
    writeFileSync(file, buffer);
    const forward = readSubagentTranscriptPage(file, 0);
    assert.equal(forward.messages.length, SUBAGENT_TRANSCRIPT_PAGE_BYTES / lineBytes);
    assert.equal(forward.nextByte, SUBAGENT_TRANSCRIPT_PAGE_BYTES);
    const tail = readSubagentTranscriptPage(file, 0, { tail: true });
    assert.equal(tail.messages.length, SUBAGENT_TRANSCRIPT_PAGE_BYTES / lineBytes);
    assertWalksCover(file, lineStarts(buffer));
  });
});

test("page boundaries that fall inside multi-byte characters never split a line or character", () => {
  const alphabet = ["a", "é", "日", "本", "語", "😀", "𝒳", " "];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    withTempFile((file) => {
      let state = seed * 2654435761;
      const rand = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
      const texts = [];
      const buffers = [];
      let total = 0;
      // Line lengths straddle the page budget (some tiny, some larger than a page).
      const maxChars = [300, 5_000, 40_000, 60_000][seed % 4];
      for (let i = 0; total < 3 * 1024 * 1024; i++) {
        const n = 1 + Math.floor(rand() * maxChars);
        let text = "";
        for (let c = 0; c < n; c++) text += alphabet[Math.floor(rand() * alphabet.length)];
        // Keep each string under the display cut so content can be compared.
        text = text.slice(0, MAX_SUBAGENT_MESSAGE_TEXT_CHARS - 2);
        text = text.replace(/[\ud800-\udbff]$/, "");
        texts.push(text);
        const line = Buffer.from(userLine(i, text) + "\n");
        buffers.push(line);
        total += line.length;
      }
      const buffer = Buffer.concat(buffers);
      writeFileSync(file, buffer);
      assertWalksCover(file, lineStarts(buffer));
      for (const [name, pages] of [["forward", walkForward(file)], ["backward", walkBackward(file)]]) {
        assert.deepEqual(pages.flatMap((p) => p.messages.map((m) => m.content)), texts, `${name} seed ${seed}: decoded text`);
      }
    });
  }
});

test("an unreadable path yields an empty page for every mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-subagent-pages-"));
  try {
    for (const options of [{}, { tail: true }, { before: true }]) {
      const page = readSubagentTranscriptPage(join(dir, "nope.jsonl"), 77, options);
      assert.deepEqual(page, { sessionFile: join(dir, "nope.jsonl"), fromByte: 77, nextByte: 77, reset: false, messages: [], hasEarlier: false });
    }
    // A directory opens fine but cannot be read: still an empty page, no throw.
    const page = readSubagentTranscriptPage(dir, 0);
    assert.deepEqual([page.messages.length, page.nextByte], [0, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slimSubagentMessage drops provider blobs and returns untouched messages as-is", () => {
  const assistant = {
    role: "assistant",
    model: "m",
    provider: "p",
    providerPayload: { encrypted: "x".repeat(100) },
    content: [
      { type: "thinking", thinking: "hmm", thinkingSignature: "s".repeat(1000) },
      { type: "text", text: "hello" },
      { type: "toolCall", toolCallId: "t1", toolName: "read", input: { path: "a.ts" } },
    ],
  };
  const slim = slimSubagentMessage(assistant);
  assert.equal("providerPayload" in slim, false);
  assert.deepEqual(slim.content[0], { type: "thinking", thinking: "hmm" });
  assert.equal(slim.content[1], assistant.content[1], "clean blocks keep their identity");
  assert.equal(slim.content[2], assistant.content[2]);
  assert.ok("providerPayload" in assistant, "the input is never mutated");
  assert.equal(assistant.content[0].thinkingSignature.length, 1000);

  const user = { role: "user", content: [{ type: "text", text: "short" }] };
  assert.equal(slimSubagentMessage(user), user);
  const plain = { role: "assistant", model: "m", provider: "p", content: [{ type: "text", text: "ok" }] };
  assert.equal(slimSubagentMessage(plain), plain);
  const result = { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }] };
  assert.equal(slimSubagentMessage(result), result);
});

test("slimSubagentMessage cuts every rendered string kind and nested tool input", () => {
  const long = "q".repeat(MAX_SUBAGENT_MESSAGE_TEXT_CHARS + 2048);
  const marker = "\n\n… truncated (2 KB more not shown)";
  const cutValue = "q".repeat(MAX_SUBAGENT_MESSAGE_TEXT_CHARS) + marker;

  const assistant = slimSubagentMessage({
    role: "assistant",
    model: "m",
    provider: "p",
    content: [
      { type: "text", text: long },
      { type: "thinking", thinking: long },
      { type: "toolCall", toolCallId: "t", toolName: "write", input: { path: "f", edits: [{ content: long, keep: "same" }], meta: { deep: { text: long } } } },
    ],
  });
  assert.equal(assistant.content[0].text, cutValue);
  assert.equal(assistant.content[1].thinking, cutValue);
  const input = assistant.content[2].input;
  assert.equal(input.edits[0].content, cutValue);
  assert.equal(input.edits[0].keep, "same");
  assert.equal(input.meta.deep.text, cutValue);
  assert.equal(input.path, "f");

  // The tool input the engine wrote is not touched.
  const original = { edits: [{ content: long }] };
  slimSubagentMessage({ role: "assistant", model: "m", provider: "p", content: [{ type: "toolCall", toolCallId: "t", toolName: "w", input: original }] });
  assert.equal(original.edits[0].content, long);

  assert.equal(slimSubagentMessage({ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: long }] }).content[0].text, cutValue);
  assert.equal(slimSubagentMessage({ role: "user", content: long }).content, cutValue);
  assert.equal(slimSubagentMessage({ role: "developer", content: long }).content, cutValue);
  assert.equal(slimSubagentMessage({ role: "custom", customType: "x", display: true, content: long }).content, cutValue);
  assert.equal(slimSubagentMessage({ role: "bashExecution", command: "ls", output: long }).output, cutValue);
});

test("slimSubagentMessage cuts text on a code point boundary", () => {
  // The 64K cut would fall between the halves of a surrogate pair.
  const text = "a".repeat(MAX_SUBAGENT_MESSAGE_TEXT_CHARS - 1) + "😀" + "b".repeat(3000);
  const cut = slimSubagentMessage({ role: "user", content: text }).content;
  const kept = cut.slice(0, cut.indexOf("\n\n… truncated"));
  assert.equal(kept, "a".repeat(MAX_SUBAGENT_MESSAGE_TEXT_CHARS - 1));
  assert.equal(/[\ud800-\udbff]$/.test(kept), false);
});

test("slimSubagentMessage replaces only oversized inline images", () => {
  const small = { type: "image", data: "A".repeat(1000), mimeType: "image/png" };
  const flat = { type: "image", data: "A".repeat(MAX_SUBAGENT_INLINE_IMAGE_CHARS + 4), mimeType: "image/png" };
  const nested = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(MAX_SUBAGENT_INLINE_IMAGE_CHARS * 2) } };
  const unknown = { type: "image", data: "A".repeat(MAX_SUBAGENT_INLINE_IMAGE_CHARS + 1) };
  const message = slimSubagentMessage({ role: "toolResult", toolCallId: "t", content: [small, flat, nested, unknown] });
  assert.equal(message.content[0], small);
  assert.deepEqual(message.content[1], { type: "text", text: `[image omitted: image/png, ~${Math.round(((MAX_SUBAGENT_INLINE_IMAGE_CHARS + 4) * 3) / 4 / 1024)} KB]` });
  assert.deepEqual(message.content[2], { type: "text", text: "[image omitted: image/jpeg, ~768 KB]" });
  assert.match(message.content[3].text, /^\[image omitted: ~\d+ KB\]$/);
});

test("slimSubagentMessage keeps small custom details and drops oversized ones", () => {
  const small = { role: "custom", customType: "x", display: true, content: "hi", details: { a: 1 } };
  assert.equal(slimSubagentMessage(small), small);
  const bigDetails = { role: "custom", customType: "x", display: true, content: "hi", details: { blob: "d".repeat(70 * 1024) } };
  const slim = slimSubagentMessage(bigDetails);
  assert.equal("details" in slim, false);
  assert.equal(slim.content, "hi");
  assert.ok("details" in bigDetails);
});

test("transcript pages carry the slimmed message, not the provider payload", () => {
  withTempFile((file) => {
    const assistant = {
      type: "message", id: "a", parentId: null, timestamp: "2026-08-01T00:00:00.000Z",
      message: {
        role: "assistant", model: "m", provider: "p", providerPayload: { blob: "e".repeat(5000) },
        content: [{ type: "thinking", thinking: "t", thinkingSignature: "s".repeat(5000) }, { type: "text", text: "done" }],
      },
    };
    writeFileSync(file, JSON.stringify(assistant) + "\n");
    const [message] = readSubagentTranscriptPage(file, 0).messages;
    assert.equal(JSON.stringify(message).includes("eeeee"), false);
    assert.equal(JSON.stringify(message).includes("sssss"), false);
    assert.equal(message.content[1].text, "done");
  });
});
