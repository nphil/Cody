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
  return loadOmpSourceFile(path.join(packageRoot, ...segments));
}
export interface OmpRegistrySettingsResult {
  definitions: Record<string, unknown>[] | null;
  ui: Record<string, unknown> | null;
  error: string | null;
}

/**
 * OMP 18.3 moved settings into domain modules that register their definitions
 * as the all-settings aggregator imports them. Load those modules against one
 * real registry instance, then ask OMP's own aggregator for display order.
 * Every unrelated import remains stubbed as in the legacy source reader.
 */
export function loadOmpRegistrySettings(packageRoot: string): OmpRegistrySettingsResult {
  const aggregatorPath = path.join(packageRoot, "src", "config", "all-settings.ts");
  const registryPath = path.join(packageRoot, "src", "config", "registry.ts");
  const errors: string[] = [];
  let aggregatorSource: string;
  try {
    aggregatorSource = fs.readFileSync(aggregatorPath, "utf8");
  } catch {
    return { definitions: null, ui: null, error: "OMP registry layout is missing " + aggregatorPath };
  }

  const registry = loadOmpSourceFile(registryPath, 0, undefined, errors);
  if (!registry || typeof registry.all !== "function") {
    return { definitions: null, ui: null, error: errors.at(-1) ?? "Could not load OMP settings registry " + registryPath };
  }

  const domainSpecifiers = [...aggregatorSource.matchAll(/^import\s+\*\s+as\s+\w+\s+from\s+"([^"]+)";/gm)].map((match) => match[1]);
  if (domainSpecifiers.length === 0) {
    return { definitions: null, ui: null, error: "No settings domains were found in " + aggregatorPath };
  }

  const domainModules: Record<string, Record<string, unknown>> = {};
  for (const specifier of domainSpecifiers) {
    const modulePath = resolveSourceSpecifier(aggregatorPath, specifier);
    if (!modulePath) {
      return { definitions: null, ui: null, error: "Could not resolve OMP settings domain " + specifier + " from " + aggregatorPath };
    }
    let source: string;
    try {
      source = fs.readFileSync(modulePath, "utf8");
    } catch {
      return { definitions: null, ui: null, error: "Could not read OMP settings domain " + modulePath };
    }
    const registrySpecifier = sourceImports(source).find((candidate) => resolveSourceSpecifier(modulePath, candidate) === registryPath);
    if (!registrySpecifier) {
      return { definitions: null, ui: null, error: "OMP settings domain " + modulePath + " does not import the shared registry" };
    }
    const loaded = loadOmpSourceFile(modulePath, 0, { [registrySpecifier]: registry }, errors);
    if (!loaded) {
      return { definitions: null, ui: null, error: errors.at(-1) ?? "Could not evaluate OMP settings domain " + modulePath };
    }
    domainModules[specifier] = loaded;
  }

  const aggregatorOverrides: Record<string, Record<string, unknown>> = {};
  for (const specifier of sourceImports(aggregatorSource)) {
    if (resolveSourceSpecifier(aggregatorPath, specifier) === registryPath) {
      aggregatorOverrides[specifier] = registry;
    } else if (domainModules[specifier]) {
      aggregatorOverrides[specifier] = domainModules[specifier];
    }
  }
  const aggregator = loadOmpSourceFile(aggregatorPath, 0, aggregatorOverrides, errors);
  const orderedSettings = aggregator?.orderedSettings;
  if (typeof orderedSettings !== "function") {
    return { definitions: null, ui: null, error: errors.at(-1) ?? "OMP settings aggregator did not export orderedSettings(): " + aggregatorPath };
  }
  let handles: unknown;
  try {
    handles = (orderedSettings as () => unknown)();
  } catch (error) {
    return { definitions: null, ui: null, error: "OMP orderedSettings() failed: " + (error instanceof Error ? error.message : String(error)) };
  }
  if (!Array.isArray(handles)) {
    return { definitions: null, ui: null, error: "OMP orderedSettings() did not return an array: " + aggregatorPath };
  }
  const definitions = handles.flatMap((handle): Record<string, unknown>[] => {
    if (!handle || typeof handle !== "object") return [];
    const definition = (handle as { definition?: unknown }).definition;
    return definition && typeof definition === "object" ? [definition as Record<string, unknown>] : [];
  });
  if (definitions.length === 0) {
    return { definitions: null, ui: null, error: "OMP settings registry contained no definitions: " + aggregatorPath };
  }

  const ui = loadOmpSettingsUiMetadata(packageRoot, errors);
  return { definitions, ui, error: ui ? null : errors.at(-1) ?? "OMP settings loaded, but tab metadata could not be read" };
}

function loadOmpSettingsUiMetadata(packageRoot: string, errors: string[]): Record<string, unknown> | null {
  const uiSourcePath = path.join(packageRoot, "src", "config", "settings-ui.ts");
  let source: string;
  try {
    source = fs.readFileSync(uiSourcePath, "utf8");
  } catch {
    errors.push("Could not read OMP settings UI entrypoint " + uiSourcePath);
    return null;
  }
  const specifier = sourceImports(source).find((candidate) => candidate.includes("settings-defs"));
  const sourcePath = specifier ? resolveSourceSpecifier(uiSourcePath, specifier) : null;
  if (!sourcePath) {
    errors.push("Could not resolve OMP settings tab metadata from " + uiSourcePath);
    return null;
  }
  const ui = loadOmpSourceFile(sourcePath, 0, undefined, errors);
  if (!ui || !Array.isArray(ui.SETTING_TABS)) {
    errors.push(errors.at(-1) ?? "OMP settings tab metadata is unavailable in " + sourcePath);
    return null;
  }
  return ui;
}

function sourceImports(source: string): string[] {
  return [...source.matchAll(/^import\s+[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
}

/** The same evaluation, addressed by absolute path — the form the re-export
 * hop below needs, since the file it lands on lives in a sibling package.
 *
 * `depth` bounds the bridging below: a dependency's own file is loaded with
 * every import stubbed, so one hop is all that is ever needed. */
function loadOmpSourceFile(
  file: string,
  depth = 0,
  importOverrides?: Record<string, Record<string, unknown>>,
  errors?: string[],
): Record<string, unknown> | null {
  let stubDir: string | null = null;
  try {
    if (!fs.existsSync(file)) {
      errors?.push("OMP source file not found: " + file);
      return null;
    }
    const source = fs.readFileSync(file, "utf8");
    const imports = [...source.matchAll(/^import\s+[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-omp-source-"));
    const stubPath = path.join(stubDir, STUB_FILENAME);
    fs.writeFileSync(stubPath, STUB_SOURCE, "utf8");
    const alias: Record<string, string> = {};
    for (const specifier of imports) {
      const override = importOverrides?.[specifier];
      alias[specifier] = (override ? bridgeModule(override, stubDir) : null) ?? bridgeFor(specifier, file, stubDir, depth) ?? stubPath;
    }
    const jiti = createJiti(__filename, { alias, interopDefault: true, moduleCache: false });
    return jiti(file) as Record<string, unknown>;
  } catch (error) {
    errors?.push("Could not evaluate OMP source " + file + ": " + (error instanceof Error ? error.message : String(error)));
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

/** Values a stubbed import would have destroyed, keyed for the bridge modules
 * below. Process-global because a generated CJS file is the only thing jiti's
 * alias map can point at. */
const bridgedModules = ((globalThis as typeof globalThis & { __codyOmpBridgedModules?: Record<string, Record<string, unknown>> }).__codyOmpBridgedModules ??= {});
let bridgeCounter = 0;

/**
 * A real module for an import of a SIBLING PACKAGE, when its source can be
 * read the same stubbed way.
 *
 * The generic stub is fine for a type-only import and unavoidable for a
 * Bun-only runtime, but it also destroys plain literal data — and 18.2.5 moved
 * a lot of that data out into `@oh-my-pi/pi-tui`. `treeFilterMode`'s enum
 * values now live there, and under the stub the setting rendered no choices at
 * all and dropped out of Cody's panel entirely. Reading the dependency's own
 * source brings the literals back.
 *
 * Relative imports are deliberately left stubbed: their behaviour is unchanged
 * from before the split, and stub-loading dozens of in-package modules is a
 * much larger blast radius than this fix needs.
 */
function bridgeFor(specifier: string, fromFile: string, stubDir: string, depth: number): string | null {
  if (depth > 0 || specifier.startsWith(".") || specifier.startsWith("node:")) return null;
  const resolved = resolveSourceSpecifier(fromFile, specifier);
  if (resolved === null) return null;
  const exported = loadOmpSourceFile(resolved, depth + 1);
  return exported === null ? null : bridgeModule(exported, stubDir);
}

function bridgeModule(exported: Record<string, unknown>, stubDir: string): string | null {
  const id = "bridge-" + (bridgeCounter += 1);
  bridgedModules[id] = exported;
  const bridgePath = path.join(stubDir, id + ".cjs");
  try {
    fs.writeFileSync(bridgePath, "module.exports = require(" + JSON.stringify(__filename) + ").__codyBridgedModule(" + JSON.stringify(id) + ");", "utf8");
  } catch {
    return null;
  }
  return bridgePath;
}

/** Bridge accessor. Exported only so a generated module can reach it. */
export function __codyBridgedModule(id: string): Record<string, unknown> {
  return bridgedModules[id] ?? {};
}

/**
 * Follow a re-export into the module that actually declares a symbol.
 *
 * Upstream keeps splitting modules out into sibling packages (18.2.5 moved the
 * whole terminal UI, `MODEL_ROLE_IDS` included, into `@oh-my-pi/pi-tui`), and
 * the file left behind is a one-line `export { X } from "@oh-my-pi/pi-tui/…"`.
 * Under the stub-every-import loader above, that re-export resolves to the
 * stub, so the symbol comes back as a Proxy and the caller silently falls back
 * to its frozen copy — which is the exact failure reading the source exists to
 * prevent. So: load the file, and when the symbol is not what the caller
 * expects, resolve the specifier it is re-exported from to that package's OWN
 * source file and read it there.
 *
 * The hop is bounded (a chain of re-exports is still only a few files) and
 * every failure returns null, because every caller has a fallback.
 */
export function loadOmpPackageSymbol<T>(
  packageRoot: string,
  segments: string[],
  symbol: string,
  isValid: (value: unknown) => value is T,
): T | null {
  const start = path.join(packageRoot, ...segments);
  const seen = new Set<string>();
  let file: string | null = start;
  for (let hop = 0; hop < 4 && file !== null; hop += 1) {
    if (seen.has(file)) return null;
    seen.add(file);
    const loaded = loadOmpSourceFile(file);
    const value = loaded?.[symbol];
    if (isValid(value)) return value;
    file = reExportSourceFor(file, symbol);
  }
  return null;
}

/** The file a symbol is re-exported from, resolved to real source. */
function reExportSourceFor(file: string, symbol: string): string | null {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  // `export { X } from "…"` / `export { X as Y } from "…"`, then a bare
  // `export * from "…"` as the fallback for a barrel file.
  const named = new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`);
  const specifier = named.exec(source)?.[1]
    ?? /export\s*\*\s*from\s*"([^"]+)"/.exec(source)?.[1]
    ?? null;
  return specifier === null ? null : resolveSourceSpecifier(file, specifier);
}

/**
 * A module specifier as written in the engine's source, resolved to the source
 * FILE it names — relative paths against their importer, bare ones through the
 * dependency's own `exports` map (these packages publish `src/*.ts` under it,
 * which is why this works at all).
 */
export function resolveSourceSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return firstExistingSource(path.resolve(path.dirname(fromFile), specifier));
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const subpath = specifier.slice(name.length).replace(/^\//, "");
  const packageDir = findDependencyDir(path.dirname(fromFile), name);
  if (packageDir === null) return null;
  let manifest: { exports?: unknown; main?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return null;
  }
  const relative = exportTarget(manifest.exports, subpath === "" ? "." : `./${subpath}`);
  if (relative !== null) return firstExistingSource(path.join(packageDir, relative));
  // No usable exports entry: a source layout mirroring the subpath is the only
  // other thing worth trying, and a miss is a null like any other.
  return subpath === "" ? null : firstExistingSource(path.join(packageDir, "src", subpath));
}

/** `node_modules/<name>` from the importer's directory upwards. */
function findDependencyDir(fromDir: string, name: string): string | null {
  let current = fromDir;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(current, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** The `import`/`default` target for one subpath of an `exports` map,
 * including a single-`*` pattern key. Conditions other than import/default are
 * ignored: this only ever wants the source entry. */
function exportTarget(exports: unknown, subpath: string): string | null {
  if (!exports || typeof exports !== "object") return null;
  const table = exports as Record<string, unknown>;
  const pick = (entry: unknown): string | null => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return null;
    const conditions = entry as Record<string, unknown>;
    for (const key of ["import", "default", "require"]) {
      const value = conditions[key];
      if (typeof value === "string") return value;
    }
    return null;
  };
  const exact = pick(table[subpath]);
  if (exact !== null) return exact;
  for (const [key, entry] of Object.entries(table)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (subpath.length < prefix.length + suffix.length) continue;
    const target = pick(entry);
    if (target === null) continue;
    return target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
  }
  return null;
}

/** A specifier may name a file, a `.ts` sibling, or a directory barrel. */
function firstExistingSource(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Next candidate.
    }
  }
  return null;
}
