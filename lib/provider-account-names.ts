import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { isRecord } from "./type-guards";

/** Cody-only labels for provider connections. Credential material never
 * belongs in this file: an entry contains only the provider, OMP row id,
 * optional reported identity, and the label the administrator chose. */
export const PROVIDER_ACCOUNT_NAMES_FILE = "cody-provider-account-names.json";
export const MAX_PROVIDER_ACCOUNT_NAME_LENGTH = 80;
const FILE_VERSION = 1;

export interface ProviderAccountNameEntry {
  provider: string;
  accountId: string;
  identity: string | null;
  name: string;
}

interface NamesFile {
  version: number;
  names: Record<string, ProviderAccountNameEntry>;
  [extra: string]: unknown;
}

function normalizedKeyPart(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > 500) throw new Error(`${label} is too long.`);
  return normalized;
}

function normalizedIdentity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

/** Normalize the user-facing label. Empty text means "clear the label". */
export function normalizeProviderAccountName(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length > MAX_PROVIDER_ACCOUNT_NAME_LENGTH) {
    throw new Error(`Connection names must be ${MAX_PROVIDER_ACCOUNT_NAME_LENGTH} characters or fewer.`);
  }
  return normalized || null;
}

/** Identity-first key: stable OAuth identities reuse a label after a new OMP
 * row is created; credentials with no identity stay tied to their row id. */
export function providerAccountNameKey(provider: string, accountId: string, identity?: string | null): string {
  const normalizedProvider = normalizedKeyPart(provider, "Provider");
  const normalizedId = normalizedKeyPart(accountId, "Account id");
  const normalizedIdentityValue = normalizedIdentity(identity);
  return `${normalizedProvider}\u0000${normalizedIdentityValue ? `identity\u0000${normalizedIdentityValue}` : `id\u0000${normalizedId}`}`;
}

function defaultAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return path.resolve(override);
  const configured = process.env.PI_CONFIG_DIR?.trim() || ".omp";
  const root = path.isAbsolute(configured) ? path.resolve(configured) : path.join(homedir(), configured);
  const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
  return profile && profile !== "default"
    ? path.join(root, "profiles", profile, "agent")
    : path.join(root, "agent");
}

function resolvedAgentDir(agentDir?: string): string {
  return path.resolve(agentDir ?? defaultAgentDir());
}

export function getProviderAccountNamesPath(agentDir?: string): string {
  return path.join(resolvedAgentDir(agentDir), PROVIDER_ACCOUNT_NAMES_FILE);
}

function emptyFile(): NamesFile {
  return { version: FILE_VERSION, names: {} };
}

function parseEntry(key: string, value: unknown): ProviderAccountNameEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.provider !== "string" || typeof value.accountId !== "string" || typeof value.name !== "string") return null;
  const provider = value.provider.trim();
  const accountId = value.accountId.trim();
  const name = normalizeProviderAccountName(value.name);
  if (!provider || !accountId || !name) return null;
  const identity = normalizedIdentity(typeof value.identity === "string" ? value.identity : null);
  // Recompute the key rather than trusting a key copied from disk. This also
  // rejects malformed legacy records while preserving valid unknown fields at
  // the file's top level.
  if (key !== providerAccountNameKey(provider, accountId, identity)) return null;
  return { provider, accountId, identity, name };
}

function readFile(agentDir?: string): NamesFile {
  const empty = emptyFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getProviderAccountNamesPath(agentDir), "utf8"));
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  const file: NamesFile = { ...parsed, version: FILE_VERSION, names: {} };
  if (!isRecord(parsed.names)) return file;
  for (const [key, value] of Object.entries(parsed.names)) {
    try {
      const entry = parseEntry(key, value);
      if (entry) file.names[key] = entry;
    } catch {
      // A malformed entry must not make the whole provider settings panel
      // unavailable, nor should it be copied into the next valid write.
    }
  }
  return file;
}

function writeFile(file: NamesFile, agentDir?: string): void {
  const target = getProviderAccountNamesPath(agentDir);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

function cloneEntries(names: Record<string, ProviderAccountNameEntry>): Record<string, ProviderAccountNameEntry> {
  return Object.fromEntries(Object.entries(names).map(([key, entry]) => [key, { ...entry }]));
}

/** Read the sanitized name map. The returned object is detached from the
 * on-disk representation so callers cannot mutate state without a write. */
export function readProviderAccountNames(agentDir?: string): Record<string, ProviderAccountNameEntry> {
  return cloneEntries(readFile(agentDir).names);
}

export function resolveProviderAccountName(
  names: Readonly<Record<string, ProviderAccountNameEntry>>,
  provider: string,
  accountId: string,
  identity?: string | null,
): string | null {
  const identityValue = normalizedIdentity(identity);
  const identityEntry = identityValue ? names[providerAccountNameKey(provider, accountId, identityValue)] : undefined;
  if (identityEntry) return identityEntry.name;
  return names[providerAccountNameKey(provider, accountId, null)]?.name ?? null;
}

/** Save or clear a label. A stable identity is the primary key; the row id is
 * retained in each entry so removal can clean up even if a later OMP version
 * reports the identity differently. */
export function setProviderAccountName(
  provider: string,
  accountId: string,
  identity: string | null | undefined,
  name: string,
  agentDir?: string,
): string | null {
  const normalizedProvider = normalizedKeyPart(provider, "Provider");
  const normalizedId = normalizedKeyPart(accountId, "Account id");
  const normalizedIdentityValue = normalizedIdentity(identity);
  const normalizedName = normalizeProviderAccountName(name);
  const file = readFile(agentDir);

  // Replace both the exact key and any older entry for this OMP row. This
  // prevents a renamed account from leaving an orphaned id fallback behind.
  for (const [key, entry] of Object.entries(file.names)) {
    if (entry.provider === normalizedProvider && (
      entry.accountId === normalizedId ||
      (normalizedIdentityValue !== null && entry.identity === normalizedIdentityValue)
    )) delete file.names[key];
  }
  if (normalizedName) {
    file.names[providerAccountNameKey(normalizedProvider, normalizedId, normalizedIdentityValue)] = {
      provider: normalizedProvider,
      accountId: normalizedId,
      identity: normalizedIdentityValue,
      name: normalizedName,
    };
  }
  writeFile(file, agentDir);
  return normalizedName;
}

/** Forget one account's Cody label after a successful permanent purge. */
export function forgetProviderAccountName(provider: string, accountId: string, identity?: string | null, agentDir?: string): void {
  const normalizedProvider = normalizedKeyPart(provider, "Provider");
  const normalizedId = normalizedKeyPart(accountId, "Account id");
  const normalizedIdentityValue = normalizedIdentity(identity);
  const file = readFile(agentDir);
  let changed = false;
  for (const [key, entry] of Object.entries(file.names)) {
    if (entry.provider !== normalizedProvider) continue;
    if (entry.accountId === normalizedId || (normalizedIdentityValue !== null && entry.identity === normalizedIdentityValue)) {
      delete file.names[key];
      changed = true;
    }
  }
  if (changed) writeFile(file, agentDir);
}

/** Forget every Cody label for a provider after provider-wide sign-out. */
export function forgetProviderAccountNames(provider: string, agentDir?: string): void {
  const normalizedProvider = normalizedKeyPart(provider, "Provider");
  const file = readFile(agentDir);
  let changed = false;
  for (const [key, entry] of Object.entries(file.names)) {
    if (entry.provider !== normalizedProvider) continue;
    delete file.names[key];
    changed = true;
  }
  if (changed) writeFile(file, agentDir);
}
