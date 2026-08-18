import assert from "node:assert/strict";
import test from "node:test";

const { parseArgs, terminalPath, originAllowed } = await import("./cody-server.js");

test("custom server parses supported CLI flags", () => {
  assert.deepEqual(parseArgs(["--dev", "-H", "0.0.0.0", "-p", "30178"]), {
    dev: true,
    hostname: "0.0.0.0",
    port: 30178,
  });
  assert.throws(() => parseArgs(["-p", "0"]), /Invalid port/);
});

test("terminal upgrade matcher accepts only terminal socket paths", () => {
  assert.equal(terminalPath("/api/terminals/123e4567-e89b-12d3-a456-426614174000/socket"), true);
  assert.equal(terminalPath("/api/terminals/not-an-id/socket"), false);
  assert.equal(terminalPath("/_next/webpack-hmr"), false);
});

test("terminal upgrades require matching same-origin Origin", () => {
  const request = { headers: { origin: "http://localhost:3000", host: "localhost:3000" } };
  assert.equal(originAllowed(request), true);
  assert.equal(originAllowed({ headers: { ...request.headers, origin: "https://evil.example" } }), false);
  assert.equal(originAllowed({ headers: { host: "localhost:3000" } }), false);
});

test("an Origin-less upgrade is admitted only for a bearer credential", () => {
  // Browsers always send Origin on a handshake, so no Origin means a
  // non-browser client. Ambient credentials must still be refused: a cookie
  // rides along on a cross-site upgrade the page never consented to.
  const headers = { host: "localhost:3000" };
  assert.equal(originAllowed({ headers }, { kind: "cookie", user: {} }), false);
  assert.equal(originAllowed({ headers }, { kind: "basic", user: {} }), false);
  assert.equal(originAllowed({ headers }, null), false);

  // A bearer token is never attached automatically, so it cannot be replayed
  // from someone else's page — this is the native client's display socket.
  assert.equal(originAllowed({ headers }, { kind: "bearer", user: {} }), true);

  // A present but foreign Origin stays refused whatever the credential: that is
  // a browser telling us where it came from.
  const foreign = { headers: { ...headers, origin: "https://evil.example" } };
  assert.equal(originAllowed(foreign, { kind: "bearer", user: {} }), false);
  // And a matching Origin is still fine for every credential.
  const same = { headers: { ...headers, origin: "http://localhost:3000" } };
  assert.equal(originAllowed(same, { kind: "cookie", user: {} }), true);
  assert.equal(originAllowed(same, { kind: "bearer", user: {} }), true);
});
