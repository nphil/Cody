import fs from "fs";
import os from "os";
import path from "path";
import { createJiti } from "jiti";
import { resolveOmpBin } from "./omp-cli";

/**
 * Reading OMP's own TypeScript sources out of the installed package.
 *
 * Two things Cody needs have no RPC command behind them — the settings schema
 * and the built-in model roles — so the honest source is the source: the npm
 * tarball ships `src/`, and what is written there is what the running engine
 * uses. Hand-copying either list into Cody goes stale the first time upstream
 * changes it, silently and in the direction that breaks the user's config.
 *
 * Those files import Bun-only siblings (@oh-my-pi/*, ../live/voices, …) which
 * cannot load under Node, so every import is aliased to a permissive stub and
 * jiti transpiles what is left. Plain literals — labels, tabs, role ids —
 * survive intact; anything computed from a stubbed import comes back as a stub
 * object, which is the caller's job to discard.
 */

const STUB_FILENAME = "cody-omp-source-stub.cjs";

/** A module whose every export is callable, indexable and iterable — enough to
 * let a source file's top-level expressions evaluate. `then` must stay
 * undefined: a thenable here would make any await on the module hang forever. */
const STUB_SOURCE = `
function makeAny() {
  const fn = function () { return makeAny(); };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then" || prop === "constructor" || prop === "__esModule") return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "length") return 0;
      if (prop === "map" || prop === "filter" || prop === "slice") return () => [];
      return makeAny();
    },
    apply() { return makeAny(); },
  });
}
module.exports = makeAny();
`;

/** Walk up from the omp binary to the package root that owns it. */
export function findOmpPackageRoot(): string | null {
  const bin = resolveOmpBin();
  if (!bin) return null;
  let current: string;
  try {
    current = fs.realpathSync(bin);
  } catch {
    current = bin;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    current = path.dirname(current);
    if (current === path.dirname(current)) break;
    const manifest = path.join(current, "package.json");
    if (!fs.existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.includes("pi-coding-agent")) return current;
    } catch {
      // Unreadable manifest: keep walking.
    }
  }
  return null;
}

export function ompPackageVersion(packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Evaluate one source file from the installed package and hand back its
 * exports. Returns null when the file is absent (an older or newer layout) or
 * fails to transpile — every caller has a fallback, because a Cody that cannot
 * read omp's source must still run.
 */
export function loadOmpPackageSource(packageRoot: string, ...segments: string[]): Record<string, unknown> | null {
  const file = path.join(packageRoot, ...segments);
  let stubDir: string | null = null;
  try {
    if (!fs.existsSync(file)) return null;
    const source = fs.readFileSync(file, "utf8");
    const imports = [...source.matchAll(/^import\s+[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-omp-source-"));
    const stubPath = path.join(stubDir, STUB_FILENAME);
    fs.writeFileSync(stubPath, STUB_SOURCE, "utf8");
    const alias = Object.fromEntries(imports.map((specifier) => [specifier, stubPath]));
    const jiti = createJiti(__filename, { alias, interopDefault: true, moduleCache: false });
    return jiti(file) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    if (stubDir) {
      try {
        fs.rmSync(stubDir, { recursive: true, force: true });
      } catch {
        // Temp dir cleanup is best effort.
      }
    }
  }
}
