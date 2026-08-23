"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Brain, Check, Copy, Loader2, RefreshCw, Sprout } from "lucide-react";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { MarkdownBody } from "@/components/MarkdownBody";
import { chipStyle } from "@/components/settings/primitives";

/**
 * The active engine's persistent memory (Settings → Memory), read-only.
 *
 * Deliberately read-only: memory is the agent's own account of what it
 * learned, and editing it through Cody would rewrite the engine's notes
 * behind its back. Each document carries its path for exactly that reason —
 * the user who wants to change one opens the file themselves, so the path is
 * surfaced in mono and selectable next to a copy button.
 *
 * Gated on `capabilities.memory` at the tab level (components/SettingsTabs.tsx
 * and the panel gate in SettingsConfig.tsx), so an engine that keeps memory it
 * cannot hand back — omp — never shows this tab at all. GET /api/memory's 400
 * `unsupported` is only the backstop for an engine switch under an open
 * dialog, and it is rendered as a sentence rather than an error.
 */

/**
 * Structural copy of `MemoryDocument` in lib/harness/types.ts — same reasoning
 * as EngineCapabilities in SettingsTabs.tsx: no client component should have
 * to import server code just for a shape.
 */
interface MemoryDocument {
  id: string;
  label: string;
  description: string;
  path: string;
  content: string;
  exists: boolean;
}

/** Why the read failed: a code the panel has its own wording for, or whatever
 * the server said. */
type Failure = { kind: "unsupported" } | { kind: "message"; text: string };

interface MemoryResponse {
  harness?: { id?: string; shortName?: string };
  documents?: MemoryDocument[];
}

/** Past this, formatting the document costs more than it is worth and the raw
 * text is shown instead — the same ceiling MessageView applies to a very long
 * message. The route already truncates at 256 KB, so this only bites on a
 * memory that grew most of the way there. */
const MAX_MARKDOWN_CHARS = 100_000;

function DocumentCard({ doc, engine }: { doc: MemoryDocument; engine: string }) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback();
  // A file that exists but holds only whitespace reads the same as a missing
  // one: the agent has not written anything worth showing yet.
  const body = doc.content.trim();
  const written = doc.exists && body.length > 0;

  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "14px 16px",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h4 style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{doc.label}</h4>
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, color: "var(--text-muted)" }}>{doc.description}</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", flexShrink: 0 }}>{t("memoryPanel.fileLabel")}</span>
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
            // Selectable on purpose: this path is how the user edits the file.
            userSelect: "text",
            wordBreak: "break-all",
            minWidth: 0,
          }}
        >
          {doc.path}
        </code>
        <button
          type="button"
          onClick={() => copy(doc.path)}
          aria-label={t("memoryPanel.copyPath")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 7px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            background: "var(--bg-subtle)",
            color: "var(--text)",
            cursor: "pointer",
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
          {copied ? t("memoryPanel.copied") : t("memoryPanel.copyPath")}
        </button>
      </div>

      {written ? (
        // Flows at full height rather than scrolling inside its own box: the
        // settings dialog is already one scroll column, and a clipped card
        // with no visible scrollbar reads as a rendering bug, not as "there
        // is more below". The route's 256 KB cap bounds the worst case.
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, fontSize: 12.5, minWidth: 0 }}>
          {body.length <= MAX_MARKDOWN_CHARS ? (
            <MarkdownBody>{body}</MarkdownBody>
          ) : (
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                lineHeight: 1.5,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {body}
            </pre>
          )}
        </div>
      ) : (
        // The FIRST thing most users see: a fresh install has written nothing
        // yet. It must read as the normal beginning of a memory, not as an
        // error or a blank panel.
        <div
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: 12,
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
          }}
        >
          <Sprout size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1, color: "var(--accent)" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("memoryPanel.emptyTitle")}</span>
            <span style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>{t("memoryPanel.emptyBody", { engine })}</span>
          </div>
        </div>
      )}
    </section>
  );
}

export function MemoryPanel({ engineName = null }: { engineName?: string | null }) {
  const { t } = useI18n();
  const [documents, setDocuments] = useState<MemoryDocument[]>([]);
  const [harnessName, setHarnessName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Structured rather than a finished sentence, so the message re-renders in
  // the new language when the locale switches under an open dialog — and so
  // `load` never has to depend on the translator.
  const [failure, setFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const response = await fetch("/api/memory", { cache: "no-store" });
      const data = (await response.json()) as MemoryResponse & { error?: string; code?: string };
      if (!response.ok) {
        // The capability gate means this should be unreachable; it is still
        // the honest answer if the engine changed under an open dialog.
        setFailure(data.code === "unsupported" ? { kind: "unsupported" } : { kind: "message", text: formatApiError(data) });
        return;
      }
      setDocuments(Array.isArray(data.documents) ? data.documents : []);
      setHarnessName(data.harness?.shortName ?? null);
    } catch (caught) {
      setFailure({ kind: "message", text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setLoading(false);
    }
  }, []);

  // The component only mounts once the tab has been visited (SettingsConfig's
  // visitedTabs gate keeps it mounted afterward), so this is "on open", not
  // "on every render". Memory is a file the agent rewrites as it works, hence
  // the explicit refresh below.
  useEffect(() => {
    void load();
  }, [load]);

  const engine = harnessName ?? engineName ?? t("memoryPanel.genericEngine");

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Brain size={15} aria-hidden="true" style={{ color: "var(--accent)" }} />
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("memoryPanel.title")}</h3>
          <span style={chipStyle}>{t("memoryPanel.readOnlyBadge")}</span>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("memoryPanel.intro", { engine })}
        </p>
      </div>

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {t("memoryPanel.readOnlyNote")}
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 12px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            background: "var(--bg-subtle)",
            color: "var(--text)",
            cursor: loading ? "wait" : "pointer",
            fontSize: 12,
          }}
        >
          {loading ? (
            <Loader2 size={13} aria-hidden="true" style={{ animation: "spin 0.8s linear infinite" }} />
          ) : (
            <RefreshCw size={13} aria-hidden="true" />
          )}
          {loading ? t("memoryPanel.loading") : t("memoryPanel.refresh")}
        </button>
      </div>

      {failure && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "10px 14px",
            border: "1px solid var(--status-error)",
            borderRadius: "var(--radius-card)",
            background: "var(--bg-panel)",
            color: "var(--status-error)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <AlertCircle size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{failure.kind === "unsupported" ? t("memoryPanel.unsupported") : t("memoryPanel.loadFailed", { error: failure.text })}</span>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {documents.map((entry) => (
          <DocumentCard key={entry.id} doc={entry} engine={engine} />
        ))}
        {!loading && !failure && documents.length === 0 && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>{t("memoryPanel.noDocuments")}</p>
        )}
      </div>
    </div>
  );
}
