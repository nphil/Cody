import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import { asString, isRecord } from "../type-guards";
import { getMarketplacesRegistryPath } from "./paths";

/**
 * Pure-Node reader for omp's plugin marketplace system — the browse side of
 * `omp plugin marketplace`. Shapes mirror oh-my-pi
 * src/extensibility/plugins/marketplace/{types,registry,fetcher}.ts closely
 * enough to parse the files the real omp binary writes, but this module never
 * shells out and never writes: mutations (add/remove/update marketplace,
 * install/uninstall/upgrade a plugin) go through the CLI in
 * app/api/plugins/marketplace/route.ts, same as /api/plugins already does for
 * plain plugin installs.
 */

const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;

/** Validate a plugin or marketplace name segment — the same rule omp's own
 * `isValidNameSegment` enforces before it will splice a name into a path or
 * an id like "name@marketplace". Used both to filter malformed catalog/
 * registry entries here and to validate route input before it reaches argv. */
export function isValidNameSegment(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NAME_LENGTH && NAME_RE.test(value);
}

/** Parse `"name@marketplace"` → `{ name, marketplace }`, or null. Faithful
 * port of omp's parsePluginId (marketplace/types.ts). */
export function parsePluginId(id: string): { name: string; marketplace: string } | null {
  const atIndex = id.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === id.length - 1) return null;
  const name = id.slice(0, atIndex);
  const marketplace = id.slice(atIndex + 1);
  if (!isValidNameSegment(name) || !isValidNameSegment(marketplace)) return null;
  return { name, marketplace };
}

export type MarketplaceSourceType = "github" | "git" | "url" | "local";

export interface MarketplaceInfo {
  name: string;
  sourceType: MarketplaceSourceType;
  sourceUri: string;
  catalogPath: string;
  addedAt: string;
  updatedAt: string;
}

export interface CatalogPluginAuthor {
  name: string;
  email?: string;
}

/** One plugin entry from a marketplace's catalog (marketplace.json), tagged
 * with the marketplace it came from. Omits omp's `source` field (an
 * install/build detail) — installing goes through `name@marketplace`, never
 * the raw source, so the browse UI has no use for it. */
export interface CatalogPlugin {
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  author?: CatalogPluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  category?: string;
  tags?: string[];
}

function readJsonFile(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Expand a leading `~` against the current user's home — catalogPath in the
 * marketplaces registry may be written with `~` (e.g. a local-source
 * marketplace under the home dir). */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
  return value;
}

function readSourceType(value: unknown): MarketplaceSourceType {
  return value === "github" || value === "git" || value === "url" || value === "local" ? value : "git";
}

/**
 * Read marketplaces.json: the registry of marketplace catalogs the user has
 * added (`omp plugin marketplace add`). A missing file means none are
 * configured yet — []. A malformed file throws: unlike omp's own reader
 * (which silently treats a corrupt registry as empty so the CLI keeps
 * working on the caller's behalf), Cody never gets a chance to repair or
 * rewrite this file, so masking the problem would just make it invisible.
 * Individual malformed marketplace entries are skipped rather than failing
 * the whole registry.
 *
 * `registryPath` defaults to getMarketplacesRegistryPath() — overridable so
 * tests can point at a fixture without touching process-wide path state.
 */
export function readMarketplaces(registryPath: string = getMarketplacesRegistryPath()): MarketplaceInfo[] {
  if (!existsSync(registryPath)) return [];
  const data = readJsonFile(registryPath);
  if (!isRecord(data) || !Array.isArray(data.marketplaces)) {
    throw new Error(`Marketplaces registry at ${registryPath} has an unexpected shape (expected { marketplaces: [...] }).`);
  }
  const result: MarketplaceInfo[] = [];
  for (const entry of data.marketplaces) {
    if (!isRecord(entry)) continue;
    const name = asString(entry.name);
    const catalogPath = asString(entry.catalogPath);
    const sourceUri = asString(entry.sourceUri);
    if (!name || !isValidNameSegment(name) || !catalogPath || !sourceUri) continue;
    result.push({
      name,
      sourceType: readSourceType(entry.sourceType),
      sourceUri,
      catalogPath,
      addedAt: asString(entry.addedAt) ?? "",
      updatedAt: asString(entry.updatedAt) ?? "",
    });
  }
  return result;
}

function readAuthor(value: unknown): CatalogPluginAuthor | undefined {
  if (!isRecord(value)) return undefined;
  const name = asString(value.name);
  if (!name) return undefined;
  const email = asString(value.email);
  return email ? { name, email } : { name };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

/**
 * Read one marketplace's catalog (marketplace.json at its catalogPath, `~`
 * expanded) and return its plugin entries, each tagged with the owning
 * marketplace's name.
 *
 * Returns `null` when the catalog file itself is missing — not an error: a
 * marketplace can be registered before its catalog has ever been fetched, or
 * the cache can be cleared out from under the registry. The caller shows a
 * "run update" hint instead of failing the whole browse view. A malformed
 * catalog (wrong top-level shape) still throws; individual malformed plugin
 * entries are skipped.
 */
export function readMarketplaceCatalog(entry: Pick<MarketplaceInfo, "name" | "catalogPath">): CatalogPlugin[] | null {
  const catalogPath = expandHome(entry.catalogPath);
  if (!existsSync(catalogPath)) return null;
  const data = readJsonFile(catalogPath);
  if (!isRecord(data) || !Array.isArray(data.plugins)) {
    throw new Error(`Marketplace catalog at ${catalogPath} has an unexpected shape (expected { plugins: [...] }).`);
  }
  const plugins: CatalogPlugin[] = [];
  for (const raw of data.plugins) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name);
    if (!name || !isValidNameSegment(name)) continue;
    plugins.push({
      name,
      marketplace: entry.name,
      description: asString(raw.description),
      version: asString(raw.version),
      author: readAuthor(raw.author),
      homepage: asString(raw.homepage),
      repository: asString(raw.repository),
      license: asString(raw.license),
      keywords: readStringArray(raw.keywords),
      category: asString(raw.category),
      tags: readStringArray(raw.tags),
    });
  }
  return plugins;
}
