import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions, readEnv } = require("../bin/cody-options.js");

test("opens the browser by default", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    port: "30177",
    hostname: "127.0.0.1",
    openBrowser: true,
  });
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy CODY_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { CODY_NO_OPEN: value }).openBrowser, false);
  }
});

test("does not disable browser opening for false CODY_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { CODY_NO_OPEN: value }).openBrowser, true);
  }
});

test("preserves port and hostname options", () => {
  assert.deepEqual(
    parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {}),
    {
      port: "8080",
      hostname: "0.0.0.0",
      openBrowser: true,
    },
  );
});

test("supports CODY_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { CODY_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});

test("still honors the pre-fork OMP_WEB_ variables", () => {
  assert.equal(parseLaunchOptions([], { OMP_WEB_HOSTNAME: "0.0.0.0" }).hostname, "0.0.0.0");
  assert.equal(parseLaunchOptions([], { OMP_WEB_NO_OPEN: "1" }).openBrowser, false);
});

test("prefers the CODY_ variable when both prefixes are set", () => {
  assert.equal(
    parseLaunchOptions([], { CODY_HOSTNAME: "0.0.0.0", OMP_WEB_HOSTNAME: "10.0.0.1" }).hostname,
    "0.0.0.0",
  );
});

test("readEnv treats an explicitly empty CODY_ value as intentional", () => {
  assert.equal(readEnv("PASSWORD", { CODY_PASSWORD: "", OMP_WEB_PASSWORD: "legacy" }), "");
  assert.equal(readEnv("PASSWORD", { OMP_WEB_PASSWORD: "legacy" }), "legacy");
  assert.equal(readEnv("PASSWORD", {}), undefined);
});
