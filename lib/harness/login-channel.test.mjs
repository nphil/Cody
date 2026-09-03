import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createLoginValueChannel } = await jiti.import("./login-channel.ts");

test("a value pasted before anyone asks is held for the first asker", async () => {
  const channel = createLoginValueChannel();
  channel.submit("http://localhost:1455/auth/callback?code=abc");
  assert.equal(await channel.next(), "http://localhost:1455/auth/callback?code=abc");
});

test("the oldest waiter gets the next value, in order", async () => {
  const channel = createLoginValueChannel();
  const first = channel.next();
  const second = channel.next();
  channel.submit("one");
  channel.submit("two");
  assert.equal(await first, "one");
  assert.equal(await second, "two");
});

test("cancel rejects every waiter and every later ask, so no driver hangs on a closed stream", async () => {
  const channel = createLoginValueChannel();
  const pending = channel.next();
  channel.cancel();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(channel.next(), /cancelled/);
});
