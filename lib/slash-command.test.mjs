import assert from "node:assert/strict";
import test from "node:test";

test("recognizes a slash command at the start of a prompt", async () => {
  const { extractSlashQuery } = await import("./slash-command.ts");
  assert.deepEqual(extractSlashQuery("/skill", 6), {
    start: 0,
    end: 6,
    query: "skill",
  });
});

test("recognizes a slash command after whitespace and preserves its token bounds", async () => {
  const { extractSlashQuery } = await import("./slash-command.ts");
  assert.deepEqual(extractSlashQuery("use /Sk", 7), {
    start: 4,
    end: 7,
    query: "sk",
  });
  assert.deepEqual(extractSlashQuery("use /", 5), {
    start: 4,
    end: 5,
    query: "",
  });
});

test("does not treat punctuation or a completed later word as a slash command", async () => {
  const { extractSlashQuery } = await import("./slash-command.ts");
  assert.equal(extractSlashQuery("https://example.test", 20), null);
  assert.equal(extractSlashQuery("use /skill argument"), null);
});
