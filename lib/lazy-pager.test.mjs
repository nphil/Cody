import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createLazyPager, INITIAL_LAZY_PAGER_STATE } = await jiti.import("./lazy-pager.ts");
const { sliceLazyPage } = await jiti.import("./lazy-blocks.ts");

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A fake detail route over `text` that records every request and can be told to fail. */
function server(text, size = 4) {
  const requests = [];
  const failures = [];
  const fetchPage = (page, signal) => {
    requests.push({ page, signal });
    if (failures.length > 0) return Promise.reject(failures.shift());
    const slice = sliceLazyPage(text, page, size);
    return slice ? Promise.resolve(slice) : Promise.reject(new Error("HTTP 404"));
  };
  return { fetchPage, requests, failures };
}

test("the first page loads on go(0) and nothing else is asked for", async () => {
  const fake = server("abcdefghij");
  const pager = createLazyPager(fake.fetchPage);
  assert.deepEqual(pager.getState(), INITIAL_LAZY_PAGER_STATE);
  pager.go(0);
  assert.equal(pager.getState().loading, true);
  await settle();
  assert.deepEqual(pager.getState(), { page: 0, pages: 3, total: 10, text: "abcd", loading: false, failed: false });
  assert.deepEqual(fake.requests.map((r) => r.page), [0]);
});

test("next, previous, last and first walk a text past 1 MiB and back, one 64 KiB page at a time", async () => {
  // 8 characters per number: every page's text is different, so a wrong page is visible.
  const text = Array.from({ length: 150_000 }, (_, i) => `${String(i).padStart(7, "0")}|`).join("");
  assert.ok(text.length > 1_048_576);
  const size = 65_536;
  const fake = server(text, size);
  const pager = createLazyPager(fake.fetchPage);
  pager.go(0);
  await settle();
  const pages = pager.getState().pages;
  assert.equal(pages, 19);
  pager.last();
  await settle();
  assert.equal(pager.getState().page, pages - 1);
  assert.equal(pager.getState().text, text.slice((pages - 1) * size));
  pager.next();
  await settle();
  assert.equal(pager.getState().page, pages - 1, "there is nothing after the last page");
  pager.previous();
  await settle();
  assert.equal(pager.getState().page, pages - 2);
  assert.equal(pager.getState().text, text.slice((pages - 2) * size, (pages - 1) * size));
  pager.first();
  await settle();
  assert.equal(pager.getState().text, text.slice(0, size));
  pager.previous();
  assert.deepEqual(fake.requests.map((r) => r.page), [0, 18, 17, 0], "previous before the first page asks for nothing");
});

test("one page of text at a time: moving on replaces the page, it does not add to it", async () => {
  const fake = server("abcdefgh", 4);
  const pager = createLazyPager(fake.fetchPage);
  pager.go(0);
  await settle();
  pager.next();
  await settle();
  assert.equal(pager.getState().text, "efgh");
});

test("a failed first read can be retried, and so can a failed move; the old page stays meanwhile", async () => {
  const fake = server("abcdefgh", 4);
  fake.failures.push(new Error("HTTP 500"));
  const pager = createLazyPager(fake.fetchPage);
  pager.go(0);
  await settle();
  assert.deepEqual(pager.getState(), { ...INITIAL_LAZY_PAGER_STATE, loading: false, failed: true });
  pager.next();
  await settle();
  assert.equal(fake.requests.length, 1, "no page count is known yet, so next asks for nothing");
  pager.retry();
  assert.equal(pager.getState().failed, false);
  assert.equal(pager.getState().loading, true);
  await settle();
  assert.equal(pager.getState().text, "abcd");

  fake.failures.push(new Error("offline"));
  pager.next();
  await settle();
  assert.equal(pager.getState().failed, true);
  assert.equal(pager.getState().text, "abcd", "the page on screen survives a failed move");
  pager.retry();
  await settle();
  assert.deepEqual(pager.getState(), { page: 1, pages: 2, total: 8, text: "efgh", loading: false, failed: false });
  assert.deepEqual(fake.requests.map((r) => r.page), [0, 0, 1, 1]);
});

test("a newer request cancels the one in flight and its late answer is ignored", async () => {
  const held = [];
  const fetchPage = (page, signal) => new Promise((resolve) => held.push({ page, signal, resolve }));
  const pager = createLazyPager(fetchPage);
  pager.go(0);
  held[0].resolve({ text: "a", page: 0, pages: 5, total: 5 });
  await settle();
  pager.go(2);
  pager.go(4);
  assert.equal(held[1].signal.aborted, true, "the superseded request is aborted");
  held[2].resolve({ text: "e", page: 4, pages: 5, total: 5 });
  held[1].resolve({ text: "c", page: 2, pages: 5, total: 5 });
  await settle();
  assert.equal(pager.getState().page, 4);
  assert.equal(pager.getState().text, "e");
});

test("out-of-range pages are not requested once the page count is known", async () => {
  const fake = server("abcdef", 4);
  const pager = createLazyPager(fake.fetchPage);
  pager.go(0);
  await settle();
  pager.go(2);
  pager.go(-1);
  pager.go(0.5);
  assert.deepEqual(fake.requests.map((r) => r.page), [0]);
});

test("dispose aborts the request in flight, drops the text and the listeners, and ends all activity", async () => {
  const held = [];
  const pager = createLazyPager((page, signal) => new Promise((resolve) => held.push({ page, signal, resolve })));
  let notified = 0;
  pager.subscribe(() => { notified += 1; });
  pager.go(0);
  held[0].resolve({ text: "secret page", page: 0, pages: 3, total: 30 });
  await settle();
  assert.equal(pager.getState().text, "secret page");
  pager.next();
  const before = notified;
  pager.dispose();
  assert.equal(held[1].signal.aborted, true);
  assert.equal(pager.getState().text, "");
  held[1].resolve({ text: "late", page: 1, pages: 3, total: 30 });
  await settle();
  pager.go(2);
  pager.retry();
  assert.equal(held.length, 2, "a disposed pager asks for nothing");
  assert.equal(pager.getState().text, "");
  assert.equal(notified, before);
});

test("unsubscribing stops notifications for that listener only", async () => {
  const fake = server("abcd", 4);
  const pager = createLazyPager(fake.fetchPage);
  const seen = [];
  const off = pager.subscribe(() => seen.push("a"));
  pager.subscribe(() => seen.push("b"));
  off();
  pager.go(0);
  await settle();
  assert.ok(seen.length > 0);
  assert.ok(seen.every((who) => who === "b"));
});
