import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isMap, parseDocument, stringify } from "yaml";
import { findOmpPackageRoot, loadOmpPackageSource, ompPackageVersion } from "./package-source";
import { getAgentDir } from "./paths";
import { isRecord } from "../type-guards";

export type ModelRoles = Record<string, string>;

/** OMP's built-in roles as of the release Cody was last audited against. Used
 * only when the installed package cannot be read (omp absent, or a layout
 * change upstream) — the live list comes from the engine itself. */
export const FALLBACK_MODEL_ROLE_IDS: readonly string[] = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "commit",
  "tiny",
  "task",
  "advisor",
];

let cachedRoleIds: { key: string; ids: readonly string[] } | null = null;

/**
 * The roles the INSTALLED omp actually resolves, read from its own
 * `src/config/model-roles.ts` (`MODEL_ROLE_IDS`) — the same
 * read-it-from-the-engine rule the settings schema follows.
 *
 * Hand-listing them went wrong the moment upstream dropped one: omp removed
 * `designer`, and Cody carried on writing `modelRoles.designer` into config.yml
 * for a role the resolver no longer has and offering it in the plan editor. The
 * engine owns the vocabulary; Cody reads it and assigns only what is there.
 */
export function getOmpModelRoleIds(): readonly string[] {
  const packageRoot = findOmpPackageRoot();
  if (!packageRoot) return FALLBACK_MODEL_ROLE_IDS;
  const cacheKey = `${packageRoot}@${ompPackageVersion(packageRoot) ?? "unknown"}`;
  if (cachedRoleIds?.key === cacheKey) return cachedRoleIds.ids;

  const loaded = loadOmpPackageSource(packageRoot, "src", "config", "model-roles.ts");
  const declared = loaded?.MODEL_ROLE_IDS;
  const ids = Array.isArray(declared)
    ? declared.filter((role): role is string => typeof role === "string" && role.length > 0)
    : [];
  cachedRoleIds = { key: cacheKey, ids: ids.length > 0 ? ids : FALLBACK_MODEL_ROLE_IDS };
  return cachedRoleIds.ids;
}

/** Drop the memoized role list so the next read re-evaluates the package. */
export function clearOmpModelRoleIdsCache(): void {
  cachedRoleIds = null;
}

function configPath(): string {
  return join(getAgentDir(), "config.yml");
}

/** Reads the native OMP role selectors from config.yml without touching other settings. */
export function readModelRoles(): { path: string; roles: ModelRoles } {
  const path = configPath();
  if (!existsSync(path)) return { path, roles: {} };
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (!isRecord(data) || !isRecord(data.modelRoles)) return { path, roles: {} };
  return {
    path,
    roles: Object.fromEntries(Object.entries(data.modelRoles).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

/** Updates only modelRoles, preserving the user's remaining native OMP config. */
export function writeModelRoles(roles: ModelRoles): void {
  const path = configPath();
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  if (doc.contents === null) {
    writeFileSync(temp, stringify({ modelRoles: roles }), "utf8");
  } else {
    if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
    doc.set("modelRoles", roles);
    writeFileSync(temp, doc.toString(), "utf8");
  }
  renameSync(temp, path);
}

/** Remove the modelRoles section entirely, restoring omp's out-of-the-box role
 * resolution (built-in per-role priority lists; unset roles follow the default
 * model). Returns whether anything was removed. */
export function clearModelRoles(): boolean {
  const path = configPath();
  if (!existsSync(path)) return false;
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) return false;
  if (!doc.delete("modelRoles")) return false;
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, doc.toString(), "utf8");
  renameSync(temp, path);
  return true;
}

export function readDisabledProviders(): Set<string> {
  const path = configPath();
  if (!existsSync(path)) return new Set();
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (!isRecord(data) || !Array.isArray(data.disabledProviders)) return new Set();
  return new Set(data.disabledProviders.filter((provider): provider is string => typeof provider === "string"));
}

/** Re-enable a provider after a successful native OMP login. */
export function enableProvider(provider: string): void {
  const path = configPath();
  if (!existsSync(path)) return;
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
  const data = doc.toJS();
  const disabled = isRecord(data) && Array.isArray(data.disabledProviders)
    ? data.disabledProviders.filter((value): value is string => typeof value === "string")
    : [];
  const next = disabled.filter((value) => value !== provider);
  if (next.length === disabled.length) return;
  doc.set("disabledProviders", next);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, doc.toString(), "utf8");
  renameSync(temp, path);
}
