import { parseSkillFrontmatter } from "@/lib/skills-service";

/**
 * Client for the public skills.sh registry — the same host `npx skills` talks
 * to, using the same unauthenticated endpoints:
 *
 *   GET /api/search?q&limit          search (the CLI's `searchSkillsAPI`)
 *   GET /api/download/{o}/{r}/{slug} a skill's files, for descriptions/README
 *
 * The documented `/api/v1/*` surface (leaderboard, curated) requires a Vercel
 * OIDC token, so it is unreachable from Cody. Browsing is therefore built from
 * real search results for a fixed set of category queries — never a scraped or
 * invented ranking.
 *
 * Search relevance is the registry's: single-word queries match fuzzily,
 * multi-word queries run semantic search over skill descriptions, which is
 * what makes "find me something that reviews database migrations" work.
 */

const REGISTRY_BASE = (process.env.SKILLS_API_URL || "https://skills.sh").replace(/\/+$/, "");
const SEARCH_TIMEOUT_MS = 12_000;
const DETAIL_TIMEOUT_MS = 15_000;
/** Upstream returns every file inline; refuse pathological repos outright. */
const MAX_DETAIL_BYTES = 4 * 1024 * 1024;
const MAX_README_CHARS = 8_000;
const SEARCH_TTL_MS = 10 * 60_000;
const DETAIL_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 400;
const MIN_QUERY_LENGTH = 2;
export const MAX_STORE_LIMIT = 100;
/** Descriptions are fetched one file-listing per skill; bound the fan-out. */
export const MAX_DESCRIPTION_BATCH = 24;
const DESCRIPTION_CONCURRENCY = 4;

export type SkillSourceType = "github" | "well-known";

export interface RegistrySkill {
  /** "{source}/{slug}" — stable registry id. */
  id: string;
  slug: string;
  name: string;
  /** "owner/repo" for GitHub skills, a bare domain for well-known ones. */
  source: string;
  sourceType: SkillSourceType;
  installs: number;
  installsLabel: string;
  /** Spec accepted by `npx skills add`, i.e. what /api/skills/install takes. */
  package: string;
  /** Page on skills.sh. */
  url: string;
}

export interface SkillStoreDetail {
  id: string;
  name?: string;
  description: string;
  readme: string;
  readmeTruncated: boolean;
  files: { path: string; bytes: number }[];
}

export interface SkillCategory {
  id: string;
  /** Multi-word on purpose: that is what selects semantic search upstream. */
  query: string;
}

export const SKILL_CATEGORIES: readonly SkillCategory[] = [
  { id: "frontend", query: "react frontend ui components" },
  { id: "backend", query: "backend api server framework" },
  { id: "database", query: "database sql schema migrations" },
  { id: "testing", query: "testing unit tests end to end" },
  { id: "devops", query: "docker kubernetes deployment ci" },
  { id: "review", query: "code review refactoring quality" },
  { id: "docs", query: "documentation writing technical docs" },
  { id: "mobile", query: "mobile ios android app" },
];

// ── cache ────────────────────────────────────────────────────────────────────
// globalThis so Next.js hot-reload does not drop it (same reason as the
// display bus). Insertion-ordered Map doubles as the LRU.

interface CacheEntry {
  value: unknown;
  expires: number;
}

const cacheGlobal = globalThis as typeof globalThis & {
  __codySkillsRegistryCache?: Map<string, CacheEntry>;
};
const cache: Map<string, CacheEntry> = (cacheGlobal.__codySkillsRegistryCache ??= new Map());

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number): T {
  cache.delete(key);
  cache.set(key, { value, expires: Date.now() + ttlMs });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return value;
}

/** Test seam: drop everything the registry has memoized. */
export function clearSkillsRegistryCache(): void {
  cache.clear();
}

// ── pure helpers ─────────────────────────────────────────────────────────────

export function formatInstalls(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.floor(count));
}

export function skillSourceType(source: string): SkillSourceType {
  return source.includes("/") ? "github" : "well-known";
}

/**
 * Install spec for `npx skills add`. GitHub skills address a single skill as
 * `owner/repo@slug`. Well-known providers have no per-skill selector in the
 * CLI — only the provider URL — so installing one pulls that provider's set;
 * the UI says so rather than pretending otherwise.
 */
export function installSpecFor(source: string, slug: string): string {
  return skillSourceType(source) === "github" ? `${source}@${slug}` : `https://${source}`;
}

const ID_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Guards the segments before they are interpolated into an upstream path. */
export function isValidSkillId(id: string): boolean {
  const segments = id.split("/");
  if (segments.length < 2 || segments.length > 3) return false;
  return segments.every((segment) => ID_SEGMENT_RE.test(segment) && segment !== "." && segment !== "..");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeRegistrySkill(raw: unknown): RegistrySkill | null {
  const record = asRecord(raw);
  if (!record) return null;

  const source = asString(record.source);
  const id = asString(record.id);
  const slug = asString(record.skillId) || asString(record.slug) || id.slice(source.length + 1);
  const name = asString(record.name) || slug;
  if (!source || !slug || !name) return null;

  const fullId = id || `${source}/${slug}`;
  if (!isValidSkillId(fullId)) return null;

  const installsRaw = record.installs;
  const installs = typeof installsRaw === "number" && Number.isFinite(installsRaw) && installsRaw > 0
    ? Math.floor(installsRaw)
    : 0;

  return {
    id: fullId,
    slug,
    name,
    source,
    sourceType: skillSourceType(source),
    installs,
    installsLabel: formatInstalls(installs),
    package: installSpecFor(source, slug),
    url: `${REGISTRY_BASE}/${fullId.split("/").map(encodeURIComponent).join("/")}`,
  };
}

/** Dedupe by id across result sets, most-installed first, id as tiebreak. */
export function mergeRegistrySkills(lists: readonly RegistrySkill[][]): RegistrySkill[] {
  const byId = new Map<string, RegistrySkill>();
  for (const list of lists) {
    for (const skill of list) {
      const existing = byId.get(skill.id);
      if (!existing || skill.installs > existing.installs) byId.set(skill.id, skill);
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.installs - a.installs || a.id.localeCompare(b.id),
  );
}

/** First paragraph of a SKILL.md body, used when frontmatter has no description. */
function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.replace(/^#+\s.*$/gm, "").trim();
    if (text) return text.replace(/\s+/g, " ");
  }
  return "";
}

// ── network ──────────────────────────────────────────────────────────────────

async function fetchRegistryJson(path: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`${REGISTRY_BASE}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`skills.sh ${path} failed: HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_DETAIL_BYTES) {
    throw new Error(`skills.sh ${path} too large: ${length} bytes`);
  }
  return res.json();
}

export interface SkillSearchPage {
  items: RegistrySkill[];
  /** "fuzzy" for one word, "semantic" for a phrase — surfaced in the UI. */
  searchType: string;
}

export async function searchSkills(query: string, limit: number): Promise<SkillSearchPage> {
  const q = query.trim();
  const size = Math.min(MAX_STORE_LIMIT, Math.max(1, Math.floor(limit) || MAX_STORE_LIMIT));
  if (q.length < MIN_QUERY_LENGTH) return { items: [], searchType: "none" };

  const key = `search:${size}:${q.toLowerCase()}`;
  const cached = cacheGet<SkillSearchPage>(key);
  if (cached) return cached;

  const params = new URLSearchParams({ q, limit: String(size) });
  const data = asRecord(await fetchRegistryJson(`/api/search?${params}`, SEARCH_TIMEOUT_MS));
  const rawSkills = Array.isArray(data?.skills) ? data.skills : [];
  const items = rawSkills
    .map(normalizeRegistrySkill)
    .filter((skill): skill is RegistrySkill => skill !== null);

  return cacheSet(key, { items, searchType: asString(data?.searchType) || "fuzzy" }, SEARCH_TTL_MS);
}

/**
 * Browse view. A category is its own query; "popular" merges every category so
 * the store opens on real, install-ranked results instead of an empty box.
 */
export async function browseSkills(categoryId: string, limit: number): Promise<RegistrySkill[]> {
  const size = Math.min(MAX_STORE_LIMIT, Math.max(1, Math.floor(limit) || MAX_STORE_LIMIT));
  const category = SKILL_CATEGORIES.find((entry) => entry.id === categoryId);
  if (category) return (await searchSkills(category.query, size)).items.slice(0, size);

  const lists = await Promise.all(
    SKILL_CATEGORIES.map(async (entry) => {
      try {
        return (await searchSkills(entry.query, size)).items;
      } catch {
        return [];
      }
    }),
  );
  const merged = mergeRegistrySkills(lists);
  if (merged.length === 0) throw new Error("skills.sh browse failed");
  return merged.slice(0, size);
}

interface DownloadedFile {
  path: string;
  contents: string;
}

async function fetchSkillFiles(id: string): Promise<DownloadedFile[]> {
  // Only GitHub-backed skills ("owner/repo/slug") have a download route.
  if (id.split("/").length !== 3) return [];
  const path = `/api/download/${id.split("/").map(encodeURIComponent).join("/")}`;
  const data = asRecord(await fetchRegistryJson(path, DETAIL_TIMEOUT_MS));
  const files = Array.isArray(data?.files) ? data.files : [];
  return files
    .map((file) => {
      const record = asRecord(file);
      const filePath = asString(record?.path);
      const contents = typeof record?.contents === "string" ? record.contents : "";
      return filePath ? { path: filePath, contents } : null;
    })
    .filter((file): file is DownloadedFile => file !== null);
}

export async function getSkillDetail(id: string): Promise<SkillStoreDetail | null> {
  if (!isValidSkillId(id)) return null;
  const key = `detail:${id}`;
  const cached = cacheGet<SkillStoreDetail>(key);
  if (cached) return cached;

  const files = await fetchSkillFiles(id);
  const skillMd = files.find((file) => file.path.toLowerCase() === "skill.md")
    ?? files.find((file) => file.path.toLowerCase().endsWith("/skill.md"));

  const { frontmatter, body } = skillMd
    ? parseSkillFrontmatter(skillMd.contents)
    : { frontmatter: {} as Record<string, unknown>, body: "" };

  const trimmedBody = body.trim();
  const detail: SkillStoreDetail = {
    id,
    name: typeof frontmatter.name === "string" ? frontmatter.name : undefined,
    description: typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : firstParagraph(trimmedBody),
    readme: trimmedBody.slice(0, MAX_README_CHARS),
    readmeTruncated: trimmedBody.length > MAX_README_CHARS,
    files: files.map((file) => ({ path: file.path, bytes: file.contents.length })),
  };
  return cacheSet(key, detail, DETAIL_TTL_MS);
}

/**
 * Descriptions for a page of results. Each one costs a file listing upstream,
 * so this is called for visible cards only, bounded and concurrency-limited,
 * and it shares the detail cache — opening a card afterwards is then free.
 */
export async function getSkillDescriptions(ids: readonly string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter(isValidSkillId))].slice(0, MAX_DESCRIPTION_BATCH);
  const out: Record<string, string> = {};
  let next = 0;

  async function worker(): Promise<void> {
    while (next < wanted.length) {
      const id = wanted[next++];
      try {
        const detail = await getSkillDetail(id);
        if (detail?.description) out[id] = detail.description;
      } catch {
        // A skill without a readable snapshot simply has no description.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DESCRIPTION_CONCURRENCY, wanted.length) }, worker),
  );
  return out;
}
