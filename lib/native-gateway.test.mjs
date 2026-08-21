import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveDisplayCandidates } = await jiti.import("./display/native-gateway.ts");

/** One-shot dev-server stand-in whose response headers the test controls. */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

async function nativeOffered(handler) {
  const { url, close } = await serve(handler);
  process.env.CODY_PREVIEW_BASE_URL = "https://preview.example.net";
  try {
    // mode "native" skips the per-interface direct probes: this asserts on
    // exactly one thing — whether the gateway rung is minted for this target.
    const candidates = await resolveDisplayCandidates(url, "native");
    assert.equal(candidates.at(-1).kind, "stream", "the streamed floor is always present");
    return candidates.some((c) => c.kind === "native");
  } finally {
    delete process.env.CODY_PREVIEW_BASE_URL;
    await close();
  }
}

test("a plain 200 dev server gets the gateway rung", async () => {
  assert.equal(await nativeOffered((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>vite</h1>"); }), true);
});

test("an auth-gated target (login redirect) is not offered the gateway", async () => {
  // The gateway strips cookies both ways, so the login this redirects to
  // could never complete — offering the rung would render a dead form.
  assert.equal(await nativeOffered((req, res) => { res.writeHead(307, { location: "/login" }); res.end(); }), false);
});

test("a 403-answering target (Cody's own cross-site guard) is not offered the gateway", async () => {
  assert.equal(await nativeOffered((req, res) => { res.writeHead(403, { "content-type": "application/json" }); res.end("{}"); }), false);
});

test("frame-blocking headers do NOT disqualify the gateway rung — the proxy strips them", async () => {
  assert.equal(await nativeOffered((req, res) => { res.writeHead(200, { "x-frame-options": "DENY" }); res.end("ok"); }), true);
  assert.equal(await nativeOffered((req, res) => { res.writeHead(200, { "content-security-policy": "frame-ancestors 'none'" }); res.end("ok"); }), true);
});

test("an unreachable target is not offered the gateway", async () => {
  process.env.CODY_PREVIEW_BASE_URL = "https://preview.example.net";
  try {
    const candidates = await resolveDisplayCandidates("http://127.0.0.1:1/", "native");
    assert.deepEqual(candidates.map((c) => c.kind), ["stream"]);
  } finally {
    delete process.env.CODY_PREVIEW_BASE_URL;
  }
});

test("the gateway re-serves responses without credentials or framing headers", async () => {
  // This stripping is what makes ANY dev server frameable through the token
  // origin on every install — a regression here silently breaks the native
  // rung for frame-guarded targets (Cody dev servers included) everywhere.
  const { proxyNativeHttp } = await jiti.import("./display/native-gateway.ts");
  let upstreamSaw = null;
  const upstream = await serve((req, res) => {
    upstreamSaw = req.headers;
    res.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'; img-src data:",
      "set-cookie": "sid=secret; Path=/",
    });
    res.end("<h1>framed</h1>");
  });
  process.env.CODY_PREVIEW_BASE_URL = "https://preview.example.net";
  try {
    const candidates = await resolveDisplayCandidates(upstream.url, "native");
    const tokenHost = new URL(candidates.find((c) => c.kind === "native").url).hostname;
    const front = await serve((req, res) => {
      req.headers.host = tokenHost;
      if (!proxyNativeHttp(req, res)) { res.writeHead(502); res.end("no route"); }
    });
    try {
      const response = await fetch(front.url, {
        redirect: "manual",
        // What an outer TLS edge hands the gateway: credentials, foreign
        // forwarding metadata — none of it may reach the upstream as-is.
        headers: { cookie: "cody_session=leak", "x-forwarded-proto": "https" },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "<h1>framed</h1>");
      assert.equal(response.headers.get("x-frame-options"), null, "XFO must be stripped");
      assert.equal(response.headers.get("set-cookie"), null, "cookies must not cross the gateway");
      const csp = response.headers.get("content-security-policy") ?? "";
      assert.doesNotMatch(csp, /frame-ancestors/i, "frame-ancestors must be stripped");
      assert.match(csp, /default-src 'self'/, "the target's other directives survive");
      // Upstream must have seen a self-consistent plain-local request: no
      // credentials, no fabricated Origin (this client sent none), and
      // forwarding metadata rewritten to the target's own reality — an outer
      // edge's https must not leak through and fake a cross-origin mismatch.
      assert.equal(upstreamSaw.cookie, undefined, "cookies stripped inbound");
      assert.equal(upstreamSaw.origin, undefined, "origin never fabricated");
      assert.equal(upstreamSaw["x-forwarded-proto"], "http", "forwarded proto rewritten to the target's");
      assert.equal(upstreamSaw["x-forwarded-host"], new URL(upstream.url).host, "forwarded host rewritten to the target's");
    } finally {
      await front.close();
    }
  } finally {
    delete process.env.CODY_PREVIEW_BASE_URL;
    await upstream.close();
  }
});
