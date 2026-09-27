import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

export const REFUSAL_POLICY_FILE = "cody-refusal-policy.json";
const FILE_VERSION = 1;

export type RefusalPolicy = "ask" | "rewind" | "fallback";
export type RefusalPolicyConfig = { policy: RefusalPolicy };

export function isRefusalPolicy(value: unknown): value is RefusalPolicy {
  return value === "ask" || value === "rewind" || value === "fallback";
}

export function getRefusalPolicyConfigPath(): string {
  return path.join(getAgentDir(), REFUSAL_POLICY_FILE);
}

function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

export function readRefusalPolicyConfig(): RefusalPolicyConfig {
  const configPath = getRefusalPolicyConfigPath();
  if (!existsSync(configPath)) return { policy: "ask" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return isRecord(parsed) && isRefusalPolicy(parsed.policy) ? { policy: parsed.policy } : { policy: "ask" };
  } catch {
    return { policy: "ask" };
  }
}

export function writeRefusalPolicyConfig(config: RefusalPolicyConfig): RefusalPolicyConfig {
  const normalized: RefusalPolicyConfig = { policy: isRefusalPolicy(config.policy) ? config.policy : "ask" };
  writeJsonAtomic(getRefusalPolicyConfigPath(), { version: FILE_VERSION, policy: normalized.policy });
  return normalized;
}
