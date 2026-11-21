import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { isIP } from "net";
import path from "path";
import { parse, stringify } from "yaml";
import {
  getPromptProfile,
  selectPromptProfileId,
  type PromptProfile,
  type PromptProfileId,
} from "./local-model-profile";
import {
  readPromptProfileOverrides,
  resolvePromptProfileOverride,
  type PromptProfileOverrideValue,
} from "./local-model-profile-store";
import { readModelsConfigFile } from "./omp/models-config";
import { getAgentDir, getSettingsPath } from "./omp/paths";
import { isRecord } from "./type-guards";

const PROFILE_DIRECTORY = "cody-local-prompt-profiles";
const PROFILE_VERSION = 1;

export interface ModelProfileTarget {
  provider: string;
  modelId: string;
  contextWindow?: number | null;
  maxTokens?: number | null;
}

export interface ResolvedLocalModelProfile {
  provider: string;
  modelId: string;
  /** Only true for a configured custom model whose endpoint is local/private. */
  isLocal: boolean;
  contextWindow?: number;
  maxTokens?: number;
  override: PromptProfileOverrideValue;
  profile: PromptProfile;
}

/** Materialized launch data. Every file name is content-addressed, including
 * the concrete window and output reservation, so concurrent sessions never
 * overwrite one another's profile. */
export interface LocalModelProfileLaunch {
  profileId: PromptProfileId;
  systemPromptPath?: string;
  toolNames?: string[];
  env?: Record<string, string>;
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;

function localAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "127.0.0.1" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return isIP(host) === 6 && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"));
}

/** An endpoint is local only when its configured HTTP(S) URL proves it:
 * private/loopback addressing. Provider names and model names are never evidence. */
export function isConfirmedLocalEndpoint(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && localAddress(url.hostname);
  } catch {
    return false;
  }
}

function configuredModel(provider: string, modelId: string) {
  const file = readModelsConfigFile();
  if (file.parseError) return undefined;
  const providerConfig = file.config.providers?.[provider];
  const model = providerConfig?.models?.find((entry) => entry.id === modelId);
  if (!providerConfig || !model) return undefined;
  return {
    contextWindow: positiveInteger(model.contextWindow),
    maxTokens: positiveInteger(model.maxTokens),
    baseUrl: model.baseUrl ?? providerConfig.baseUrl,
  };
}

/** Resolve an automatic/pinned profile. Only configured local endpoints with
 * complete window and output metadata may shrink; all other models stay full. */
export function resolveLocalModelPromptProfile(target: ModelProfileTarget): ResolvedLocalModelProfile {
  const configured = configuredModel(target.provider, target.modelId);
  const override = resolvePromptProfileOverride(readPromptProfileOverrides(), target.provider, target.modelId);
  const contextWindow = positiveInteger(target.contextWindow) ?? configured?.contextWindow;
  const maxTokens = positiveInteger(target.maxTokens) ?? configured?.maxTokens;
  const isLocal = isConfirmedLocalEndpoint(configured?.baseUrl);

  if (!isLocal || contextWindow === undefined || maxTokens === undefined) {
    return {
      provider: target.provider,
      modelId: target.modelId,
      isLocal,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      override,
      profile: getPromptProfile("full"),
    };
  }

  const profileId = selectPromptProfileId({ contextWindow, override });
  return {
    provider: target.provider,
    modelId: target.modelId,
    isLocal,
    contextWindow,
    maxTokens,
    override,
    profile: getPromptProfile(profileId, contextWindow, maxTokens),
  };
}

function disabledExtensionsFrom(filePath: string): string[] {
  try {
    const data = parse(readFileSync(filePath, "utf8"));
    if (!isRecord(data) || !Array.isArray(data.disabledExtensions)) return [];
    return data.disabledExtensions.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

function inheritedConfigFiles(): string[] {
  const configured = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
  return [...configured, getSettingsPath()];
}

function profileOverlay(profile: PromptProfile): Record<string, unknown> {
  const { disabledExtensions: profileDisabled, tools, dev, ...compaction } = profile.settingsOverlay;
  const existingDisabled = inheritedConfigFiles().flatMap(disabledExtensionsFrom);
  const disabledExtensions = Array.isArray(profileDisabled)
    ? [...new Set([...existingDisabled, ...profileDisabled.filter((entry): entry is string => typeof entry === "string")])]
    : existingDisabled;
  return {
    ...(Object.keys(compaction).length ? { compaction } : {}),
    ...(tools && isRecord(tools) ? { tools } : {}),
    ...(dev && isRecord(dev) ? { dev } : {}),
    ...(disabledExtensions.length ? { disabledExtensions } : {}),
  };
}

function writeContentAddressed(filePath: string, text: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameSync(temp, filePath);
  } catch (error) {
    // Another concurrent session may have installed the identical content.
    if (!existsSync(filePath)) throw error;
  }
}

/** Write the short prompt and configuration overlay, then return launch-only
 * arguments. It never mutates OMP's config or process environment. */
export function materializeLocalModelProfile(resolution: ResolvedLocalModelProfile): LocalModelProfileLaunch {
  const { profile } = resolution;
  if (profile.id === "full" || !profile.systemPromptText || !profile.toolNames) {
    return { profileId: profile.id };
  }

  const overlay = profileOverlay(profile);
  const identity = JSON.stringify({
    version: PROFILE_VERSION,
    profile: profile.id,
    contextWindow: resolution.contextWindow,
    maxTokens: resolution.maxTokens,
    prompt: profile.systemPromptText,
    tools: profile.toolNames,
    overlay,
  });
  const digest = createHash("sha256").update(identity).digest("hex");
  const directory = path.join(getAgentDir(), PROFILE_DIRECTORY);
  const systemPromptPath = path.join(directory, `${digest}.md`);
  const overlayPath = path.join(directory, `${digest}.yml`);
  writeContentAddressed(systemPromptPath, `${profile.systemPromptText}\n`);
  writeContentAddressed(overlayPath, stringify(overlay));

  const inherited = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
  const configFiles = [...inherited, overlayPath];
  return {
    profileId: profile.id,
    systemPromptPath,
    toolNames: [...profile.toolNames],
    env: { PI_CONFIG_FILES: configFiles.join(path.delimiter) },
  };
}
