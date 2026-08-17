import assert from "node:assert/strict";
import test from "node:test";

const { normalizePreviewUrl, extractLoopbackUrls } = await import("./preview-url.ts");

test("normalizePreviewUrl accepts loopback origins and defaults the scheme", () => {
  assert.equal(normalizePreviewUrl("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizePreviewUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizePreviewUrl("127.0.0.1:8080/app"), "http://127.0.0.1:8080/app");
  assert.equal(normalizePreviewUrl("https://localhost:8443/x?y=1"), "https://localhost:8443/x?y=1");
  assert.equal(normalizePreviewUrl("  http://localhost:5173/  "), "http://localhost:5173/");
});

test("normalizePreviewUrl canonicalizes wildcard and IPv6 loopback hosts to localhost", () => {
  // Dev servers print the bind address; the browser needs a fetchable host.
  assert.equal(normalizePreviewUrl("http://0.0.0.0:8000"), "http://localhost:8000/");
  assert.equal(normalizePreviewUrl("http://[::]:8000"), "http://localhost:8000/");
  // CSP source lists cannot express "http://[::1]:*", so [::1] becomes
  // localhost (which resolves to ::1 anyway on dual-stack hosts).
  assert.equal(normalizePreviewUrl("http://[::1]:3000"), "http://localhost:3000/");
  assert.equal(normalizePreviewUrl("http://[0:0:0:0:0:0:0:1]:3000"), "http://localhost:3000/");
});

test("normalizePreviewUrl rejects non-loopback and non-http input", () => {
  assert.equal(normalizePreviewUrl(""), null);
  assert.equal(normalizePreviewUrl("   "), null);
  assert.equal(normalizePreviewUrl("http://example.com"), null);
  assert.equal(normalizePreviewUrl("http://192.168.1.10:3000"), null);
  assert.equal(normalizePreviewUrl("http://localhost.evil.com"), null);
  assert.equal(normalizePreviewUrl("ftp://localhost:21"), null);
  assert.equal(normalizePreviewUrl("file:///etc/passwd"), null);
  assert.equal(normalizePreviewUrl("javascript:alert(1)"), null);
  assert.equal(normalizePreviewUrl("http://"), null);
});

test("extractLoopbackUrls finds loopback URLs in assistant prose", () => {
  assert.deepEqual(
    extractLoopbackUrls("The dev server is running at http://localhost:3000 — open it to check."),
    ["http://localhost:3000/"],
  );
  assert.deepEqual(
    extractLoopbackUrls("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ..."),
    ["http://localhost:8000/"],
  );
  assert.deepEqual(
    extractLoopbackUrls("Preview: [the app](http://127.0.0.1:5173/dashboard)."),
    ["http://127.0.0.1:5173/dashboard"],
  );
});

test("extractLoopbackUrls strips trailing punctuation and markdown delimiters", () => {
  assert.deepEqual(extractLoopbackUrls("Visit http://localhost:3000/app."), ["http://localhost:3000/app"]);
  assert.deepEqual(extractLoopbackUrls("Visit http://localhost:3000."), ["http://localhost:3000/"]);
  assert.deepEqual(extractLoopbackUrls("(http://localhost:3000)"), ["http://localhost:3000/"]);
  assert.deepEqual(extractLoopbackUrls("`http://localhost:3000/x`"), ["http://localhost:3000/x"]);
  assert.deepEqual(extractLoopbackUrls("<http://localhost:3000>"), ["http://localhost:3000/"]);
});

test("extractLoopbackUrls ignores non-loopback URLs and bare host:port text", () => {
  assert.deepEqual(extractLoopbackUrls("See https://example.com and http://10.0.0.2:3000"), []);
  // Bare mentions without a scheme are too ambiguous to auto-open over.
  assert.deepEqual(extractLoopbackUrls("listening on localhost:3000"), []);
  assert.deepEqual(extractLoopbackUrls(""), []);
});

test("extractLoopbackUrls dedupes (after canonicalization) and caps the result", () => {
  assert.deepEqual(
    extractLoopbackUrls("http://localhost:3000 then http://0.0.0.0:3000 then http://localhost:3000/"),
    ["http://localhost:3000/"],
  );
  const many = Array.from({ length: 6 }, (_, i) => `http://localhost:${4000 + i}`).join(" ");
  assert.equal(extractLoopbackUrls(many).length, 3);
});
