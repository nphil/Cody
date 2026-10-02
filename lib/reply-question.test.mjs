import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { replyAsksUser, assistantReplyText } = await jiti.import("./reply-question.ts");

// The bug this guards: omp's todo reminder only reads the reply's LAST line
// before auto-continuing, so a question anywhere earlier is overridden and the
// agent proceeds as if the user had answered.

test("a question mid-reply followed by a summary line still asks the user", () => {
  const reply = [
    "I found two candidate configs.",
    "",
    "Which one should I migrate first?",
    "",
    "Summary: both are reachable; nothing changed yet.",
  ].join("\n");
  assert.equal(replyAsksUser(reply), true);
});

test("a question on the last line asks the user", () => {
  assert.equal(replyAsksUser("Done with the first pass.\nDo you want me to continue with the tests?"), true);
});

test("a CJK question asks the user", () => {
  assert.equal(replyAsksUser("設定を確認しました。\n次はどのファイルを変更しますか？"), true);
});

test("a TypeScript optional-property line is code, not a question", () => {
  assert.equal(replyAsksUser("Added the field:\n  retries?: number\nto the options interface."), false);
});

test("a plain statement reply asks nothing", () => {
  assert.equal(replyAsksUser("Migrated both callers and removed the shim.\nAll three locale files updated."), false);
});

test("a question inside a fenced code block is ignored", () => {
  const reply = [
    "Here is the prompt template:",
    "```",
    "What would you like to do next?",
    "```",
    "Wired it into the CLI.",
  ].join("\n");
  assert.equal(replyAsksUser(reply), false);
});

test("a question inside a bullet asks the user", () => {
  assert.equal(replyAsksUser("Open decisions:\n- Which do you prefer: A or B?\n- Nothing else blocks."), true);
});

test("a response cue without a question mark asks the user", () => {
  assert.equal(replyAsksUser("Two options are viable.\nPlease confirm before I delete the old table."), true);
});

test("a URL carrying a query string is not a question", () => {
  assert.equal(replyAsksUser("Preview: http://localhost:3000/?tab=logs\nThe page renders."), false);
});

test("assistantReplyText reads only assistant message_end text blocks", () => {
  const frame = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "should I ask?" },
        { type: "text", text: "Which branch?" },
        { type: "toolCall", id: "t1", name: "read" },
        { type: "text", text: "Reading now." },
      ],
    },
  };
  assert.equal(assistantReplyText(frame), "Which branch?\nReading now.");
  assert.equal(assistantReplyText({ type: "message_end", message: { role: "user", content: "hi?" } }), null);
  assert.equal(assistantReplyText({ type: "agent_end" }), null);
});

// Real misses from a long hardware session: the hand-off sat mid-line or under
// a "what you need to do" label, so the todo reminder carried on regardless.

test("a hand-off buried at the end of a long numbered step asks the user", () => {
  const reply = [
    "Built and installed the new rootfs.",
    "",
    "**What you need to do:**",
    "1. Unplug the USB cable; it's no longer needed.",
    '2. **Optional live test of the Wi-Fi picker:** rename your travel router back to "minibeast". Then restart the Show and watch the picker. Tell me if you want to try it now or later.',
  ].join("\n");
  assert.equal(replyAsksUser(reply), true);
});

test("a user-action label with its list on the next lines asks the user", () => {
  assert.equal(replyAsksUser("Finished the install.\n\n**What you need to do:**\n1. Unplug the USB cable."), true);
});

test("a bold cue in the middle of a step asks the user", () => {
  assert.equal(replyAsksUser('3. Tell me **"next"** and I\'ll switch to setting B.'), true);
  assert.equal(replyAsksUser('Pick a layout, then say "next" when you are happy with it.'), true);
});

test("mid-sentence response cues ask the user", () => {
  assert.equal(replyAsksUser("Both layouts work. Let me know which one you like."), true);
  assert.equal(replyAsksUser("I can ship it now, or wait. It's your call."), true);
  assert.equal(replyAsksUser("Done with the rename; if you want me to, I'll also update the docs."), true);
  assert.equal(replyAsksUser("The build is green so I stopped here, reply with the next target when ready."), true);
});

test("user-action labels of every phrasing count when content follows", () => {
  for (const label of ["Your turn:", "## Next step for you", "**Action needed**", "Action required: restart the box"]) {
    assert.equal(replyAsksUser(`All set.\n\n${label}\nRestart the TV.`), true, label);
  }
});

test("a user-action section that says nothing is needed does not ask", () => {
  assert.equal(replyAsksUser("All merged.\n\n**What you need to do:** nothing"), false);
  assert.equal(replyAsksUser("All merged.\n\n**What you need to do:**\nNone — everything is done.\n\n**Details:**\nThree files."), false);
  assert.equal(replyAsksUser("## Action needed\n\nNothing needed."), false);
});

test("a user-action label with only a code block under it still asks", () => {
  assert.equal(replyAsksUser("Run this on the TV:\n\n**What you need to do:**\n```sh\nreboot\n```"), true);
});

test("a label followed directly by another heading has no content", () => {
  assert.equal(replyAsksUser("**Your turn:**\n\n**Summary:**\nDone."), false);
});

test("self-directed and quoted cues do not ask", () => {
  assert.equal(replyAsksUser("I'll tell the agent to let me know when the build ends."), false);
  assert.equal(replyAsksUser("The subagent will tell me once it has finished."), false);
  assert.equal(replyAsksUser('The dialog reads "Tell me what you need" and the toast says "should I save?".'), false);
  assert.equal(replyAsksUser("Users sometimes want me to repeat myself, which the fix prevents."), false);
});

test("cues inside inline code or a fence are ignored", () => {
  assert.equal(replyAsksUser("The helper prints `let me know when done` on exit."), false);
  assert.equal(replyAsksUser("Template:\n```\n**What you need to do:**\nTell me next\n```\nWired."), false);
});
