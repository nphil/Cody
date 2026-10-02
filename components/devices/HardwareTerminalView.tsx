"use client";
import { useEffect, useRef } from "react";
import type { DeviceOperationManager } from "@/lib/devices/operations";

/** The same xterm renderer used by Cody's server terminal, without a server PTY. */
export function HardwareTerminalView({ manager, operationId, label, onError }: {
  manager: DeviceOperationManager;
  operationId: string;
  label: string;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const container = host.current;
      const theme = () => {
        const style = getComputedStyle(container);
        return { background: style.getPropertyValue("--bg").trim() || "#151619", foreground: style.getPropertyValue("--text").trim() || "#eeeeee", cursor: style.getPropertyValue("--text").trim() || "#eeeeee" };
      };
      const terminal = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: "ui-monospace, monospace", fontSize: 14, scrollback: 2000, theme: theme(), screenReaderMode: true });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container);
      terminal.write((manager.status(operationId)?.output ?? []).filter(row => row.kind === "terminal").map(row => row.line).join(""));
      const unsubscribe = manager.subscribe((snapshot, event) => {
        if (snapshot.id === operationId && event.output?.kind === "terminal") terminal.write(event.output.line);
      });
      const input = terminal.onData(text => { void manager.sendUser(operationId, text).catch(error => onError(String(error))); });
      const resize = new ResizeObserver(() => { if (container.clientWidth && container.clientHeight) fit.fit(); });
      resize.observe(container);
      const themes = new MutationObserver(() => { terminal.options.theme = theme(); });
      themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      cleanup = () => { unsubscribe(); input.dispose(); resize.disconnect(); themes.disconnect(); terminal.dispose(); };
    })().catch(error => { if (!disposed) onError(String(error)); });
    return () => { disposed = true; cleanup?.(); };
  }, [manager, operationId, onError]);
  return <div ref={host} aria-label={label} style={{ minWidth: 0, height: 240, background: "var(--bg)", padding: 8 }} />;
}
