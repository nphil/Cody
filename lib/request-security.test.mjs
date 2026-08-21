import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./request-security.ts");
}

test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  assert.equal(isApiRequestOriginAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { origin: "http://localhost:30141", "sec-fetch-site": "same-origin" },
  })), true);
  assert.equal(isApiRequestOriginAllowed(new Request("http://localhost:30141/api/test", { method: "POST" })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestOriginAllowed(request), true);
});

// CSRF rides ambient credentials, so every reject case carries a cookie —
// a credential-less request is allowed by design (see the gateway test below).
test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { cookie: "cody_session=x", origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { cookie: "cody_session=x", "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestOriginAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestOriginAllowed(crossSiteGet), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      cookie: "cody_session=x",
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestOriginAllowed(request), false);
});

test("allows cross-site GET navigations: external links, gateway iframes, detach", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  // Top-level GET navigations DO carry the SameSite=Lax cookie — the
  // exemption must hold on its own merits, not via the credential-less rule.
  const iframeNav = new Request("http://localhost:30141/dev/stream-tuner", {
    headers: { cookie: "cody_session=x", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
  });
  const topNav = new Request("http://localhost:30141/", {
    headers: { cookie: "cody_session=x", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  assert.equal(isApiRequestOriginAllowed(iframeNav), true);
  assert.equal(isApiRequestOriginAllowed(topNav), true);
});

test("cross-site form posts and fetches stay rejected (CSRF)", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const formPost = new Request("http://localhost:30141/api/sessions", {
    method: "POST",
    headers: { cookie: "cody_session=x", origin: "https://attacker.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  const corsGet = new Request("http://localhost:30141/api/sessions", {
    headers: { cookie: "cody_session=x", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
  });
  assert.equal(isApiRequestOriginAllowed(formPost), false, "a navigation that mutates is the classic CSRF vector");
  assert.equal(isApiRequestOriginAllowed(corsGet), false, "cross-site fetch() is never a navigation");
});

test("credential-less requests are never CSRF: gateway asset fetches pass despite mismatched forwarding metadata", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  // The preview gateway strips cookies/authorization, rewrites Origin to the
  // target's own http origin, while the outer TLS proxy stamps
  // x-forwarded-proto: https — the self-origin comparison would misread this
  // as cross-origin. No credentials → nothing to forge → allowed.
  const chunk = new Request("https://localhost:30178/_next/static/chunks/app.js", {
    headers: {
      host: "localhost:30178",
      origin: "http://localhost:30178",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-dest": "script",
    },
  });
  assert.equal(isApiRequestOriginAllowed(chunk), true);
  // Same shape WITH a cookie and a genuinely foreign origin: still refused.
  const forged = new Request("https://localhost:30178/api/sessions", {
    headers: { cookie: "cody_session=x", origin: "https://attacker.example", "sec-fetch-mode": "no-cors" },
  });
  assert.equal(isApiRequestOriginAllowed(forged), false);
});
