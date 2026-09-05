"use client";

/**
 * omp's models.yml editors — the provider entry form, the model entry form
 * and the thinking-level ladder — plus the coloured brand tiles Settings
 * draws providers with. Rendered inside the Providers hub's detail drawer
 * (components/settings/providers/ProviderDetail.tsx, the "Advanced" form
 * of a custom endpoint); the old tree-and-detail dialog that used to live
 * here is gone, its registry, roles and composer-picker views having moved
 * to the Providers and Models hubs.
 *
 * Curation, provider order and model roles moved to the Models hub
 * (components/settings/models/) and the Providers hub; nothing of the old
 * registry tree remains here.
 */
import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import {
  Field as FormField,
  FieldGroup,
  TextInput,
  NumInput,
  SecretInput,
  Select as FormSelect,
  Check as FormCheck,
  ConfirmDialog,
  useFieldValidation,
} from "@/components/ui/field";
import { Trash2, RefreshCw, AlertCircle, Cpu, Settings, Sparkles, Check as CheckIcon } from "lucide-react";
import { toast } from "@/components/ui/toast";
// Color icons (have their own fill colors — no background needed)
import AnthropicIcon from "@lobehub/icons/es/Anthropic/components/Mono";
import OpenAIIcon from "@lobehub/icons/es/OpenAI/components/Mono";
import GoogleColorIcon from "@lobehub/icons/es/Google/components/Color";
import DeepSeekColorIcon from "@lobehub/icons/es/DeepSeek/components/Color";
import GroqIcon from "@lobehub/icons/es/Groq/components/Mono";
import MistralColorIcon from "@lobehub/icons/es/Mistral/components/Color";
import MoonshotIcon from "@lobehub/icons/es/Moonshot/components/Mono";
import MinimaxColorIcon from "@lobehub/icons/es/Minimax/components/Color";
import FireworksColorIcon from "@lobehub/icons/es/Fireworks/components/Color";
import HuggingFaceColorIcon from "@lobehub/icons/es/HuggingFace/components/Color";
import CerebrasColorIcon from "@lobehub/icons/es/Cerebras/components/Color";
import OpenRouterIcon from "@lobehub/icons/es/OpenRouter/components/Mono";
import XAIIcon from "@lobehub/icons/es/XAI/components/Mono";
import CloudflareColorIcon from "@lobehub/icons/es/Cloudflare/components/Color";
import VercelIcon from "@lobehub/icons/es/Vercel/components/Mono";
import GithubCopilotIcon from "@lobehub/icons/es/GithubCopilot/components/Mono";
import AwsColorIcon from "@lobehub/icons/es/Aws/components/Color";
import AzureColorIcon from "@lobehub/icons/es/Azure/components/Color";
import KimiColorIcon from "@lobehub/icons/es/Kimi/components/Color";
import QwenColorIcon from "@lobehub/icons/es/Qwen/components/Color";
import ZhipuColorIcon from "@lobehub/icons/es/Zhipu/components/Color";
import CohereColorIcon from "@lobehub/icons/es/Cohere/components/Color";
import PerplexityColorIcon from "@lobehub/icons/es/Perplexity/components/Color";
import TogetherColorIcon from "@lobehub/icons/es/Together/components/Color";
import GrokIcon from "@lobehub/icons/es/Grok/components/Mono";
import AntGroupColorIcon from "@lobehub/icons/es/AntGroup/components/Color";
import NvidiaColorIcon from "@lobehub/icons/es/Nvidia/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import XiaomiMiMoIcon from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import ZAIIcon from "@lobehub/icons/es/ZAI/components/Mono";
type IconComponent = React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>;

// Settings draws provider brands in COLOUR, at tile size, from @lobehub/icons —
// a roomy list where the colour is the fastest way to find a provider, and this
// modal is dynamic()-imported so the icon set stays out of the main bundle.
//
// The composer's picker deliberately does NOT share this. It needs monochrome
// marks that inherit row tone at 12px, and it is always mounted, so it draws
// from the vendored set in components/ProviderIcon.tsx instead. Two briefs, two
// renderers — keep them that way; see AGENTS.md "Brand marks". What they SHOULD
// agree on is which ids exist: a provider added here usually wants an entry in
// lib/provider-brand.ts too.
// hasColor=true → Color icon (self-colored SVG, no wrapper)
// hasColor=false → Mono icon (rendered with currentColor, inherits theme text color)
const PROVIDER_ICONS: Record<string, { Icon: IconComponent; hasColor: boolean }> = {
  "anthropic":              { Icon: AnthropicIcon,        hasColor: false },
  "openai":                 { Icon: OpenAIIcon,           hasColor: false },
  "openai-codex":           { Icon: OpenAIIcon,           hasColor: false },
  "google":                 { Icon: GoogleColorIcon,      hasColor: true },
  "google-vertex":          { Icon: GoogleColorIcon,      hasColor: true },
  "ant-ling":               { Icon: AntGroupColorIcon,    hasColor: true },
  "deepseek":               { Icon: DeepSeekColorIcon,    hasColor: true },
  "groq":                   { Icon: GroqIcon,             hasColor: false },
  "mistral":                { Icon: MistralColorIcon,     hasColor: true },
  "moonshotai":             { Icon: MoonshotIcon,         hasColor: false },
  "moonshotai-cn":          { Icon: MoonshotIcon,         hasColor: false },
  "moonshot":               { Icon: MoonshotIcon,         hasColor: false },
  "minimax":                { Icon: MinimaxColorIcon,     hasColor: true },
  "minimax-cn":             { Icon: MinimaxColorIcon,     hasColor: true },
  "fireworks":              { Icon: FireworksColorIcon,   hasColor: true },
  "huggingface":            { Icon: HuggingFaceColorIcon, hasColor: true },
  "cerebras":               { Icon: CerebrasColorIcon,    hasColor: true },
  "openrouter":             { Icon: OpenRouterIcon,       hasColor: false },
  "xai":                    { Icon: XAIIcon,              hasColor: false },
  "cloudflare-ai-gateway":  { Icon: CloudflareColorIcon,  hasColor: true },
  "cloudflare-workers-ai":  { Icon: CloudflareColorIcon,  hasColor: true },
  "vercel-ai-gateway":      { Icon: VercelIcon,           hasColor: false },
  "github-copilot":         { Icon: GithubCopilotIcon,    hasColor: false },
  "amazon-bedrock":         { Icon: AwsColorIcon,         hasColor: true },
  "azure-openai-responses": { Icon: AzureColorIcon,       hasColor: true },
  "kimi-coding":            { Icon: KimiColorIcon,        hasColor: true },
  "nvidia":                 { Icon: NvidiaColorIcon,      hasColor: true },
  "opencode":               { Icon: OpenCodeIcon,         hasColor: false },
  "opencode-go":            { Icon: OpenCodeIcon,         hasColor: false },
  "qwen":                   { Icon: QwenColorIcon,        hasColor: true },
  "xiaomi":                 { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-ams":  { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-cn":   { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-sgp":  { Icon: XiaomiMiMoIcon,       hasColor: false },
  "zai":                    { Icon: ZAIIcon,              hasColor: false },
  "zai-coding-cn":          { Icon: ZAIIcon,              hasColor: false },
  "zhipu":                  { Icon: ZhipuColorIcon,       hasColor: true },
  "cohere":                 { Icon: CohereColorIcon,      hasColor: true },
  "perplexity":             { Icon: PerplexityColorIcon,  hasColor: true },
  "together":               { Icon: TogetherColorIcon,    hasColor: true },
  "grok":                   { Icon: GrokIcon,             hasColor: false },
};

// ── Types ─────────────────────────────────────────────────────────────────────

// Mirrors the ModelThinkingSchema subset of omp's models.yml
// (oh-my-pi/packages/coding-agent/src/config/models-config-schema.ts).
export interface ThinkingConfig {
  mode?: string;
  efforts?: string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
}

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinking?: ThinkingConfig;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  auth?: "apiKey" | "none" | "oauth";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

export interface ModelsFileData {
  providers?: Record<string, ProviderEntry>;
}

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

// omp's models.yml ApiSchema (config/models-config-schema.ts)
const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
] as const;

// ── Form field helpers ────────────────────────────────────────────────────────

/** Renders a translated string, displaying `backtick` segments in mono code font. */
function CodeText({ text }: { text: string }) {
  const parts = text.split("`");
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((seg, i) =>
        i % 2 === 1 ? <code key={i} style={{ fontFamily: "var(--font-mono)" }}>{seg}</code> : seg,
      )}
    </>
  );
}

// ── Provider detail ───────────────────────────────────────────────────────────

type EndpointPreset = {
  label: string;
  baseUrl: string;
  /** "none" forces no-auth; "apiKey" forces key-based auth; "keep" preserves the current auth mode. */
  auth: "none" | "apiKey" | "keep";
};

const ENDPOINT_PRESETS: EndpointPreset[] = [
  { label: "🦙 Ollama", baseUrl: "http://localhost:11434/v1", auth: "none" },
  { label: "⚡ LM Studio / vLLM", baseUrl: "http://localhost:1234/v1", auth: "none" },
  { label: "🌐 OpenRouter", baseUrl: "https://openrouter.ai/api/v1", auth: "apiKey" },
  { label: "🤖 Local Proxy (:2455)", baseUrl: "http://127.0.0.1:2455/v1", auth: "keep" },
];

const presetButtonStyle = {
  padding: "4px 8px",
  fontSize: 11,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
} as const;

/** One models.yml provider entry as a form. Removal is the caller's (the
 * Providers hub's danger zone names the provider and its model count). */
export function ProviderEntryEditor({ name, provider, onChange, onRename }: {
  name: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onRename: (n: string) => void;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  const renameValidate = () => {
    if (!editingName.trim()) return t("modelsConfig.errorNameRequired");
    return null;
  };
  const renameV = useFieldValidation(renameValidate);

  const baseUrlValidate = () => {
    const v = provider.baseUrl ?? "";
    if (!v.trim()) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") return t("modelsConfig.errorUrlInvalid");
      return null;
    } catch {
      return t("modelsConfig.errorUrlInvalid");
    }
  };
  const baseUrlV = useFieldValidation(baseUrlValidate);

  const apiKeyValidate = () => {
    if (provider.auth === "none") return null;
    if (!provider.apiKey || !provider.apiKey.trim()) return t("modelsConfig.errorApiKeyRequired");
    return null;
  };
  const apiKeyV = useFieldValidation(apiKeyValidate);

  const trimmedRename = editingName.trim();
  const hostName = provider.baseUrl ? (provider.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || provider.baseUrl) : "Default endpoint";

  const applyPreset = (preset: EndpointPreset) => {
    onChange({
      ...provider,
      baseUrl: preset.baseUrl,
      api: "openai-completions",
      auth: preset.auth === "keep" ? provider.auth : preset.auth,
    });
    toast.success(`Applied ${preset.baseUrl} endpoint preset`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Hero Provider Header Card */}
      <div style={{ padding: "14px 16px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10, boxShadow: "var(--shadow-card)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <ProviderBrandTile id={name} size={20} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{name}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{hostName}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {provider.auth === "none" ? (
              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-muted)", fontWeight: 500 }}>
                Auth: None
              </span>
            ) : provider.apiKey ? (
              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)", fontWeight: 600 }}>
                Key Set
              </span>
            ) : (
              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "color-mix(in srgb, var(--status-error) 15%, transparent)", color: "var(--status-error)", fontWeight: 600 }}>
                Key Missing
              </span>
            )}
          </div>
        </div>

        {/* Quick Endpoint Presets */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
            Quick Endpoint Presets
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {ENDPOINT_PRESETS.map((preset) => (
              <button
                key={preset.baseUrl}
                type="button"
                onClick={() => applyPreset(preset)}
                style={presetButtonStyle}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <FieldGroup
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Settings size={12} aria-hidden="true" /> Configuration Details
          </span>
        }
      >
        <FormField label={t("modelsConfig.providerName")} required error={renameV.error}>
          <TextInput
            value={editingName}
            onChange={(v) => { setEditingName(v); renameV.onChange(); }}
            placeholder="provider-name"
            mono
            invalid={Boolean(renameV.error)}
            error={renameV.error}
            onBlurValidate={renameV.onBlur}
          />
        </FormField>
        {trimmedRename !== name && (
          <button
            type="button"
            onClick={() => {
              const err = renameV.onSubmit();
              if (!err) onRename(trimmedRename);
            }}
            style={{
              alignSelf: "flex-start",
              padding: "5px 12px",
              background: "var(--accent)",
              border: "none",
              borderRadius: "var(--radius-control)",
              color: "var(--on-accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {t("modelsConfig.rename")}
          </button>
        )}

        <FormField label={t("modelsConfig.baseUrl")} error={baseUrlV.error}>
          <TextInput
            value={provider.baseUrl ?? ""}
            onChange={(v) => { set("baseUrl", v || undefined); baseUrlV.onChange(); }}
            placeholder="https://api.example.com/v1"
            mono
            invalid={Boolean(baseUrlV.error)}
            error={baseUrlV.error}
            onBlurValidate={baseUrlV.onBlur}
          />
        </FormField>

        <FormField
          label={t("modelsConfig.apiKey")}
          hint={<CodeText text={t("modelsConfig.apiKeyHint")} />}
          error={apiKeyV.error}
        >
          <SecretInput
            value={provider.apiKey ?? ""}
            onChange={(v) => { set("apiKey", v || undefined); apiKeyV.onChange(); }}
            placeholder={t("modelsConfig.apiKeyPlaceholder")}
            invalid={Boolean(apiKeyV.error)}
            error={apiKeyV.error}
            onBlurValidate={apiKeyV.onBlur}
            showLabel={t("modelsConfig.showApiKey")}
            hideLabel={t("modelsConfig.hideApiKey")}
          />
        </FormField>

        <FormCheck
          label={t("modelsConfig.noApiKeyRequired")}
          checked={provider.auth === "none"}
          onChange={(v) => {
            set("auth", v ? "none" : undefined);
            if (v) apiKeyV.onChange();
            apiKeyV.onBlur();
          }}
        />

        <FormField label={t("modelsConfig.api")}>
          <FormSelect
            value={provider.api ?? "openai-completions"}
            onChange={(v) => set("api", v)}
            options={API_OPTIONS}
            required
            placeholder={t("modelsConfig.inheritNone")}
          />
        </FormField>
      </FieldGroup>

    </div>
  );
}

// ── Thinking levels editor ────────────────────────────────────────────────────
// Edits omp's `thinking` config: `efforts` lists the enabled levels, and
// `effortMap` overrides the string sent on the wire for a level. When every
// row is Default the config is omitted and omp derives the ladder itself.

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  minimal: "var(--text-dim)",
  low:     "color-mix(in srgb, var(--accent) 45%, var(--text-muted))",
  medium:  "var(--accent)",
  high:    "var(--accent-hover)",
  xhigh:   "var(--status-warning)",
  max:     "var(--status-error)",
};

function ThinkingEditor({
  value,
  onChange,
}: {
  value: ThinkingConfig | undefined;
  onChange: (v: ThinkingConfig | undefined) => void;
}) {
  const { t } = useI18n();
  const efforts = value?.efforts;
  const effortMap = value?.effortMap ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    // entry: "omit" → enabled with the default wire value; null → level
    // disabled (excluded from efforts); string → enabled with a custom value.
    const included = new Set<string>(efforts ?? [...THINKING_LEVELS]);
    const map: Record<string, string> = { ...effortMap };
    if (entry === null) {
      included.delete(level);
      delete map[level];
    } else {
      included.add(level);
      if (entry === "omit") delete map[level];
      else map[level] = entry;
    }
    const ordered = THINKING_LEVELS.filter((l) => included.has(l));
    if (ordered.length === 0 || (ordered.length === THINKING_LEVELS.length && Object.keys(map).length === 0)) {
      onChange(undefined);
      return;
    }
    onChange({
      ...(value ?? {}),
      mode: value?.mode ?? "effort",
      efforts: ordered,
      effortMap: Object.keys(map).length ? map : undefined,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const disabled = efforts !== undefined && !efforts.includes(level);
        const raw = disabled ? null : effortMap[level];
        const state: "omit" | "null" | "string" =
          disabled ? "null" : typeof raw === "string" ? "string" : "omit";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          padding: "4px 10px",
          fontSize: 10,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "var(--on-accent)",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "var(--status-error)",
          color: "var(--on-accent)",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            {/* Level badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, opacity: state === "null" ? 0.3 : 1 }} />
              <span style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                textDecoration: state === "null" ? "line-through" : "none",
              }}>
                {level}
              </span>
            </div>

            {/* Default + Disabled buttons */}
            <div style={{ display: "flex", borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                {t("modelsConfig.default")}
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{ ...btnBase, borderLeft: "1px solid var(--border)", ...(state === "null" ? btnActiveDisabled : {}) }}
              >
                {t("modelsConfig.disabled")}
              </button>
            </div>

            {/* Custom button + input fused */}
            <div style={{ display: "flex", borderRadius: 5, border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`, overflow: "hidden", transition: "border-color var(--dur-fast) var(--ease-out-warm)" }}>
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{ ...btnBase, ...(state === "string" ? btnActive : {}), borderRight: "1px solid var(--border)", flexShrink: 0 }}
              >
                {t("modelsConfig.custom")}
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────

const COST_LABEL_KEYS = {
  input: "modelsConfig.costInput",
  output: "modelsConfig.costOutput",
  cacheRead: "modelsConfig.costCacheRead",
  cacheWrite: "modelsConfig.costCacheWrite",
} as const;

/** One models.yml model entry as a form, with the configuration probe and Remove. */
export function ModelEntryEditor({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const [removeOpen, setRemoveOpen] = useState(false);
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) => model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof NonNullable<ModelEntry["cost"]>, v: string) => {
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const idValidate = () => (!model.id.trim() ? t("modelsConfig.errorIdRequired") : null);
  const idV = useFieldValidation(idValidate);
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return t("modelsConfig.validatingConfig");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [t("modelsConfig.ok"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    return [t("modelsConfig.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        code?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error || d.code ? formatApiError(d) : `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <FieldGroup
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Cpu size={11} aria-hidden="true" /> {t("modelsConfig.model")}
          </span>
        }
      >
        <div className="model-detail-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label={t("modelsConfig.idRequired")} required error={idV.error}>
            <TextInput
              value={model.id}
              onChange={(v) => { set("id", v); idV.onChange(); }}
              placeholder="model-id"
              mono
              invalid={Boolean(idV.error)}
              error={idV.error}
              onBlurValidate={idV.onBlur}
            />
          </FormField>
          <FormField label={t("modelsConfig.name")}>
            <TextInput
              value={model.name ?? ""}
              onChange={(v) => set("name", v || undefined)}
              placeholder={t("modelsConfig.displayNamePlaceholder")}
            />
          </FormField>
        </div>

        <FormField label={t("modelsConfig.apiOverride")}>
          <FormSelect
            value={model.api ?? ""}
            onChange={(v) => set("api", v || undefined)}
            options={API_OPTIONS}
            placeholder={t("modelsConfig.inheritNone")}
          />
        </FormField>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <FormCheck
            label={t("modelsConfig.reasoningThinking")}
            checked={model.reasoning ?? false}
            onChange={(v) => set("reasoning", v || undefined)}
          />
          <FormCheck
            label={t("modelsConfig.imageInput")}
            checked={model.input?.includes("image") ?? false}
            onChange={(v) => set("input", v ? ["text", "image"] : undefined)}
          />
        </div>
      </FieldGroup>

      {model.reasoning && (
        <FieldGroup
          label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Sparkles size={11} aria-hidden="true" /> {t("modelsConfig.thinkingLevels")}
            </span>
          }
        >
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            {model.thinking && (
              <button
                type="button"
                onClick={() => set("thinking", undefined)}
                style={{
                  fontSize: 10,
                  padding: "3px 9px",
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <RefreshCw size={10} aria-hidden="true" /> {t("modelsConfig.resetToAuto")}
              </button>
            )}
          </div>
          <ThinkingEditor
            value={model.thinking}
            onChange={(v) => set("thinking", v)}
          />
        </FieldGroup>
      )}

      <FieldGroup label={t("modelsConfig.tokenLimits")}>
        <div className="model-detail-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label={t("modelsConfig.contextWindowTokens")}>
            <NumInput
              value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
              onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)}
              placeholder="128000"
            />
          </FormField>
          <FormField label={t("modelsConfig.maxOutputTokens")}>
            <NumInput
              value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
              onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)}
              placeholder="16384"
            />
          </FormField>
        </div>
      </FieldGroup>

      <FieldGroup label={t("modelsConfig.costPerMillion")}>
        <div className="model-detail-grid-4" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <FormField key={k} label={t(COST_LABEL_KEYS[k])}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </FormField>
          ))}
        </div>
      </FieldGroup>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        {testSummary && (
          <span
            title={testSummary}
            style={{
              maxWidth: 360,
              padding: "4px 10px",
              border: `1px solid ${
                testState.phase === "error"
                  ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                  : testState.phase === "success"
                    ? "color-mix(in srgb, var(--accent) 25%, transparent)"
                    : "var(--border)"
              }`,
              borderRadius: "var(--radius-control)",
              background:
                testState.phase === "error"
                  ? "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))"
                  : testState.phase === "success"
                    ? "color-mix(in srgb, var(--accent) 8%, var(--bg-panel))"
                    : "var(--bg-panel)",
              color:
                testState.phase === "error" || testState.phase === "success"
                  ? "var(--text)"
                  : "var(--text-muted)",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {testState.phase === "success" ? <CheckIcon size={11} aria-hidden="true" /> : null}
            {testState.phase === "error" ? <AlertCircle size={11} aria-hidden="true" /> : null}
            {testSummary}
          </span>
        )}
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          <button
            type="button"
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("modelsConfig.testTitle")}
            style={{
              padding: "5px 12px",
              background: testState.phase === "success" ? "color-mix(in srgb, var(--accent) 18%, var(--bg-panel))" : "none",
              border: `1px solid ${
                testState.phase === "success"
                  ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                  : "var(--border)"
              }`,
              borderRadius: "var(--radius-control)",
              color:
                testState.phase === "success"
                  ? "var(--accent)"
                  : !model.id.trim() || testState.phase === "testing"
                    ? "var(--text-dim)"
                    : "var(--text-muted)",
              cursor: !model.id.trim() || testState.phase === "testing" ? "not-allowed" : "pointer",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
          >
            {testState.phase === "success" && <CheckIcon size={11} aria-hidden="true" />}
            {testState.phase === "testing"
              ? t("modelsConfig.testing")
              : testState.phase === "success"
                ? t("modelsConfig.ok")
                : t("modelsConfig.test")}
          </button>
          <button
            type="button"
            onClick={() => setRemoveOpen(true)}
            style={{
              padding: "5px 12px",
              background: "none",
              border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
              borderRadius: "var(--radius-control)",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Trash2 size={11} aria-hidden="true" /> {t("modelsConfig.remove")}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("modelsConfig.removeModelTitle", { id: model.id })}
        description={t("modelsConfig.removeModelBody", { id: model.id })}
        confirmLabel={t("modelsConfig.remove")}
        cancelLabel={t("modelsConfig.cancel")}
        danger
        onConfirm={() => {
          setRemoveOpen(false);
          onDelete();
        }}
      />
    </div>
  );
}

// ── Provider brand tile ─────────────────────────────────────────────────────────────

export function ProviderBrandTile({ id, size }: { id: string; size: number }) {
  const pi = PROVIDER_ICONS[id];
  if (!pi) {
    const label = id
      .split(/[-_]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?";
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text-dim)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: Math.max(8, Math.floor(size * 0.42)),
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {label}
      </span>
    );
  }
  // Color icons: self-colored SVG, no wrapper needed
  if (pi.hasColor) return <pi.Icon size={size} />;
  // Mono icons: use currentColor so they adapt to light/dark theme
  return <pi.Icon size={size} style={{ color: "var(--text-muted)" }} />;
}
