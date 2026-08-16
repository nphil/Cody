"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

/** CommonJS twin of lib/env.ts, for the launcher, which starts before jiti is
 * available. Prefers the `CODY_` name and falls back to the `OMP_WEB_` one this
 * project used before the fork was renamed. */
function readEnv(name, env = process.env) {
  return env[`CODY_${name}`] ?? env[`OMP_WEB_${name}`];
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  return {
    port: cliArgs.port ?? env.PORT ?? "30177",
    hostname: cliArgs.hostname ?? readEnv("HOSTNAME", env) ?? "127.0.0.1",
    openBrowser: !cliArgs["no-open"] && !isEnabled(readEnv("NO_OPEN", env)),
  };
}

module.exports = { parseLaunchOptions, readEnv };
