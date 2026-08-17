"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Play, Plus, RotateCw, X } from "lucide-react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useI18n } from "@/lib/i18n";
import { STORAGE_EVENTS, STORAGE_KEYS } from "@/lib/storage-keys";
import { normalizeTerminalPaste, readTerminalSoftKeyIds, TERMINAL_SOFT_KEYS, type TerminalSoftKeyId } from "@/lib/terminal-preferences";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useIsMobile } from "@/hooks/useIsMobile";

export type TerminalInfo = {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
};

type Props = {
  cwd: string | null;
  onOpen?: () => void;
  /** One-shot focus request (e.g. a task was dispatched into a fresh
   * terminal): reload the list and focus that terminal. Each request carries a
   * fresh token; a token is consumed exactly once, so neither workspace
   * switches nor re-renders replay an old request. */
  focusRequest?: { id: string; token: number } | null;
};
type ConnectionState = "disconnected" | "connecting" | "connected";


function readSoftKeysPref(): "on" | "off" | null {
  try {
    const value = localStorage.getItem(STORAGE_KEYS.terminalSoftKeysVisible);
    return value === "on" || value === "off" ? value : null;
  } catch {
    return null;
  }
}

function socketUrl(id: string, cols: number, rows: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/terminals/${encodeURIComponent(id)}/socket?cols=${cols}&rows=${rows}`;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error || fallback;
}
function copyTerminalText(text: string): void {
  const fallback = () => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(fallback);
  } else {
    fallback();
  }
}

function TerminalSoftKeys({
  onSend,
  label,
  selectedIds,
}: {
  onSend: (data: string) => void;
  label: string;
  selectedIds: readonly TerminalSoftKeyId[];
}) {
  const selected = new Set(selectedIds);
  return (
    <div className="terminal-soft-keys" role="toolbar" aria-label={label}>
      {TERMINAL_SOFT_KEYS.filter((key) => selected.has(key.id)).map((key) => (
        <button key={key.id} type="button" onClick={() => onSend(key.data)}>{key.label}</button>
      ))}
    </div>
  );
}

export function TerminalPanel({ cwd, onOpen, focusRequest }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  // Soft keys (Esc/Tab/Ctrl/arrows) matter on ANY touch keyboard, not just
  // phones — a tablet terminal without Esc or Ctrl is near unusable.
  const isCoarsePointer = useIsCoarsePointer();
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [softKeysPref, setSoftKeysPref] = useState<"on" | "off" | null>(null);
  const [softKeyIds, setSoftKeyIds] = useState<TerminalSoftKeyId[]>(() => readTerminalSoftKeyIds());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Re-read after hydration and when Settings changes the same local preference.
  useEffect(() => {
    setSoftKeysPref(readSoftKeysPref());
    const refreshSoftKeys = () => setSoftKeyIds(readTerminalSoftKeyIds());
    refreshSoftKeys();
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.terminalSoftKeyIds) refreshSoftKeys();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(STORAGE_EVENTS.terminalSoftKeysChange, refreshSoftKeys);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(STORAGE_EVENTS.terminalSoftKeysChange, refreshSoftKeys);
    };
  }, []);
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const load = useCallback(async () => {
    if (!cwd) {
      setTerminals([]);
      setActiveId(null);
      return;
    }
    try {
      const response = await fetch(`/api/terminals?cwd=${encodeURIComponent(cwd)}`);
      if (!response.ok) throw new Error(await responseError(response, t("terminal.loadError")));
      const data = await response.json() as { terminals?: TerminalInfo[] };
      const loaded = data.terminals ?? [];
      setTerminals(loaded);
      setActiveId((current) => current && loaded.some((item) => item.id === current) ? current : loaded[0]?.id ?? null);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("terminal.loadError"));
    }
  }, [cwd, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // An externally dispatched terminal (e.g. a workspace task) may not be in
  // the current list yet: reload, then focus it once it appears. Consuming the
  // token makes the request one-shot — a later cwd change must not replay it.
  const consumedFocusTokenRef = useRef(0);
  useEffect(() => {
    if (!focusRequest || !cwd) return;
    if (focusRequest.token === consumedFocusTokenRef.current) return;
    consumedFocusTokenRef.current = focusRequest.token;
    const { id } = focusRequest;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/terminals?cwd=${encodeURIComponent(cwd)}`);
        if (!response.ok || cancelled) return;
        const data = await response.json() as { terminals?: TerminalInfo[] };
        const loaded = data.terminals ?? [];
        if (cancelled) return;
        setTerminals(loaded);
        if (loaded.some((item) => item.id === id)) setActiveId(id);
      } catch {
        // list refresh is best-effort; the regular loader will catch up
      }
    })();
    return () => { cancelled = true; };
  }, [focusRequest, cwd]);

  const create = useCallback(async () => {
    if (!cwd || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!response.ok) throw new Error(await responseError(response, t("terminal.createError")));
      const terminal = await response.json() as TerminalInfo;
      setTerminals((items) => [...items.filter((item) => item.id !== terminal.id), terminal]);
      setActiveId(terminal.id);
      setError(null);
      onOpen?.();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t("terminal.createError"));
    } finally {
      setBusy(false);
    }
  }, [busy, cwd, onOpen, t]);

  const close = useCallback(async (id: string) => {
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (response && !response.ok) {
      setError(await responseError(response, t("terminal.closeError")));
      return;
    }
    const next = terminals.filter((item) => item.id !== id);
    setTerminals(next);
    if (activeId === id) setActiveId(next.at(-1)?.id ?? null);
  }, [activeId, t, terminals]);

  const continueShell = useCallback(async (id: string) => {
    const term = terminalRef.current;
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols: term?.cols ?? 80, rows: term?.rows ?? 24 }),
    });
    if (!response.ok) {
      setError(await responseError(response, t("terminal.continueError")));
      return;
    }
    const continued = await response.json() as TerminalInfo;
    setTerminals((items) => items.map((item) => item.id === id ? continued : item));
    setError(null);
    terminalRef.current?.focus();
  }, [t]);

  const send = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    terminalRef.current?.focus();
  }, []);

  const commitRename = useCallback(async (id: string, name: string) => {
    setRenamingId(null);
    const current = terminals.find((item) => item.id === id);
    const trimmed = name.trim();
    if (!current || !trimmed || trimmed === current.name) return;
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    }).catch(() => null);
    if (!response || !response.ok) {
      setError(response ? await responseError(response, t("terminal.renameError")) : t("terminal.renameError"));
      return;
    }
    const renamed = await response.json() as TerminalInfo;
    setTerminals((items) => items.map((item) => (item.id === id ? renamed : item)));
    setError(null);
  }, [t, terminals]);

  const toggleSoftKeys = useCallback((currentlyVisible: boolean) => {
    const next = currentlyVisible ? "off" : "on";
    setSoftKeysPref(next);
    try {
      localStorage.setItem(STORAGE_KEYS.terminalSoftKeysVisible, next);
    } catch { /* preference simply will not persist */ }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const id = activeId;
    if (!host || !id) return;
    let disposed = false;
    const token = (name: string, fallback: string) => getComputedStyle(host).getPropertyValue(name).trim() || fallback;
    const terminalTheme = (): ITheme => ({
      background: token("--bg", "#1e1e1e"),
      foreground: token("--text", "#d4d4d4"),
      cursor: token("--accent", "#8ab4f8"),
      selectionBackground: `${token("--accent", "#8ab4f8")}66`,
      black: token("--bg-panel", "#171717"),
      red: token("--status-error", "#f87171"),
      green: token("--status-success", "#4ade80"),
      yellow: token("--status-warning", "#facc15"),
      blue: token("--status-renamed", "#60a5fa"),
      magenta: token("--accent", "#c084fc"),
      cyan: token("--status-success", "#22d3ee"),
      white: token("--text", "#e5e7eb"),
      brightBlack: token("--text-dim", "#6b7280"),
      brightRed: token("--status-error", "#fca5a5"),
      brightGreen: token("--status-success", "#86efac"),
      brightYellow: token("--status-warning", "#fde047"),
      brightBlue: token("--status-renamed", "#93c5fd"),
      brightMagenta: token("--accent-hover", "#d8b4fe"),
      brightCyan: token("--status-success", "#67e8f9"),
      brightWhite: token("--text", "#f9fafb"),
    });
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      theme: terminalTheme(),
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    terminalRef.current = term;

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const copy = key === "c" && ((event.ctrlKey && event.shiftKey) || event.metaKey);
      if (copy && term.hasSelection()) {
        copyTerminalText(term.getSelection());
        return false;
      }
      // Let the browser raise a ClipboardEvent for paste. The capture handler
      // below sends its plain text directly instead of xterm wrapping it in
      // bracketed-paste escape sequences.
      return true;
    });

    const handleCopy = (event: ClipboardEvent) => {
      if (!term.hasSelection() || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", term.getSelection());
      event.preventDefault();
    };
    const handlePaste = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.preventDefault();
      event.stopPropagation();
      send(normalizeTerminalPaste(event.clipboardData.getData("text/plain")));
    };
    host.addEventListener("copy", handleCopy, true);
    host.addEventListener("paste", handlePaste, true);

    const updateTheme = () => {
      term.options.theme = terminalTheme();
    };
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

    const fitAndResize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(host);
    const input = term.onData(send);

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      const socket = new WebSocket(socketUrl(id, term.cols || 80, term.rows || 24));
      socketRef.current = socket;
      socket.onopen = () => {
        setConnection("connected");
        setError(null);
        fitAndResize();
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type: string; data?: string; exitCode?: number; message?: string; replay?: boolean };
          if (message.type === "output" && message.data) {
            if (message.replay) term.reset();
            term.write(message.data);
          } else if (message.type === "exit") {
            setTerminals((items) => items.map((item) => item.id === id ? { ...item, exited: true, exitCode: message.exitCode } : item));
          } else if (message.type === "error") {
            setError(message.message ?? t("terminal.connectionError"));
          }
        } catch {
          setError(t("terminal.connectionError"));
        }
      };
      socket.onclose = () => {
        setConnection("disconnected");
        if (disposed || activeIdRef.current !== id) return;
        reconnectRef.current = window.setTimeout(connect, 1000);
      };
      socket.onerror = () => setConnection("disconnected");
    };
    connect();
    requestAnimationFrame(() => {
      fitAndResize();
      term.focus();
    });
    return () => {
      disposed = true;
      themeObserver.disconnect();
      observer.disconnect();
      host.removeEventListener("copy", handleCopy, true);
      host.removeEventListener("paste", handlePaste, true);
      input.dispose();
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
      terminalRef.current = null;
    };
  }, [activeId, connectionGeneration, send, t]);

  // Auto on touch (phones and tablets), off on fine pointers; the keyboard
  // toggle in the toolbar overrides either way and sticks in localStorage.
  const softKeysVisible = softKeysPref === "on" || (softKeysPref === null && (isMobile || isCoarsePointer));

  return (
    <section className="terminal-panel" aria-label={t("terminal.title")}>
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label={t("terminal.tabs")}>
          {terminals.map((item, index) => (
            <div key={item.id} className={`terminal-tab${item.id === activeId ? " terminal-tab-active" : ""}`}>
              <button
                id={`terminal-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={item.id === activeId}
                tabIndex={item.id === activeId ? 0 : -1}
                className="terminal-tab-select ui-focus-ring"
                title={item.id === activeId ? t("terminal.renameHint") : undefined}
                onClick={() => {
                  // First click selects; a click on the already-active tab
                  // starts an inline rename.
                  if (item.id === activeId) {
                    setRenameDraft(item.name);
                    setRenamingId(item.id);
                    return;
                  }
                  setActiveId(item.id);
                }}
                onKeyDown={(event) => {
                  let nextIndex: number | undefined;
                  if (event.key === "ArrowRight") nextIndex = (index + 1) % terminals.length;
                  if (event.key === "ArrowLeft") nextIndex = (index - 1 + terminals.length) % terminals.length;
                  if (event.key === "Home") nextIndex = 0;
                  if (event.key === "End") nextIndex = terminals.length - 1;
                  if (nextIndex === undefined) return;
                  event.preventDefault();
                  setActiveId(terminals[nextIndex].id);
                  const tabs = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                  requestAnimationFrame(() => tabs?.[nextIndex]?.focus());
                }}
              >
                <span>{item.name}</span>
              </button>
              {renamingId === item.id && (
                <input
                  className="terminal-tab-rename"
                  aria-label={t("terminal.renameHint")}
                  value={renameDraft}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => void commitRename(item.id, renameDraft)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setRenamingId(null);
                  }}
                  style={{ position: "absolute", inset: 0, zIndex: 1, background: "var(--bg-selected)" }}
                />
              )}
              <button type="button" className="terminal-tab-close ui-focus-ring" aria-label={t("terminal.close", { label: item.name })} title={t("terminal.close", { label: item.name })} onClick={() => void close(item.id)}><X size={12} /></button>
            </div>
          ))}
        </div>
        {activeId && <span className={`terminal-connection terminal-connection-${connection}`} role="status" aria-label={t(`terminal.${connection}`)} title={t(`terminal.${connection}`)} />}
        <button type="button" className="terminal-action ui-focus-ring" onClick={() => void create()} disabled={!cwd || busy} title={t("terminal.new")} aria-label={t("terminal.new")}><Plus size={14} /></button>
        {activeId && terminals.find((item) => item.id === activeId)?.exited ? (
          <button type="button" className="terminal-action ui-focus-ring" onClick={() => void continueShell(activeId)} title={t("terminal.continue")} aria-label={t("terminal.continue")}><Play size={13} /></button>
        ) : activeId ? (
          <button type="button" className="terminal-action ui-focus-ring" onClick={() => setConnectionGeneration((value) => value + 1)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}><RotateCw size={13} /></button>
        ) : null}
        {activeId && (
          <button
            type="button"
            className="terminal-action ui-focus-ring"
            onClick={() => toggleSoftKeys(softKeysVisible)}
            aria-pressed={softKeysVisible}
            title={softKeysVisible ? t("terminal.keysHide") : t("terminal.keysShow")}
            aria-label={softKeysVisible ? t("terminal.keysHide") : t("terminal.keysShow")}
          >
            <Keyboard size={13} />
          </button>
        )}
      </div>
      {error && <div className="terminal-error" role="alert">{error}</div>}
      {activeId ? (
        <>
          <div ref={hostRef} className="terminal-host" role="tabpanel" aria-labelledby={`terminal-tab-${activeId}`} onClick={() => terminalRef.current?.focus()} />
          {softKeysVisible && softKeyIds.length > 0 && <TerminalSoftKeys onSend={send} label={t("terminal.keys")} selectedIds={softKeyIds} />}
        </>
      ) : (
        <div className="terminal-empty">
          <div>{cwd ? t("terminal.empty") : t("terminal.noWorkspace")}</div>
          <button type="button" className="ui-focus-ring terminal-new-button" onClick={() => void create()} disabled={!cwd || busy}><Plus size={14} />{t("terminal.new")}</button>
        </div>
      )}
    </section>
  );
}
