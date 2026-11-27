import assert from "node:assert/strict";
import test from "node:test";
import { WeightedLru } from "./session-parse-cache.ts";

test("evicts least recently used entries until the total weight fits", () => {
  const cache = new WeightedLru(100);
  cache.set("a", "g", "A", 40);
  cache.set("b", "g", "B", 40);
  assert.equal(cache.get("a"), "A", "a read makes it the newest");
  cache.set("c", "g", "C", 40);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "A");
  assert.equal(cache.get("c"), "C");
  assert.equal(cache.weight, 80);
});

test("an entry over the whole budget is refused, drops its older self, and evicts nobody else", () => {
  const cache = new WeightedLru(100);
  cache.set("a", "g", "A", 30);
  cache.set("big", "g", "old", 50);
  assert.equal(cache.set("big", "g", "new", 101), false);
  assert.equal(cache.get("big"), undefined);
  assert.equal(cache.get("a"), "A");
  assert.equal(cache.weight, 30);
});

test("group caps apply inside the shared budget", () => {
  const cache = new WeightedLru(1_000, { loaded: 2 });
  cache.set("l1", "loaded", 1, 10);
  cache.set("e1", "entries", 2, 10);
  cache.set("l2", "loaded", 3, 10);
  cache.set("l3", "loaded", 4, 10);
  assert.equal(cache.get("l1"), undefined, "oldest of the capped group went");
  assert.equal(cache.get("e1"), 2, "another group is untouched");
  assert.equal(cache.size, 3);
  assert.equal(cache.weight, 30);
});

test("replacing and deleting keep the weight exact", () => {
  const cache = new WeightedLru(100, { g: 5 });
  cache.set("a", "g", 1, 30);
  cache.set("a", "g", 2, 20);
  assert.equal(cache.weight, 20);
  cache.delete("a");
  cache.delete("a");
  assert.equal(cache.weight, 0);
  assert.equal(cache.size, 0);
  cache.set("b", "g", 3, 10);
  cache.clear();
  assert.equal(cache.weight, 0);
});
