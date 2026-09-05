"use client";

import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { translate, useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { toast } from "@/components/ui/toast";
import { RefreshCw, Store } from "lucide-react";
import { Drawer } from "./settings/Drawer";
import { smallButtonStyle } from "./settings/account-controls";
import { SkillsStore } from "./SkillsStore";
import type {
  SkillInfo as Skill,
  SkillInstallScope,
  SkillUpdateResult,
} from "@/lib/api-types";

function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sourceLabel(skill: Skill): string {
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

const SOURCE_LABEL_KEYS: Record<string, string> = {
  global: "skillsConfig.scopeGlobal",
  project: "skillsConfig.scopeProject",
  path: "skillsConfig.scopePath",
};

function updateKey(skill: Skill): string | null {
  return skill.install
    ? `${skill.install.scope}\0${skill.install.package}`
    : null;
}

function shortVersion(version?: string): string {
  return version ? version.slice(0, 8) : translate("skillsConfig.unknownVersion");
}

function Toggle({
  enabled,
  loading,
  readOnly,
  onToggle,
}: {
  enabled: boolean;
  loading: boolean;
  /** The active engine keeps this state somewhere Cody cannot write. Show
   * what is in effect, refuse to pretend it can be changed here. */
  readOnly: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading || readOnly}
      aria-pressed={enabled}
      title={
        readOnly
          ? t("skillsConfig.toggleUnavailable")
          : enabled
            ? t("skillsConfig.visibleInPrompt")
            : t("skillsConfig.hiddenFromPrompt")
      }
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: readOnly ? "not-allowed" : loading ? "wait" : "pointer",
        opacity: readOnly ? 0.55 : 1,
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background var(--dur-med) var(--ease-out-warm)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "var(--shadow-card)",
          transform: enabled ? "translateX(18px)" : "translateX(0)",
          transition: "transform var(--dur-med) var(--ease-out-warm)",
        }}
      />
    </button>
  );
}

function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  canToggle,
  saveError,
  updateStatus,
  checkingUpdate,
  updating,
  updateError,
  onCheckUpdate,
  onUpdate,
}: {
  skill: Skill;
  cwd: string;
  onToggle: (skill: Skill) => void;
  toggling: boolean;
  canToggle: boolean;
  saveError: string | null;
  updateStatus?: SkillUpdateResult;
  checkingUpdate: boolean;
  updating: boolean;
  updateError: string | null;
  onCheckUpdate: () => void;
  onUpdate: () => void;
}) {
  const { t } = useI18n();
  const label = sourceLabel(skill);
  const enabled = !skill.disableModelInvocation;

  function displayPath(p: string): string {
    if (label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Path + tag + toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            flexShrink: 0,
            background:
              label === "project"
                ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                : "color-mix(in srgb, var(--text-dim) 12%, transparent)",
            color:
              label === "project" ? "var(--accent)" : "var(--text-dim)",
          }}
        >
          {t(SOURCE_LABEL_KEYS[label])}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayPath(skill.filePath)}
        </span>
        <Toggle
          enabled={enabled}
          loading={toggling}
          readOnly={!canToggle}
          onToggle={() => onToggle(skill)}
        />
        {saveError && (
          <span style={{ fontSize: 12, color: "var(--status-error)", flexShrink: 0 }}>
            {saveError}
          </span>
        )}
      </div>

      {!canToggle && (
        <span style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5, marginTop: -12 }}>
          {t("skillsConfig.toggleUnavailable")}
        </span>
      )}

      {skill.install?.skillsShUrl && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span
            style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
          >
            {t("skillsConfig.source")}
          </span>
          <a
            href={skill.install.skillsShUrl}
            target="_blank"
            rel="noreferrer"
            title={skill.install.skillsShUrl}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "fit-content",
              maxWidth: "100%",
              color: "var(--accent)",
              textDecoration: "none",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {skill.install.skillsShUrl.replace(/^https?:\/\//, "")} ↗
            </span>
          </a>
        </div>
      )}

      {skill.install && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <span
            style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
          >
            {t("skillsConfig.version")}
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              {shortVersion(updateStatus?.currentVersion ?? skill.install.versionHash)}
            </span>
            {skill.install.canCheckForUpdates && (
              <button
                onClick={onCheckUpdate}
                disabled={checkingUpdate || updating}
                style={{
                  padding: "4px 9px",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  background: "none",
                  color: "var(--text-muted)",
                  cursor: checkingUpdate || updating ? "not-allowed" : "pointer",
                  opacity: checkingUpdate || updating ? 0.5 : 1,
                  fontSize: 11,
                }}
              >
                {t("skillsConfig.check")}
              </button>
            )}
            {updateStatus?.state === "update-available" && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--status-warning)",
                }}
              >
                {shortVersion(updateStatus.latestVersion)}
              </span>
            )}
            {(checkingUpdate ||
              (updateStatus && updateStatus.state !== "update-available")) && (
              <span
                style={{
                  fontSize: 12,
                  color: checkingUpdate
                    ? "var(--accent)"
                    : updateStatus?.state === "up-to-date"
                      ? "var(--status-success)"
                      : updateStatus?.state === "error"
                          ? "var(--status-error)"
                          : "var(--text-dim)",
                }}
              >
                {checkingUpdate
                  ? t("skillsConfig.checking")
                  : updateStatus?.state === "up-to-date"
                    ? t("skillsConfig.upToDate")
                    : updateStatus?.state === "unsupported"
                        ? t("skillsConfig.checksUnavailable")
                        : updateStatus?.message || t("skillsConfig.checkFailed")}
              </span>
            )}
            {updateStatus?.state === "update-available" && (
              <button
                onClick={onUpdate}
                disabled={updating || checkingUpdate}
                style={{
                  padding: "4px 10px",
                  border: "none",
                  borderRadius: 5,
                  background: "var(--accent)",
                  color: "var(--on-accent)",
                  cursor: updating || checkingUpdate ? "not-allowed" : "pointer",
                  opacity: updating || checkingUpdate ? 0.5 : 1,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {updating ? t("skillsConfig.updating") : t("skillsConfig.update")}
              </button>
            )}
          </div>
          {updateError && (
            <span style={{ fontSize: 12, color: "var(--status-error)" }}>{updateError}</span>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
        >
          {t("skillsConfig.name")}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            color: "var(--text)",
          }}
        >
          {skill.name}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
        >
          {t("skillsConfig.description")}
        </span>
        <span
          style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6 }}
        >
          {skill.description}
        </span>
      </div>
    </div>
  );
}

/**
 * Settings › Extensions › Skills: the workspace's skills, embedded under the
 * Extensions segments. The header carries the update count, "Check
 * updates" and the Skill store (which opens in a Drawer, never a second
 * Dialog); the list and the detail pane sit below. Nothing here closes the
 * settings dialog.
 */
export function SkillsConfig({ cwd }: { cwd: string }) {
  const isMobile = useIsMobile();
  const { t, tn } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  // What this engine's skills surface can actually do, reported by the scan
  // (GET /api/skills). Defaults match omp, so a server that does not answer
  // keeps the full surface rather than disabling controls that work.
  const [installScopes, setInstallScopes] = useState<SkillInstallScope[]>(["global", "project"]);
  const [canToggle, setCanToggle] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [storeOpen, setStoreOpen] = useState(false);
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, SkillUpdateResult>>({});
  const [checkingUpdates, setCheckingUpdates] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
      const d = (await res.json()) as {
        skills?: Skill[];
        installScopes?: SkillInstallScope[];
        canToggle?: boolean;
        error?: string;
        code?: string;
      };
      if (!res.ok || d.error) throw new Error(formatApiError(d.error ? d : `HTTP ${res.status}`));
      const list = d.skills ?? [];
      setSkills(list);
      if (d.installScopes?.length) setInstallScopes(d.installScopes);
      if (typeof d.canToggle === "boolean") setCanToggle(d.canToggle);
      if (list.length > 0 && !selected) setSelected(list[0].filePath);
      return list;
    } catch (e) {
      setError(String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, [cwd, selected]);

  useEffect(() => {
    setUpdateStatuses({});
    setUpdateError(null);
    void loadSkills();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkForUpdates = useCallback(async (skill?: Skill) => {
    const targets = skill
      ? [skill]
      : skills.filter((item) => Boolean(item.install));
    const keys = targets
      .map(updateKey)
      .filter((key): key is string => Boolean(key));
    if (keys.length === 0) return;

    setUpdateError(null);
    setCheckingUpdates((current) => new Set([...current, ...keys]));
    if (!skill) setCheckingAll(true);
    try {
      const res = await fetch("/api/skills/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill?.install?.package,
          scope: skill?.install?.scope,
        }),
      });
      const data = (await res.json()) as {
        updates?: SkillUpdateResult[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUpdateStatuses((current) => {
        const next = { ...current };
        for (const update of data.updates ?? []) {
          next[`${update.scope}\0${update.package}`] = update;
        }
        return next;
      });
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdates((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!skill) setCheckingAll(false);
    }
  }, [cwd, skills]);

  const updateInstalledSkill = useCallback(async (skill: Skill) => {
    if (!skill.install) return;
    const key = updateKey(skill)!;
    setUpdatingSkill(key);
    setUpdateError(null);
    try {
      const res = await fetch("/api/skills/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill.install.package,
          scope: skill.install.scope,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        skill?: Skill;
        error?: string;
      };
      if (!res.ok || data.error || !data.success) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadSkills();
      const versionHash = data.skill?.install?.versionHash;
      setUpdateStatuses((current) => ({
        ...current,
        [key]: {
          package: skill.install!.package,
          scope: skill.install!.scope,
          state: "up-to-date",
          currentVersion: versionHash,
          latestVersion: versionHash,
        },
      }));
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdatingSkill(null);
    }
  }, [cwd, loadSkills]);

  // The undo action inside a toast runs after this render: it reads the
  // latest toggle through a ref instead of closing over a stale one.
  const toggleRef = useRef<(skill: Skill) => Promise<void>>(async () => {});
  const toggle = useCallback(async (skill: Skill) => {
    const next = !skill.disableModelInvocation;
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: skill.filePath,
          disableModelInvocation: next,
        }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        const msg = d.error ?? `HTTP ${res.status}`;
        setSaveError(msg);
        toast.error(t("skillsConfig.toggleErrorTitle"), msg);
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.filePath === skill.filePath
            ? { ...s, disableModelInvocation: next }
            : s,
        ),
      );
      // Disabling is reversible, so the toast carries the undo: the same
      // skill flips back through the same PATCH.
      toast.success(
        t("skillsConfig.toggleSuccessTitle"),
        undefined,
        next
          ? { durationMs: 8000, action: { label: t("skillsConfig.undoDisable"), onClick: () => { void toggleRef.current({ ...skill, disableModelInvocation: true }); } } }
          : undefined,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      toast.error(t("skillsConfig.toggleErrorTitle"), msg);
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, [t]);

  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null;
  toggleRef.current = toggle;
  // Stable: the Drawer registers a phone level in an effect keyed on its
  // onClose, so an inline arrow here would re-register on every render.
  const closeStore = useCallback(() => setStoreOpen(false), []);
  const availableCount = Object.values(updateStatuses).filter((status) => status.state === "update-available").length;
  const canCheckAny = skills.some((skill) => skill.install?.canCheckForUpdates);
  const installedPackages = {
    global: new Set(skills.filter((skill) => skill.install?.scope === "global").map((skill) => skill.install!.package)),
    project: new Set(skills.filter((skill) => skill.install?.scope === "project").map((skill) => skill.install!.package)),
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {/* Header: workspace, update count, Check, Skill store */}
        <div
          data-search-id="skills"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "10px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <code
            title={cwd}
            style={{
              flex: "1 1 160px",
              minWidth: 0,
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {shortenPath(cwd)}
          </code>
          {availableCount > 0 && (
            <span style={{ fontSize: 12, color: "var(--status-warning)", whiteSpace: "nowrap" }}>
              {tn("skillsConfig.updateCount", availableCount)}
            </span>
          )}
          {/* Only when a check would do something: an engine whose installs
              carry no comparable version (Hermes tracks its own hashes and
              checks them with `hermes skills check`) gets no dead button. */}
          {canCheckAny && (
            <button
              type="button"
              onClick={() => void checkForUpdates()}
              disabled={checkingAll || updatingSkill !== null}
              style={{ ...smallButtonStyle, opacity: checkingAll || updatingSkill !== null ? 0.5 : 1, cursor: checkingAll || updatingSkill !== null ? "not-allowed" : "pointer" }}
            >
              <RefreshCw size={13} aria-hidden="true" />
              {checkingAll ? t("skillsConfig.checking") : t("skillsConfig.checkUpdates")}
            </button>
          )}
          <button type="button" data-search-id="skill-store" onClick={() => setStoreOpen(true)} style={smallButtonStyle}>
            <Store size={13} aria-hidden="true" />
            {t("skillsConfig.store.open")}
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left: skill list */}
          <div
            style={{
              width: isMobile ? "100%" : 210,
              maxHeight: isMobile ? "40vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  {t("skillsConfig.loading")}
                </div>
              ) : error ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--status-error)",
                  }}
                >
                  {error}
                </div>
              ) : skills.length === 0 ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  {t("skillsConfig.noSkillsFound")}
                </div>
              ) : (
                (() => {
                  const groups: { label: string; skills: typeof skills }[] = [];
                  // label values are i18n keys, resolved with t() at render.
                  const groupDefinitions = [
                    {
                      label: "skillsConfig.groupProjectSkillsSh",
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "project" &&
                        Boolean(skill.install?.skillsShUrl),
                    },
                    {
                      label: "skillsConfig.scopeProject",
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "project" &&
                        !skill.install?.skillsShUrl,
                    },
                    {
                      label: "skillsConfig.groupGlobalSkillsSh",
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "global" &&
                        Boolean(skill.install?.skillsShUrl),
                    },
                    {
                      label: "skillsConfig.scopeGlobal",
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "global" &&
                        !skill.install?.skillsShUrl,
                    },
                    {
                      label: "skillsConfig.scopePath",
                      matches: (skill: Skill) => sourceLabel(skill) === "path",
                    },
                  ];
                  for (const { label, matches } of groupDefinitions) {
                    const grpSkills = skills.filter(matches);
                    if (grpSkills.length > 0)
                      groups.push({ label, skills: grpSkills });
                  }
                  return groups.map(
                    ({ label: grpLabel, skills: grpSkills }) => (
                      <div key={grpLabel} style={{ marginBottom: 6 }}>
                        <div
                          style={{
                            padding: "4px 8px 3px",
                            fontSize: 10,
                            fontWeight: 600,
                            color: "var(--text-dim)",
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                          }}
                        >
                          {t(grpLabel)}
                        </div>
                        {[...grpSkills.filter((skill) => !skill.disableModelInvocation), ...grpSkills.filter((skill) => skill.disableModelInvocation)].map((skill, index, orderedSkills) => {
                          const isSelected = selected === skill.filePath;
                          const disabled = skill.disableModelInvocation;
                          const firstDormant = disabled && (index === 0 || !orderedSkills[index - 1].disableModelInvocation);
                          const dormantCount = firstDormant ? orderedSkills.filter((candidate) => candidate.disableModelInvocation).length : 0;
                          return (
                            <Fragment key={skill.filePath}>
                            {firstDormant && (
                              <div style={{ marginTop: 6, padding: "6px 8px 3px", borderTop: "1px solid var(--border)", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                                {t("skillsConfig.dormant", { count: dormantCount })}
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => setSelected(skill.filePath)}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                padding: "8px 8px",
                                borderRadius: 5,
                                cursor: "pointer",
                                width: "100%",
                                border: "none",
                                textAlign: "left",
                                fontFamily: "inherit",
                                background: isSelected
                                  ? "var(--bg-selected)"
                                  : "none",
                              }}
                              onMouseEnter={(e) => {
                                if (!isSelected)
                                  e.currentTarget.style.background =
                                    "var(--bg-hover)";
                              }}
                              onMouseLeave={(e) => {
                                if (!isSelected)
                                  e.currentTarget.style.background = "none";
                              }}
                            >
                              <span
                                style={{
                                  flexShrink: 0,
                                  width: 7,
                                  height: 7,
                                  borderRadius: "50%",
                                  background: disabled
                                    ? "var(--border)"
                                    : "var(--accent)",
                                  boxShadow: disabled
                                    ? "none"
                                    : "0 0 4px var(--accent)",
                                  transition:
                                    "background var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
                                }}
                              />
                              <span
                                style={{
                                  fontSize: 12,
                                  fontWeight: isSelected ? 600 : 400,
                                  color: disabled
                                    ? "var(--text-dim)"
                                    : "var(--text)",
                                  fontFamily: "var(--font-mono)",
                                  flex: 1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {skill.name}
                              </span>
                              {(() => {
                                const key = updateKey(skill);
                                const status = key ? updateStatuses[key] : undefined;
                                if (status?.state !== "update-available") return null;
                                return (
                                  <span
                                    title={t("skillsConfig.updateAvailable")}
                                    style={{
                                      color: "var(--status-warning)",
                                      fontSize: 13,
                                      lineHeight: 1,
                                      flexShrink: 0,
                                    }}
                                  >
                                    ↑
                                  </span>
                                );
                              })()}
                            </button>
                            </Fragment>
                          );
                        })}
                      </div>
                    ),
                  );
                })()
              )}
            </div>
          </div>

          {/* Right: skill detail */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="skeleton" style={{ height: 18, width: "40%" }} />
                <div className="skeleton" style={{ height: 12, width: "70%" }} />
                <div className="skeleton" style={{ height: 12, width: "55%" }} />
                <div className="skeleton" style={{ height: 90, width: "100%" }} />
              </div>
            ) : selectedSkill ? (
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                onToggle={toggle}
                toggling={toggling.has(selectedSkill.filePath)}
                canToggle={canToggle}
                saveError={saveError}
                updateStatus={
                  updateKey(selectedSkill)
                    ? updateStatuses[updateKey(selectedSkill)!]
                    : undefined
                }
                checkingUpdate={
                  updateKey(selectedSkill)
                    ? checkingUpdates.has(updateKey(selectedSkill)!)
                    : false
                }
                updating={updatingSkill === updateKey(selectedSkill)}
                updateError={updateError}
                onCheckUpdate={() => void checkForUpdates(selectedSkill)}
                onUpdate={() => void updateInstalledSkill(selectedSkill)}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                {t("skillsConfig.selectSkill")}
              </div>
            )}
          </div>
        </div>

        {/* The store: a Drawer (side panel on desktop, pushed level on a
            phone), never a second Dialog over the settings dialog. */}
        <Drawer open={storeOpen} title={t("skillsConfig.store.title")} presentation="side" width={760} onClose={closeStore}>
          {storeOpen && (
            <SkillsStore
              embedded
              cwd={cwd}
              scopes={installScopes}
              installedPackages={installedPackages}
              onInstalled={() => {
                void loadSkills();
              }}
              onClose={closeStore}
            />
          )}
        </Drawer>
    </div>
  );
}
