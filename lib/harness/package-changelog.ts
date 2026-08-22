import { gunzipSync } from "zlib";
import { isNewerVersion } from "../npm-update";

/**
 * Release notes for the version an engine update would install.
 *
 * The installed package's CHANGELOG.md can only ever describe the release the
 * user already has, so while an update is pending the notes must come from
 * the published package: its npm tarball is the one artifact that provably
 * matches what the Update button will install (same registry, same spec).
 * The tarball is ~12MB, so a fetched changelog is cached per exact version
 * for the life of the process — a version's notes never change once
 * published, and a new release simply misses the cache once.
 */

export interface ChangelogEntry {
  heading: string;
  body: string;
  /** Strictly newer than the installed engine — what an update would apply. */
  isNew: boolean;
}

export interface ChangelogPayload {
  entries: ChangelogEntry[] | null;
  /** Human-readable explanation when entries is null. */
  reason: string | null;
  /** Which package's changelog the entries came from: the latest published
   * one (update pending) or the installed one (up to date, or the registry
   * fetch failed and the installed file is the honest fallback). */
  source: "latest" | "installed" | null;
  /** The registry knows a newer version than the installed binary. With
   * source "installed" this is the payload's own admission that the pending
   * release's notes could not be fetched — the client must not infer that
   * from its separately-cached update state, which may be newer or older
   * than this response. */
  updatePending: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
}

/** Older sections shown even when nothing is pending — recent context. */
const MAX_ENTRIES = 5;
/** Pending-update sections shown, so a user several releases behind sees
 * everything the update applies, not an arbitrary top five. */
const MAX_NEW_ENTRIES = 20;
const MAX_TOTAL_BYTES = 48_000;
const MAX_ENTRY_BYTES = 12_000;

const FETCH_TIMEOUT_MS = 30_000;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
/** gunzip output ceiling: well above any real package, far below a zip bomb. */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const FAILURE_RETRY_MS = 10 * 60_000;

const changelogCache = new Map<string, { text: string | null; fetchedAt: number }>();
/** One download per version at a time: concurrent opens (or an impatient
 * toggle) attach to the in-flight promise instead of stacking 12MB fetches
 * and their gunzip stalls on the request thread. */
const inflightFetches = new Map<string, Promise<string | null>>();

/** Keep-a-Changelog release sections, newest first. Every section that the
 * pending update would apply is included (capped), then older sections pad
 * the list to MAX_ENTRIES for context. */
export function parseChangelogEntries(text: string, installedVersion: string | null): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let total = 0;
  // "## [17.3.5] - 2026-08-16" (or unbracketed "## 17.3.5") heads a section.
  const sections = text.split(/^## (?=\[?\d)/m).slice(1);
  for (const section of sections) {
    const newline = section.indexOf("\n");
    const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
    const body = (newline === -1 ? "" : section.slice(newline + 1)).trim();
    const clipped = body.length > MAX_ENTRY_BYTES ? `${body.slice(0, MAX_ENTRY_BYTES)}\n…` : body;
    const version = heading.match(/^\[?(\d+(?:\.\d+){2}[^\]\s]*)/)?.[1] ?? null;
    const isNew = Boolean(
      installedVersion && version && isNewerVersion(version, installedVersion),
    );
    const wanted = (isNew && entries.length < MAX_NEW_ENTRIES) || entries.length < MAX_ENTRIES;
    if (!wanted || total >= MAX_TOTAL_BYTES) break;
    entries.push({ heading, body: clipped, isNew });
    total += heading.length + clipped.length;
  }
  return entries;
}

/** One file's text out of an uncompressed tar stream. Handles plain ustar
 * (name + prefix fields) and GNU 'L' long-name records — all npm publishes
 * use — and skips anything else without trusting it. */
export function extractTarEntry(tar: Buffer, wantedPath: string): string | null {
  let offset = 0;
  let pendingLongName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/[\0 ][\s\S]*$/, "");
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isInteger(size) || size < 0) return null;
    const type = String.fromCharCode(header[156]);
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0[\s\S]*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0[\s\S]*$/, "");
    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    const dataStart = offset + 512;
    if (type === "L") {
      pendingLongName = tar.subarray(dataStart, dataStart + size).toString("utf8").replace(/\0[\s\S]*$/, "");
    } else if ((type === "0" || type === "\0") && name === wantedPath) {
      return tar.subarray(dataStart, dataStart + size).toString("utf8");
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** CHANGELOG.md text from the published npm package at an exact version, or
 * null when the registry, tarball, or file is unavailable. Failures are
 * cached briefly so an offline server does not re-download on every open. */
export async function fetchPublishedChangelog(
  packageName: string,
  version: string,
): Promise<string | null> {
  const key = `${packageName}@${version}`;
  const cached = changelogCache.get(key);
  if (cached && (cached.text !== null || Date.now() - cached.fetchedAt < FAILURE_RETRY_MS)) {
    return cached.text;
  }
  const inflight = inflightFetches.get(key);
  if (inflight) return inflight;
  const task = downloadChangelog(packageName, version).then((text) => {
    changelogCache.set(key, { text, fetchedAt: Date.now() });
    return text;
  });
  inflightFetches.set(key, task);
  try {
    return await task;
  } finally {
    inflightFetches.delete(key);
  }
}

async function downloadChangelog(packageName: string, version: string): Promise<string | null> {
  try {
    const metaResponse = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
      { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    const meta = metaResponse.ok
      ? ((await metaResponse.json()) as { dist?: { tarball?: unknown } })
      : null;
    const tarballUrl = typeof meta?.dist?.tarball === "string" ? new URL(meta.dist.tarball) : null;
    // The registry names its own download host; anything else is not a place
    // this server should be sent to fetch from.
    if (tarballUrl?.protocol !== "https:" || tarballUrl.hostname !== "registry.npmjs.org") {
      return null;
    }
    const response = await fetch(tarballUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    // Refuse oversized bodies before buffering them — the cap is pointless
    // once the allocation has happened. The post-buffer check stays for a
    // missing or lying content-length header.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TARBALL_BYTES) return null;
    const tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
    return extractTarEntry(tar, "package/CHANGELOG.md");
  } catch {
    return null;
  }
}

/**
 * The changelog an engine row should show: the latest published package's
 * when the registry knows a newer version than the installed one, otherwise
 * the installed package's own file. A failed fetch falls back to the
 * installed file rather than an empty panel — the UI can tell from `source`
 * that the pending release's notes are missing.
 */
export async function buildChangelogPayload(options: {
  packageName: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  readInstalledChangelog: () => string | null;
  fetchPublished?: (packageName: string, version: string) => Promise<string | null>;
}): Promise<ChangelogPayload> {
  const { packageName, installedVersion, latestVersion } = options;
  const fetchPublished = options.fetchPublished ?? fetchPublishedChangelog;
  const updatePending = Boolean(
    packageName && latestVersion &&
      (installedVersion === null || isNewerVersion(latestVersion, installedVersion)),
  );

  let text: string | null = null;
  let source: ChangelogPayload["source"] = null;
  if (updatePending) {
    text = await fetchPublished(packageName as string, latestVersion as string);
    if (text !== null) source = "latest";
  }
  if (text === null) {
    try {
      text = options.readInstalledChangelog();
    } catch {
      text = null;
    }
    if (text !== null) source = "installed";
  }

  // A parse that yields zero sections is as useless as a missing file, and
  // worse to render: an empty array reads as a blank panel, not an answer.
  const entries = text === null ? null : parseChangelogEntries(text, installedVersion);
  const usable = entries !== null && entries.length > 0;
  return {
    entries: usable ? entries : null,
    reason: usable
      ? null
      : text === null
        ? "The engine's changelog is not available here or from the registry."
        : "No release sections were found in the engine's changelog.",
    source: usable ? source : null,
    updatePending,
    installedVersion,
    latestVersion,
  };
}
