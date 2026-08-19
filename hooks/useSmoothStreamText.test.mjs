import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  createStreamPacer,
  shouldPaceStream,
  useSmoothStreamText,
  splitMarkdownReveal,
  splitPlainReveal,
  chunkRevealWords,
} = await jiti.import("./useSmoothStreamText.ts");
const { MessageView } = await jiti.import("../components/MessageView.tsx");

const FRAME_MS = 16.7;

/** Run the pacer at a simulated 60fps until it catches up. */
function drain(pacer, maxFrames = 240) {
  let now = 0;
  let frames = 0;
  while (!pacer.caughtUp() && frames < maxFrames) {
    now += FRAME_MS;
    pacer.tick(now);
    frames += 1;
  }
  return frames;
}

test("first push after arming snaps: a block mounting mid-stream shows current text", () => {
  const pacer = createStreamPacer();
  pacer.push("already streamed text");
  assert.equal(pacer.text(), "already streamed text");
  assert.ok(pacer.caughtUp());
});

test("paced growth is prefix-monotonic and prefers whole-word cuts", () => {
  const full = "The quick brown fox jumps over the lazy dog while the reveal keeps pace with it.";
  const pacer = createStreamPacer();
  pacer.push("");
  pacer.push(full);
  assert.equal(pacer.text(), "", "backlog is not revealed before the first tick");
  let prev = "";
  let now = 0;
  while (!pacer.caughtUp()) {
    now += FRAME_MS;
    pacer.tick(now);
    const cur = pacer.text();
    assert.ok(cur.startsWith(prev), "displayed text must only append");
    assert.ok(cur.length > prev.length, "every tick with backlog makes progress");
    if (!pacer.caughtUp()) {
      // Every word in this sample is shorter than the lookahead, so each cut
      // lands right before whitespace: words pop whole.
      assert.match(full[cur.length], /\s/);
    }
    prev = cur;
  }
  assert.equal(prev, full);
});

test("a batched backlog is fully revealed within ~300ms", () => {
  const seed = "intro.";
  const full = `${seed} ${"stream words arriving ".repeat(19).trim()}`; // ~420 char backlog
  const pacer = createStreamPacer();
  pacer.push(seed);
  pacer.push(full);
  const frames = drain(pacer);
  assert.ok(pacer.caughtUp());
  assert.ok(frames * FRAME_MS <= 300, `catch-up took ${(frames * FRAME_MS).toFixed(0)}ms`);
});

test("display lag stays bounded under giant bursts and fast streams", () => {
  const pacer = createStreamPacer();
  pacer.push("");
  const burst = "word ".repeat(10_000);
  pacer.push(burst);
  // A pathological 50KB batch snaps most of the way instantly instead of
  // animating for seconds.
  assert.ok(burst.length - pacer.text().length <= 2000);
  let text = burst;
  let now = 0;
  for (let i = 0; i < 120; i += 1) {
    text += "more words keep arriving very quickly in this stream. ".repeat(3); // ~9900 chars/s
    pacer.push(text);
    now += FRAME_MS;
    pacer.tick(now);
    assert.ok(text.length - pacer.text().length <= 2000, `lag exceeded cap at frame ${i}`);
  }
});

test("a target reset snaps immediately and never replays", () => {
  const pacer = createStreamPacer();
  pacer.push("a");
  pacer.push("a long first answer that is still being revealed when the next turn begins");
  pacer.tick(FRAME_MS);
  assert.ok(!pacer.caughtUp());
  pacer.push("Fresh start");
  assert.equal(pacer.text(), "Fresh start");
  assert.ok(pacer.caughtUp());
  // A shrink of the current text is also a reset, never a negative backlog.
  pacer.push("Fre");
  assert.equal(pacer.text(), "Fre");
  assert.ok(pacer.caughtUp());
});

test("flush pays all animation debt at once", () => {
  const full = `x ${"backlog ".repeat(30)}`;
  const pacer = createStreamPacer();
  pacer.push("x");
  pacer.push(full);
  assert.ok(!pacer.caughtUp());
  pacer.flush();
  assert.equal(pacer.text(), full);
  assert.ok(pacer.caughtUp());
});

test("reduced motion, settled transcripts, and superseded blocks read instantly", () => {
  assert.equal(shouldPaceStream({ isStreaming: true, isActiveBlock: true, prefersReducedMotion: false }), true);
  assert.equal(shouldPaceStream({ isStreaming: true, isActiveBlock: true, prefersReducedMotion: true }), false);
  assert.equal(shouldPaceStream({ isStreaming: false, isActiveBlock: true, prefersReducedMotion: false }), false);
  assert.equal(shouldPaceStream({ isStreaming: true, isActiveBlock: false, prefersReducedMotion: false }), false);
});

test("useSmoothStreamText returns the target verbatim on the instant path", () => {
  function Probe({ text, paced }) {
    return React.createElement("span", null, useSmoothStreamText(text, paced));
  }
  assert.match(renderToStaticMarkup(React.createElement(Probe, { text: "instant text", paced: false })), />instant text</);
  // Before the pacing effect arms (first paint), the paced path also shows
  // the live target — never stale or partial text.
  assert.match(renderToStaticMarkup(React.createElement(Probe, { text: "first paint", paced: true })), />first paint</);
});

test("markdown split keeps the tail to one safe partial line", () => {
  assert.deepEqual(splitMarkdownReveal("Hello wor"), { prefix: "", tail: "Hello wor", tailOffset: 0, paragraphGap: false });
  const para = splitMarkdownReveal("First paragraph.\n\nSecond in fli");
  assert.equal(para.prefix, "First paragraph.\n\n");
  assert.equal(para.tail, "Second in fli");
  assert.equal(para.paragraphGap, true);
  const list = splitMarkdownReveal("- one\n- tw");
  assert.equal(list.prefix, "- one\n");
  assert.equal(list.tail, "- tw");
  assert.equal(list.paragraphGap, false);
});

test("fences and fence openers render as prefix only; long lines stay in the tail", () => {
  const open = splitMarkdownReveal("Intro:\n```ts\nconst a = 1;\nconst b");
  assert.equal(open.tail, "");
  assert.equal(open.prefix, "Intro:\n```ts\nconst a = 1;\nconst b");
  const closed = splitMarkdownReveal("```ts\nconst a = 1;\n```\nAnd th");
  assert.equal(closed.prefix, "```ts\nconst a = 1;\n```\n");
  assert.equal(closed.tail, "And th");
  // An opener still missing its newline must not render as plain spans.
  assert.equal(splitMarkdownReveal("Intro:\n```ts").tail, "");
  // A ``` line inside a ~~~ fence is content, not a closer.
  assert.equal(splitMarkdownReveal("~~~\ncode\n```\nstill code").tail, "");
  // An unbroken long paragraph stays in the tail: switching it to the
  // time-sampled markdown path mid-flight would blank it for a frame. The
  // renderer bounds span count by windowing, not the splitter.
  const longLine = `done\n${"word ".repeat(200)}`;
  assert.equal(splitMarkdownReveal(longLine).tail, "word ".repeat(200));
});

test("chunk keys are character offsets, stable while the tail grows", () => {
  const before = chunkRevealWords("hello wo", 100);
  const after = chunkRevealWords("hello world and", 100);
  assert.deepEqual(before.map((c) => c.key), [100, 106]);
  assert.deepEqual(after.map((c) => c.key), [100, 106, 112]);
  assert.equal(after.map((c) => c.text).join(""), "hello world and");
});

test("plain split keeps a trailing word-aligned window animated", () => {
  const short = splitPlainReveal("brief thought");
  assert.equal(short.prefix, "");
  assert.equal(short.tail, "brief thought");
  const long = "word ".repeat(100).trim();
  const split = splitPlainReveal(long);
  assert.equal(split.prefix + split.tail, long);
  assert.ok(split.tail.length <= 200);
  assert.match(long[split.tailOffset - 1], /\s/);
  assert.match(long[split.tailOffset], /\S/);
});

test("committed messages render full text instantly with no animation classes", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Committed answer with **bold** words.\n\nAnd a second paragraph." }],
    model: "test-model",
  };
  const html = renderToStaticMarkup(React.createElement(MessageView, { message }));
  assert.match(html, /Committed answer with/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /And a second paragraph\./);
  assert.doesNotMatch(html, /stream-word|stream-reveal/);
});

test("a streaming message's first paint shows the full current text", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Streamed so far without loss." }],
    model: "test-model",
  };
  const html = renderToStaticMarkup(React.createElement(MessageView, { message, isStreaming: true }));
  assert.match(html.replace(/<[^>]+>/g, ""), /Streamed so far without loss\./);
});

test("an unbroken streaming paragraph keeps a bounded animated span window", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: `Prelude line done.\n${"steady words keep arriving here ".repeat(30)}` }],
    model: "test-model",
  };
  const html = renderToStaticMarkup(React.createElement(MessageView, { message, isStreaming: true }));
  const spanCount = (html.match(/stream-word/g) ?? []).length;
  assert.ok(spanCount > 0, "the trailing window must animate");
  assert.ok(spanCount <= 60, `span count must stay windowed, got ${spanCount}`);
  // Nothing is lost between the static tail text and the animated window.
  assert.match(html.replace(/<[^>]+>/g, ""), /steady words keep arriving here steady words/);
});

test("per-frame split scan cost stays micro even on long documents", () => {
  const doc = `${"A paragraph of steady prose that keeps arriving with more words. ".repeat(9)}\n\n`.repeat(50);
  const target = `${doc}and the current line still grow`;
  const iterations = 500;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) splitMarkdownReveal(target);
  const usPerCall = Number(process.hrtime.bigint() - t0) / 1000 / iterations;
  console.log(`splitMarkdownReveal over ${(target.length / 1024).toFixed(1)}KB: ${usPerCall.toFixed(1)}µs/call`);
  assert.ok(usPerCall < 2000, "the split scan must stay far under a frame budget");
});
