import { readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { isRecord } from "../type-guards";
import { findOmpPackageRoot, loadOmpPackageSource, resolveSourceSpecifier } from "./package-source";

/**
 * What the INSTALLED omp's bundled model catalog says.
 *
 * `@oh-my-pi/pi-catalog`'s `src/models.json` is omp's own curated database
 * (pricing, context windows, thinking levels…), keyed `provider -> modelId`.
 * A model in it has a price omp chose, and that includes a deliberate zero (a
 * prepaid plan, a free tier). A model missing from it reached the registry
 * through runtime discovery and is priced at zero only because omp has no data
 * yet — the gap `lib/model-price-fill.ts` fills. The Claude API credits mirror
 * the `anthropic` rows of it (lib/omp/claude-credits.ts).
 *
 * Two on-disk layouts exist, and Cody must read whichever engine is installed:
 *
 *  - plain (omp up to 18.13): the file IS `provider -> modelId -> model`, and
 *    the package exports it as `./models.json`;
 *  - compact (omp 18.14 and later): `{ version, keys, booleanShapes, nodes,
 *    compat, providers }`, a de-duplicated encoding only the package's own
 *    `src/model-catalog-format.ts` can turn back into models, and no
 *    `./models.json` export. Decoding it here by hand would go stale with the
 *    next format change, so the decoder is loaded from the package, like the
 *    settings schema is (lib/omp/package-source.ts).
 *
 * Failure is always a `reason`, never an empty catalog: callers must treat an
 * unreadable catalog as "cannot tell", not as "omp ships nothing".
 */

export type BundledModelRow = Readonly<Record<string, unknown>>;

export interface BundledCatalog {
  /** Which on-disk layout the installed package uses. */
  readonly layout: "plain" | "compact";
  readonly file: string;
  /** `provider\0modelId` of every bundled model. Membership only: the
   *  catalog is large and the prices themselves are omp's to apply. */
  readonly keys: ReadonlySet<string>;
  /** The full rows of the providers asked for, by model id. */
  readonly rows: ReadonlyMap<string, Readonly<Record<string, BundledModelRow>>>;
}

export type BundledCatalogRead = { ok: true; catalog: BundledCatalog } | { ok: false; reason: string };

interface CacheEntry {
  file: string;
  mtimeMs: number;
  size: number;
  catalog: BundledCatalog;
}

let cached: CacheEntry | null = null;

export function bundledModelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

function failure(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** The catalog package's source directory. The package exports `.` as its
 *  `src/index.ts` in every layout, so that file's directory is where its
 *  `models.json` and `compat/rules.json` live. */
function catalogSourceDir(packageRoot: string): string | null {
  const entry = resolveSourceSpecifier(join(packageRoot, "package.json"), "@oh-my-pi/pi-catalog");
  return entry ? dirname(entry) : null;
}

/** The catalog file and the source directory that holds it. `./models.json`
 *  itself is no longer exported (and its `exports` entry only ever named an
 *  `import` condition). */
function locateCatalog(packageRoot: string): { file: string; sourceDir: string } | string {
  const sourceDir = catalogSourceDir(packageRoot);
  if (!sourceDir) return "omp's catalog package (@oh-my-pi/pi-catalog) was not found next to it";
  const file = join(sourceDir, "models.json");
  try {
    if (!statSync(file).isFile()) return `${file} is not a file`;
  } catch {
    return `${file} does not exist`;
  }
  return { file, sourceDir };
}

type CompactDecoder = {
  open: (value: unknown) => unknown;
  providers: (catalog: unknown) => unknown;
  provider: (catalog: unknown, provider: string) => unknown;
};

function loadCompactDecoder(sourceDir: string): CompactDecoder | null {
  const exported = loadOmpPackageSource(sourceDir, "model-catalog-format.ts");
  const open = exported?.openModelCatalog;
  const providers = exported?.getCatalogProviders;
  const provider = exported?.getCatalogProvider;
  if (typeof open !== "function" || typeof providers !== "function" || typeof provider !== "function") return null;
  return {
    open: open as CompactDecoder["open"],
    providers: providers as CompactDecoder["providers"],
    provider: provider as CompactDecoder["provider"],
  };
}

/** Collect what a provider -> modelId -> model source holds, whatever decoded it. */
function collect(
  providers: Iterable<[string, unknown]>,
  rowsFor: readonly string[],
): { keys: Set<string>; rows: Map<string, Record<string, BundledModelRow>> } {
  const keys = new Set<string>();
  const rows = new Map<string, Record<string, BundledModelRow>>();
  for (const [provider, models] of providers) {
    if (!isRecord(models)) continue;
    for (const modelId of Object.keys(models)) keys.add(bundledModelKey(provider, modelId));
    if (rowsFor.includes(provider)) rows.set(provider, models as Record<string, BundledModelRow>);
  }
  return { keys, rows };
}

function parseCatalog(file: string, sourceDir: string, rowsFor: readonly string[]): BundledCatalogRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return failure(`${file} could not be parsed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(parsed)) return failure(`${file} is not an object`);

  // The compact layout is recognisable by its table arrays; a plain catalog is provider -> model maps.
  if (typeof parsed.version === "number" && Array.isArray(parsed.nodes) && Array.isArray(parsed.providers)) {
    const decoder = loadCompactDecoder(sourceDir);
    if (!decoder) return failure("omp's catalog decoder (model-catalog-format.ts) could not be loaded");
    try {
      const opened = decoder.open(parsed);
      const ids = decoder.providers(opened);
      if (!Array.isArray(ids)) return failure("omp's catalog decoder did not list the providers");
      const { keys, rows } = collect(
        ids.filter((id): id is string => typeof id === "string").map((id): [string, unknown] => [id, decoder.provider(opened, id)]),
        rowsFor,
      );
      if (keys.size === 0) return failure(`${file} lists no models`);
      return { ok: true, catalog: { layout: "compact", file, keys, rows } };
    } catch (error) {
      return failure(`omp's catalog decoder rejected ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const { keys, rows } = collect(Object.entries(parsed), rowsFor);
  if (keys.size === 0) return failure(`${file} has a layout Cody does not know (it lists no models)`);
  return { ok: true, catalog: { layout: "plain", file, keys, rows } };
}

/**
 * Read the installed omp's bundled catalog: every model it lists, plus the
 * full rows of the providers named in `rowsFor`. Cached by file mtime and
 * size, so the ~1-12 MB file is parsed once per omp install; asking for rows
 * of a provider an earlier read did not retain re-reads it once and keeps both.
 */
export function readBundledCatalog(packageRoot: string | null = findOmpPackageRoot(), rowsFor: readonly string[] = []): BundledCatalogRead {
  if (!packageRoot) return failure("omp's install could not be found");
  const located = locateCatalog(packageRoot);
  if (typeof located === "string") return failure(located);
  const { file, sourceDir } = located;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return failure(`${file} does not exist`);
  }
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    if (rowsFor.every((provider) => cached!.catalog.rows.has(provider))) return { ok: true, catalog: cached.catalog };
    rowsFor = [...new Set([...cached.catalog.rows.keys(), ...rowsFor])];
  }
  const read = parseCatalog(file, sourceDir, rowsFor);
  if (read.ok) cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, catalog: read.catalog };
  return read;
}

/** omp's built-in default models per role (`smol`, `slow`, `image`, …), most preferred first. */
export type CatalogRoleDefaults = Readonly<Record<string, readonly string[]>>;

export type CatalogRoleDefaultsRead = { ok: true; file: string; defaults: CatalogRoleDefaults } | { ok: false; reason: string };

let cachedRoleDefaults: { file: string; mtimeMs: number; size: number; defaults: CatalogRoleDefaults } | null = null;

/**
 * The default model chain omp ranks for each role, from the catalog package's
 * compiled rules (`src/compat/rules.json`, `behavior.roleDefaults`: omp's own
 * `roleDefaultModels()`). Older omp releases shipped only `smol` and `slow`,
 * as `<omp>/src/priority.json`, and carry no such block: that is a reason, not
 * an empty answer, so the caller can fall back to the file. Cached by the
 * rules file's mtime and size, like the catalog.
 */
export function readCatalogRoleDefaults(packageRoot: string | null = findOmpPackageRoot()): CatalogRoleDefaultsRead {
  if (!packageRoot) return failure("omp's install could not be found");
  const sourceDir = catalogSourceDir(packageRoot);
  if (!sourceDir) return failure("omp's catalog package (@oh-my-pi/pi-catalog) was not found next to it");
  const file = join(sourceDir, "compat", "rules.json");
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return failure(`${file} does not exist`);
  }
  if (cachedRoleDefaults && cachedRoleDefaults.file === file && cachedRoleDefaults.mtimeMs === stat.mtimeMs && cachedRoleDefaults.size === stat.size) {
    return { ok: true, file, defaults: cachedRoleDefaults.defaults };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return failure(`${file} could not be parsed (${error instanceof Error ? error.message : String(error)})`);
  }
  const roleDefaults = isRecord(parsed) && isRecord(parsed.behavior) ? parsed.behavior.roleDefaults : undefined;
  if (!isRecord(roleDefaults)) return failure(`${file} has no role defaults (behavior.roleDefaults)`);
  const defaults: Record<string, readonly string[]> = {};
  for (const [role, chain] of Object.entries(roleDefaults)) {
    // A role whose list is not a list of selectors is dropped, not guessed at.
    if (Array.isArray(chain) && chain.every((entry) => typeof entry === "string")) defaults[role] = chain as string[];
  }
  if (Object.keys(defaults).length === 0) return failure(`${file} lists no role defaults`);
  cachedRoleDefaults = { file, mtimeMs: stat.mtimeMs, size: stat.size, defaults };
  return { ok: true, file, defaults };
}
