"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent } from "react";
import { Folder, History, MessageSquarePlus, Paperclip, Send, Square, Trash2, X } from "lucide-react";
import { useAgentSession, type AttachedImage } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { comparableProjectPath } from "@/lib/comparable-path";
import { getFileName } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } from "@/lib/image-attachments";
import {
  prepareImageBatchForAttachment,
  prepareImageForAttachment,
  SUPPORTED_IMAGE_FORMAT_LABEL,
  UnsupportedImageError,
} from "@/lib/image-compress";
import { formatModelDisplayName } from "@/lib/model-display";
import { thinkingLevelLabel } from "@/lib/thinking-level-labels";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import { MessageView } from "./MessageView";
import { LiveDot } from "./ui/LiveDot";
import { Select, type SelectGroup, type SelectOption } from "./ui/Select";
import { toast } from "./ui/toast";

/**
 * The sidebar chat: an ordinary omp session spawned with `kind: "sidebar"`
 * (no tools, skills, extensions or rules; its own session dir under
 * cody-sidebar-chats/), driven by the SAME hook and renderer as the main
 * chat, so streaming, thinking blocks, usage and every provider the engine
 * can reach behave identically. This panel is only chrome: a toolbar, the
 * transcript, a composer. Everything stateful lives in useAgentSession.
 */

interface SidebarChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface SidebarDraftImage {
  file: File;
  data: string;
  mimeType: string;
  previewUrl: string;
  name: string;
}

const SIDEBAR_CHATS_ROUTE = "/api/sidebar-chats";

function revokeImagePreview(image: SidebarDraftImage): void {
  if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
}

const iconButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  flexShrink: 0,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  cursor: "pointer",
};

const SIDEBAR_CONTEXT_BAR_CSS = `
@container (max-width: 360px) {
  .sidebar-context-ws-text { display: none; }
}
`;

async function fetchSidebarChats(cwd: string): Promise<SidebarChatSummary[]> {
  const response = await fetch(`${SIDEBAR_CHATS_ROUTE}?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) return [];
  const body = await response.json() as SidebarChatSummary[] | { chats?: SidebarChatSummary[] };
  return Array.isArray(body) ? body : body.chats ?? [];
}

export function SidebarChatPanel({
  cwd,
  active = true,
  mainSessionId = null,
  onContextTargetChange,
}: {
  cwd: string;
  active?: boolean;
  /** The session id currently open in the main chat pane. The context
   * picker defaults to it and the sidebar's read-only tools use it as their
   * default `read_session` target until the user points the picker at a
   * different workspace session. */
  mainSessionId?: string | null;
  /** Fires with the sidebar's resolved read target whenever it changes —
   * either the user picked a different session in the picker, or
   * `mainSessionId` moved and the picker is still following it (no manual
   * override yet). `null` means no session is available to read. */
  onContextTargetChange?: (sessionId: string | null) => void;
}) {
  const { t } = useI18n();
  const [chats, setChats] = useState<SidebarChatSummary[]>([]);
  // `chosenId` is what the user picked (history entry or New chat) and keys
  // the session view, so switching chats remounts the hook. A session the
  // hook CREATES on first send is adopted without remounting — the hook
  // already tracks its own id — and only recorded here so the history menu
  // can highlight it and a later "New chat" starts from a null session.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [chosenNonce, setChosenNonce] = useState(0);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const selectedId = chosenId ?? createdId;
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const reloadChats = useCallback(async () => {
    setChats(await fetchSidebarChats(cwd).catch(() => []));
  }, [cwd]);

  const [contextSessions, setContextSessions] = useState<SessionInfo[]>([]);
  // `null` means "follow `mainSessionId`"; set only when the user picks a
  // different session in the picker. Re-picking the session that matches
  // `mainSessionId` clears it, resuming auto-follow.
  const [manualTargetId, setManualTargetId] = useState<string | null>(null);
  const reloadContextSessions = useCallback(async () => {
    const response = await fetch("/api/sessions").catch(() => null);
    if (!response?.ok) { setContextSessions([]); return; }
    const body = await response.json() as { sessions?: SessionInfo[] };
    const workspaceKey = comparableProjectPath(cwd);
    const matches = (body.sessions ?? []).filter(
      (candidate) => comparableProjectPath(candidate.projectRoot ?? candidate.cwd) === workspaceKey,
    );
    matches.sort((a, b) => b.modified.localeCompare(a.modified));
    setContextSessions(matches);
  }, [cwd]);

  useEffect(() => {
    if (active) void reloadContextSessions();
  }, [active, reloadContextSessions]);

  useEffect(() => {
    if (active) void reloadChats();
  }, [active, reloadChats]);

  useEffect(() => {
    if (!historyOpen) return;
    const close = (event: MouseEvent) => {
      if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [historyOpen]);

  const deleteChat = useCallback(async (id: string) => {
    const response = await fetch(`${SIDEBAR_CHATS_ROUTE}/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) {
      toast.error(t("sidebarChat.deleteFailed"));
      return;
    }
    setChats((current) => current.filter((chat) => chat.id !== id));
    if (selectedId === id) { setChosenId(null); setCreatedId(null); setChosenNonce((n) => n + 1); }
  }, [selectedId, t]);

  const session = useMemo<SessionInfo | null>(() => chosenId
    ? { id: chosenId, path: "", cwd, created: "", modified: "", messageCount: 0, firstMessage: "" }
    : null, [chosenId, cwd]);

  const workspaceName = getFileName(cwd) || cwd;
  const contextTargetId = manualTargetId ?? mainSessionId ?? null;
  // Plain values: the React Compiler memoizes them correctly, while the
  // hand-written dependency arrays here could not be preserved (the option
  // labels also depend on `t`), which made it skip optimizing the component.
  const contextOptions: SelectOption<string>[] = (() => {
    const options: SelectOption<string>[] = contextSessions.map((candidate) => ({
      value: candidate.id,
      label: candidate.name || candidate.firstMessage || t("sidebarChat.contextUntitled"),
    }));
    if (mainSessionId && !contextSessions.some((candidate) => candidate.id === mainSessionId)) {
      options.unshift({ value: mainSessionId, label: t("sidebarChat.contextCurrent") });
    }
    return options;
  })();
  // Selecting the session the main chat already has open clears the override,
  // resuming auto-follow — no separate "follow" entry needed.
  const handleContextTargetChange = (value: string) => {
    setManualTargetId(value === mainSessionId ? null : value);
  };

  // Reports the resolved target (not just user picks): if the picker is
  // still following `mainSessionId` and the main chat switches sessions, the
  // lead's spawn default has to move with it.
  useEffect(() => {
    onContextTargetChange?.(contextTargetId);
  }, [contextTargetId, onContextTargetChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <div
        className="workspace-subtitle-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          borderBottom: "1px solid var(--border)",
          color: "var(--text-muted)",
          fontSize: 11,
          fontWeight: 600,
          containerType: "inline-size",
        } as CSSProperties}
      >
        <style>{SIDEBAR_CONTEXT_BAR_CSS}</style>
        <div
          role="group"
          aria-label={t("sidebarChat.contextGroupLabel")}
          style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}
        >
          <span
            title={cwd}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, maxWidth: 110, overflow: "hidden", color: "var(--text-dim)" }}
          >
            <Folder size={12} aria-hidden style={{ flexShrink: 0 }} />
            <span className="sidebar-context-ws-text" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {workspaceName}
            </span>
          </span>
          <div style={{ flex: "1 1 70px", minWidth: 56 }}>
            <Select
              size="sm"
              value={contextTargetId}
              onChange={handleContextTargetChange}
              options={contextOptions}
              placeholder={t("sidebarChat.contextPlaceholder")}
              disabled={contextOptions.length === 0}
              aria-label={t("sidebarChat.contextSessionLabel")}
              popupWidth={260}
              data-testid="ContextSession"
            />
          </div>
        </div>
        <div ref={historyRef} style={{ position: "relative" }}>
          <button type="button" className="ui-focus-ring" style={{ ...iconButtonStyle, width: 22, height: 20, padding: 0, lineHeight: 0 }} title={t("sidebarChat.history")} aria-label={t("sidebarChat.history")} aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            <History size={13} />
          </button>
          {historyOpen && (
            <div role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 30, width: 260, maxHeight: 280, overflowY: "auto", padding: 4, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-pop)" }}>
              {chats.length === 0
                ? <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-dim)", fontWeight: 400 }}>{t("sidebarChat.noHistory")}</div>
                : chats.map((chat) => (
                  <div key={chat.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button
                      type="button"
                      role="menuitem"
                      className="ui-focus-ring"
                      onClick={() => { setChosenId(chat.id); setCreatedId(null); setHistoryOpen(false); }}
                    >
                      {chat.title || t("sidebarChat.empty")}
                    </button>
                    <button type="button" className="ui-focus-ring" title={t("sidebarChat.delete")} aria-label={t("sidebarChat.delete")} onClick={() => void deleteChat(chat.id)} style={{ ...iconButtonStyle, width: 24, height: 24, border: 0, background: "transparent" }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
        <button type="button" className="ui-focus-ring" style={{ ...iconButtonStyle, width: 22, height: 20, padding: 0, lineHeight: 0 }} title={t("sidebarChat.newChat")} aria-label={t("sidebarChat.newChat")} onClick={() => { setChosenId(null); setCreatedId(null); setChosenNonce((n) => n + 1); setHistoryOpen(false); }}>
          <MessageSquarePlus size={13} />
        </button>
      </div>
      <SidebarChatSession
        key={chosenId ?? `new-${chosenNonce}`}
        session={session}
        cwd={cwd}
        contextSessionId={contextTargetId}
        onSessionCreated={(id) => { setCreatedId(id); void reloadChats(); }}
        onTurnEnd={() => void reloadChats()}
      />
    </div>
  );
}

function SidebarChatSession({ session, cwd, contextSessionId, onSessionCreated, onTurnEnd }: {
  session: SessionInfo | null;
  cwd: string;
  /** Main chat session the context tools read by default. */
  contextSessionId: string | null;
  onSessionCreated: (id: string) => void;
  onTurnEnd: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<SidebarDraftImage[]>([]);
  const [preparingImages, setPreparingImages] = useState(false);
  const imagesRef = useRef<SidebarDraftImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  imagesRef.current = images;

  useEffect(() => () => { imagesRef.current.forEach(revokeImagePreview); }, []);

  const {
    messages, entryIds, streamState, agentRunning, loading,
    currentModel, modelList, modelNames, modelThinkingLevels, thinkingLevel, thinkingLevelPending,
    contextUsage, sessionStats,
    handleSend, handleAbort, handleModelChange, handleThinkingLevelChange,
    scrollContainerRef, messagesEndRef,
  } = useAgentSession({
    session,
    newSessionCwd: session ? null : cwd,
    sessionKind: "sidebar",
    // What `read_session` defaults to: the main chat this panel is pointed at.
    contextSessionId,
    advisorEnabled: false,
    thinkingDefaultExpanded: false,
    onAgentEnd: onTurnEnd,
    onSessionCreated: (created) => onSessionCreated(created.id),
  });

  const modelValue = currentModel ? `${currentModel.provider}:${currentModel.modelId}` : null;

  const modelGroups = useMemo<SelectGroup<string>[]>(() => {
    const byProvider = new Map<string, SelectOption<string>[]>();
    for (const model of modelList) {
      const key = `${model.provider}:${model.id}`;
      const option: SelectOption<string> = {
        value: key,
        label: formatModelDisplayName(model.id, modelNames[key] ?? model.name),
      };
      const existing = byProvider.get(model.provider);
      if (existing) existing.push(option);
      else byProvider.set(model.provider, [option]);
    }
    return Array.from(byProvider.entries(), ([provider, options]) => ({ label: provider, options }));
  }, [modelList, modelNames]);

  const thinkingOptions = useMemo(
    () => currentModel ? modelThinkingLevels[`${currentModel.provider}:${currentModel.modelId}`] ?? [] : [],
    [currentModel, modelThinkingLevels],
  );

  // `auto` is a real choice, not an absence: an unset level means "use the
  // model's own default", which is exactly what the main composer shows and
  // sends. Without it the trigger renders blank whenever nothing is pinned.
  const thinkingSelectOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: "auto", label: thinkingLevelLabel("auto", t) },
      ...thinkingOptions.filter((level) => level !== "auto").map((level) => ({ value: level, label: thinkingLevelLabel(level, t) })),
    ],
    [thinkingOptions, t],
  );

  const unsupportedImageMessage = useCallback(
    (fileName: string) => t("sidebarChat.imageUndecodable", { name: fileName, formats: SUPPORTED_IMAGE_FORMAT_LABEL }),
    [t],
  );

  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const remaining = Math.max(0, MAX_ATTACHED_IMAGES - imagesRef.current.length);
    const sized = imageFiles.filter((file) => file.size <= MAX_ATTACHED_IMAGE_BYTES);
    const accepted = sized.slice(0, remaining);
    if (!accepted.length) {
      toast.error(remaining === 0
        ? t("sidebarChat.maxImagesReached", { max: MAX_ATTACHED_IMAGES })
        : t("sidebarChat.imagesTooLargeSkipped", { count: imageFiles.length, mb: Math.round(MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)) }));
      return;
    }
    setPreparingImages(true);
    const prepared: SidebarDraftImage[] = [];
    const failures: string[] = [];
    try {
      for (const file of accepted) {
        try {
          const result = await prepareImageForAttachment(file, unsupportedImageMessage);
          prepared.push({ file, data: result.data, mimeType: result.mimeType, previewUrl: URL.createObjectURL(file), name: file.name });
        } catch (error) {
          failures.push(error instanceof UnsupportedImageError
            ? error.message
            : t("sidebarChat.imageReadFailed", { name: file.name }));
        }
      }
    } finally {
      setPreparingImages(false);
    }
    if (prepared.length) {
      setImages((prev) => {
        const room = Math.max(0, MAX_ATTACHED_IMAGES - prev.length);
        const keep = prepared.slice(0, room);
        prepared.slice(room).forEach(revokeImagePreview);
        return [...prev, ...keep];
      });
    }
    if (failures.length) toast.error(failures.join("\n"));
  }, [t, unsupportedImageMessage]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      return next;
    });
  }, []);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(
    useCallback((files: File[]) => { void addImageFiles(files); }, [addImageFiles]),
  );

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    event.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    void addImageFiles(files);
  }, [addImageFiles]);

  const submit = useCallback(async () => {
    const draftSnapshot = draft;
    const text = draftSnapshot.trim();
    const imageSnapshot = images;
    if (!text && !imageSnapshot.length) return;
    if (preparingImages) return;
    const restoreSnapshot = () => {
      setDraft((current) => current ? [draftSnapshot, current].filter(Boolean).join("\n\n") : draftSnapshot);
      setImages((current) => [...imageSnapshot, ...current]);
    };
    setDraft("");
    setImages([]);
    let outgoing: AttachedImage[] | undefined;
    if (imageSnapshot.length) {
      setPreparingImages(true);
      try {
        const batch = await prepareImageBatchForAttachment({
          files: imageSnapshot.map((image) => image.file),
          message: text,
          unsupportedMessage: unsupportedImageMessage,
        });
        outgoing = imageSnapshot.map((image, index) => ({
          data: batch[index].data,
          mimeType: batch[index].mimeType,
          previewUrl: image.previewUrl,
        }));
      } catch (error) {
        restoreSnapshot();
        toast.error(error instanceof Error ? error.message : t("sidebarChat.imageReadFailed", { name: imageSnapshot[0]?.name ?? t("sidebarChat.attachFile") }));
        return;
      } finally {
        setPreparingImages(false);
      }
    }
    let accepted = false;
    try {
      accepted = await handleSend(text, outgoing);
    } catch (error) {
      restoreSnapshot();
      toast.error(error instanceof Error ? error.message : t("sidebarChat.imageReadFailed", { name: imageSnapshot[0]?.name ?? t("sidebarChat.attachFile") }));
      return;
    }
    if (!accepted) restoreSnapshot();
    else imageSnapshot.forEach(revokeImagePreview);
  }, [draft, handleSend, images, preparingImages, t, unsupportedImageMessage]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const percent = contextUsage?.percent ?? null;
  const usageColor = percent === null ? "var(--text-dim)" : percent >= 90 ? "var(--status-error)" : percent >= 70 ? "var(--status-warning)" : "var(--text-muted)";
  const totalTokens = sessionStats?.tokens.total ?? null;

  return (
    <>
      <div style={{ display: "flex", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select
            size="sm"
            value={modelValue}
            onChange={(value) => {
              const [provider, ...rest] = value.split(":");
              if (provider && rest.length) void handleModelChange(provider, rest.join(":"));
            }}
            options={modelGroups}
            placeholder={t("sidebarChat.selectModel")}
            disabled={agentRunning || modelList.length === 0}
            aria-label={t("sidebarChat.model")}
            data-testid="Model"
          />
        </div>
        <div style={{ flexBasis: 112, flexGrow: 0, flexShrink: 0, minWidth: 0 }}>
          <Select
            size="sm"
            value={thinkingLevel ?? "auto"}
            onChange={(value) => void handleThinkingLevelChange(value)}
            options={thinkingSelectOptions}
            disabled={!thinkingOptions.length || thinkingLevelPending}
            aria-label={t("sidebarChat.thinking")}
            data-testid="Thinking"
          />
        </div>
      </div>

      <div ref={scrollContainerRef} className="chat-scroll-region" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 10px 4px" }}>
        {messages.length === 0 && !streamState.isStreaming && !loading && (
          <div style={{ padding: "40px 12px", textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>{t("sidebarChat.empty")}</div>
        )}
        {messages.map((message, index) => (
          <div key={entryIds[index] ?? `idx-${index}`} className="chat-turn" data-turn-key={entryIds[index] ?? `idx-${index}`}>
            <MessageView message={message} modelNames={modelNames} cwd={cwd} entryId={entryIds[index]} sessionId={session?.id} thinkingDefaultExpanded={false} activityDisplayMode="compact" />
          </div>
        ))}
        {streamState.isStreaming && streamState.streamingMessage && (
          <div className="chat-turn chat-turn--live">
            <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={cwd} sessionId={session?.id} thinkingDefaultExpanded={false} activityDisplayMode="compact" />
          </div>
        )}
        {agentRunning && !streamState.streamingMessage && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", fontSize: 12, color: "var(--text-muted)" }}>
            <LiveDot />
            {t("sidebarChat.thinkingStatus")}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ borderTop: "1px solid var(--border)", padding: "8px 8px calc(8px + var(--safe-bottom))", background: "var(--bg)" }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            void addImageFiles(files);
            event.target.value = "";
          }}
        />
        {images.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {images.map((image, index) => (
              <div key={index} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.previewUrl}
                  alt=""
                  style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  type="button"
                  className="ui-focus-ring"
                  onClick={() => removeImage(index)}
                  title={t("sidebarChat.removeImage")}
                  aria-label={t("sidebarChat.removeImage")}
                  style={{
                    position: "absolute", top: -5, right: -5,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <X size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            display: "flex", alignItems: "flex-end", gap: 6,
            border: `1px solid ${isDragOver ? "var(--accent)" : "var(--border)"}`,
            borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: 6,
            transition: "border-color var(--dur-fast) var(--ease-out-warm)",
          }}
        >
          <button
            type="button"
            className="ui-focus-ring"
            onClick={() => fileInputRef.current?.click()}
            disabled={preparingImages}
            title={preparingImages ? t("sidebarChat.imagePreparing") : t("sidebarChat.attachFile")}
            aria-label={preparingImages ? t("sidebarChat.imagePreparing") : t("sidebarChat.attachFile")}
            style={{ ...iconButtonStyle, width: 30, height: 30, border: 0, background: "transparent", color: images.length ? "var(--accent)" : "var(--text-muted)" }}
          >
            <Paperclip size={14} />
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={agentRunning ? t("sidebarChat.steerPlaceholder") : t("sidebarChat.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            style={{ flex: 1, minWidth: 0, minHeight: 34, maxHeight: 160, padding: "7px 8px", resize: "none", border: 0, outline: "none", background: "transparent", color: "var(--text)", fontSize: "var(--chat-font-size)", lineHeight: 1.5, fieldSizing: "content" } as CSSProperties}
          />
          {agentRunning ? (
            <button type="button" className="ui-focus-ring" onClick={() => void handleAbort()} title={t("sidebarChat.stop")} aria-label={t("sidebarChat.stop")} style={{ ...iconButtonStyle, width: 30, height: 30, color: "var(--status-error)" }}>
              <Square size={13} />
            </button>
          ) : null}
          <button type="button" className="ui-focus-ring" onClick={() => void submit()} disabled={(!draft.trim() && !images.length) || preparingImages} title={t("sidebarChat.send")} aria-label={t("sidebarChat.send")} style={{ ...iconButtonStyle, width: 30, height: 30, border: 0, background: (draft.trim() || images.length) ? "var(--accent)" : "var(--bg-hover)", color: (draft.trim() || images.length) ? "var(--accent-contrast, #fff)" : "var(--text-dim)" }}>
            <Send size={13} />
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 5, padding: "0 2px", fontSize: 11, color: usageColor, fontVariantNumeric: "tabular-nums" }}>
          <span>{percent === null ? t("sidebarChat.usageUnknown") : t("sidebarChat.usagePercent", { percent: Math.round(percent) })}</span>
          <span style={{ color: "var(--text-dim)" }}>{totalTokens === null ? "" : t("sidebarChat.usageTokens", { tokens: totalTokens.toLocaleString() })}</span>
        </div>
      </div>
    </>
  );
}
