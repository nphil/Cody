import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/engine-guard";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  isValidNameSegment,
  parsePluginId,
  readMarketplaceCatalog,
  readMarketplaces,
} from "@/lib/omp/marketplace";
import { parseJsonLoose, runOmpCli } from "@/lib/omp/plugin-cli";
import type {
  MarketplaceBrowseResponse,
  MarketplaceListEntry,
  MarketplacePluginListing,
  PluginScope,
} from "@/lib/api-types";

export const dynamic = "force-dynamic";

// Marketplace browsing is a pure-Node read of marketplaces.json + each
// marketplace's cached catalog (lib/omp/marketplace.ts); every mutation
// (add/remove/update marketplace, install/uninstall/upgrade a plugin) shells
// out to `omp plugin ...` — Cody never embeds the Bun-only SDK. `--json`
// shapes mirror oh-my-pi coding-agent src/cli/plugin-cli.ts +
// extensibility/plugins/marketplace, same as /api/plugins.

type MarketplaceAction =
  | "addMarketplace"
  | "removeMarketplace"
  | "updateMarketplaces"
  | "install"
  | "uninstall"
  | "upgrade";

interface MarketplacePostBody {
  action?: MarketplaceAction;
  cwd?: string;
  source?: string;
  name?: string;
  marketplace?: string;
  scope?: PluginScope;
  id?: string;
}

interface OmpMarketplaceEntry {
  scope?: "user" | "project";
  installPath?: string;
  version?: string;
  enabled?: boolean;
}

interface OmpMarketplacePlugin {
  id: string;
  scope?: "user" | "project";
  entries?: OmpMarketplaceEntry[];
  shadowedBy?: string;
}

interface OmpPluginList {
  npm?: unknown[];
  marketplace?: OmpMarketplacePlugin[];
}

interface InstalledMarketplaceEntry {
  scope: PluginScope;
  version?: string;
  enabled?: boolean;
}

/** `omp plugin list --json`'s marketplace half, keyed by "name@marketplace"
 * id. Best-effort: a missing/failing omp binary leaves the map empty rather
 * than failing the whole browse view — the catalog is still worth showing. */
async function readInstalledMarketplacePlugins(cwd: string): Promise<Map<string, InstalledMarketplaceEntry>> {
  const map = new Map<string, InstalledMarketplaceEntry>();
  try {
    const { stdout } = await runOmpCli(["plugin", "list", "--json"], { cwd, timeout: 60_000 });
    const list = parseJsonLoose<OmpPluginList>(stdout);
    for (const plugin of list?.marketplace ?? []) {
      const entry = plugin.entries?.[0];
      map.set(plugin.id, {
        scope: plugin.scope === "project" ? "project" : "global",
        version: entry?.version,
        enabled: entry?.enabled,
      });
    }
  } catch {
    // omp not installed, or `plugin list` failed — browse still works.
  }
  return map;
}

async function readMarketplaceBrowse(cwd: string): Promise<MarketplaceBrowseResponse> {
  const marketplaces = readMarketplaces();
  const installed = await readInstalledMarketplacePlugins(cwd);

  const marketplaceEntries: MarketplaceListEntry[] = [];
  const plugins: MarketplacePluginListing[] = [];

  for (const marketplace of marketplaces) {
    let catalogPlugins: ReturnType<typeof readMarketplaceCatalog> = null;
    let catalogMissing = false;
    try {
      catalogPlugins = readMarketplaceCatalog(marketplace);
      if (catalogPlugins === null) catalogMissing = true;
    } catch {
      // A malformed catalog is surfaced the same way as a missing one: the
      // UI offers "update marketplace" either way rather than an error page.
      catalogMissing = true;
    }

    marketplaceEntries.push({
      name: marketplace.name,
      sourceUri: marketplace.sourceUri,
      sourceType: marketplace.sourceType,
      updatedAt: marketplace.updatedAt,
      ...(catalogMissing ? { catalogMissing: true } : {}),
    });

    for (const plugin of catalogPlugins ?? []) {
      const id = `${plugin.name}@${marketplace.name}`;
      const installedEntry = installed.get(id);
      plugins.push({
        name: plugin.name,
        marketplace: marketplace.name,
        description: plugin.description,
        version: plugin.version,
        author: plugin.author?.name,
        homepage: plugin.homepage,
        repository: plugin.repository,
        license: plugin.license,
        category: plugin.category,
        keywords: plugin.keywords,
        tags: plugin.tags,
        installed: Boolean(installedEntry),
        installedScope: installedEntry?.scope,
        enabled: installedEntry?.enabled,
        installedVersion: installedEntry?.version,
        updateAvailable: installedEntry?.version && plugin.version
          ? installedEntry.version !== plugin.version
          : undefined,
      });
    }
  }

  return { marketplaces: marketplaceEntries, plugins };
}

function scopeArgs(scope: unknown): string[] {
  return scope === "project" ? ["--scope", "project"] : [];
}

/** Dynamic CLI failures keep their message; a missing omp binary is the one
 * known cause worth a stable code for client-side localization. Matches
 * /api/plugins's error shape. */
function marketplaceErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("omp binary not found")) {
    return NextResponse.json({ error: message, code: "omp_not_found" }, { status: 500 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(req: Request) {
  // `omp plugin …` is the only implementation here; an engine that reports
  // `capabilities.plugins` false has no plugin CLI for Cody to shell out to.
  const gate = requireCapability("plugins", "plugin management");
  if ("response" in gate) return gate.response;
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    return NextResponse.json(await readMarketplaceBrowse(cwd));
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}

// POST /api/plugins/marketplace body: { action, cwd, ... }
export async function POST(req: Request) {
  // `omp plugin …` is the only implementation here; an engine that reports
  // `capabilities.plugins` false has no plugin CLI for Cody to shell out to.
  const gate = requireCapability("plugins", "plugin management");
  if ("response" in gate) return gate.response;
  try {
    const body = (await req.json()) as MarketplacePostBody;
    if (!body.cwd) return NextResponse.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });
    if (!body.action) return NextResponse.json({ error: "action required", code: "action_required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const cwd = body.cwd;

    switch (body.action) {
      case "addMarketplace": {
        const source = body.source?.trim();
        if (!source) return NextResponse.json({ error: "source required", code: "source_required" }, { status: 400 });
        // A leading dash would reach the CLI as a flag, not a source.
        if (source.startsWith("-")) {
          return NextResponse.json({ error: `Invalid marketplace source: "${source}"`, code: "invalid_name" }, { status: 400 });
        }
        await runOmpCli(["plugin", "marketplace", "add", source], { cwd, timeout: 300_000 });
        break;
      }
      case "removeMarketplace": {
        const name = body.name?.trim();
        if (!name) return NextResponse.json({ error: "name required", code: "name_required" }, { status: 400 });
        if (!isValidNameSegment(name)) {
          return NextResponse.json({ error: `Invalid marketplace name: "${name}"`, code: "invalid_name" }, { status: 400 });
        }
        await runOmpCli(["plugin", "marketplace", "remove", name], { cwd, timeout: 60_000 });
        break;
      }
      case "updateMarketplaces": {
        const name = body.name?.trim();
        if (name && !isValidNameSegment(name)) {
          return NextResponse.json({ error: `Invalid marketplace name: "${name}"`, code: "invalid_name" }, { status: 400 });
        }
        await runOmpCli(["plugin", "marketplace", "update", ...(name ? [name] : [])], { cwd, timeout: 300_000 });
        break;
      }
      case "install": {
        const name = body.name?.trim();
        const marketplace = body.marketplace?.trim();
        if (!name || !marketplace) {
          return NextResponse.json({ error: "name and marketplace required", code: "name_required" }, { status: 400 });
        }
        if (!isValidNameSegment(name) || !isValidNameSegment(marketplace)) {
          return NextResponse.json({ error: "Invalid plugin or marketplace name", code: "invalid_name" }, { status: 400 });
        }
        await runOmpCli(
          ["plugin", "install", `${name}@${marketplace}`, "--json", ...scopeArgs(body.scope)],
          { cwd, timeout: 300_000 },
        );
        break;
      }
      case "uninstall": {
        const id = body.id?.trim();
        if (!id) return NextResponse.json({ error: "id required", code: "id_required" }, { status: 400 });
        if (!parsePluginId(id)) {
          return NextResponse.json({ error: `Invalid plugin id: "${id}"`, code: "invalid_id" }, { status: 400 });
        }
        await runOmpCli(["plugin", "uninstall", id, "--json", ...scopeArgs(body.scope)], { cwd, timeout: 120_000 });
        break;
      }
      case "upgrade": {
        const id = body.id?.trim();
        if (id && !parsePluginId(id)) {
          return NextResponse.json({ error: `Invalid plugin id: "${id}"`, code: "invalid_id" }, { status: 400 });
        }
        await runOmpCli(["plugin", "upgrade", ...(id ? [id] : [])], { cwd, timeout: 300_000 });
        break;
      }
      default:
        return NextResponse.json({ error: `Unsupported action: ${body.action}`, code: "marketplace_unsupported_action" }, { status: 400 });
    }

    return NextResponse.json(await readMarketplaceBrowse(cwd));
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
