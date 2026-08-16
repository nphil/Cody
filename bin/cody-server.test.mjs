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
