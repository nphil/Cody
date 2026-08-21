"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssistantContentBlock, AssistantMessage, ToolResultMessage } from "@/lib/types";
import { MessageView } from "@/components/MessageView";
import { StreamTuningProvider } from "@/hooks/useStreamTuning";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  DEFAULT_STREAM_TUNING,
  STREAM_EASING_OPTIONS,
  STREAM_TUNING_RANGES,
  getStreamTuning,
  isDefaultStreamTuning,
  normalizeStreamTuning,
  saveStreamTuning,
  streamTuningCssVars,
  type StreamTuning,
} from "@/lib/stream-tuning";

/**
 * /dev/stream-tuner — playground for the streaming animation parameters.
 *
 * A scripted assistant turn (thinking → prose → tool call with streaming
 * input → result → prose with a code fence) is fed through configurable
 * network-arrival patterns and rendered by the REAL MessageView pipeline, so
 * what you tune here is exactly what a live chat does. The knobs edit a
 * draft applied via StreamTuningProvider + CSS variables; "Save as app
 * default" persists it to localStorage, which live chats pick up instantly.
 */

declare global {
  interface Window {
    /** Set on hydrate; read by the inline BOOT_DIAGNOSTIC watchdog. */
    __tunerHydrated?: boolean;
  }
}

/**
 * Pre-hydration diagnostic, server-rendered as an inline script so it runs
 * the moment the HTML parses — long before the (large, dev-mode) client
 * bundle arrives. On devices with no console (a tablet framing this page
 * through the preview gateway) it is the only way to see WHY the page is
 * inert: it paints failed script/style loads and runtime errors into the
 * #tuner-boot-log node, and after 20s of no hydration says so explicitly.
 * The hydrate effect sets window.__tunerHydrated and clears the node.
 */
const BOOT_DIAGNOSTIC = `
(function () {
  var log = function (text) {
    var node = document.getElementById("tuner-boot-log");
    if (!node) return;
    node.style.display = "block";
    var line = document.createElement("div");
    line.textContent = text;
    node.appendChild(line);
  };
  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && (target.tagName === "SCRIPT" || target.tagName === "LINK")) {
      log("failed to load: " + (target.src || target.href));
      return;
    }
    log("error: " + (event.message || "unknown"));
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    log("rejection: " + String(event.reason));
  });
  window.setTimeout(function () {
    if (!window.__tunerHydrated) log("scripts have not executed after 20s - the bundle is still downloading, blocked, or failed silently. Reload to retry.");
  }, 20000);
})();
`;

// ── Scripted turn ───────────────────────────────────────────────────────────

type SimSegment =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolName: string;
      baseInput: Record<string, unknown>;
      streamKey: string;
      streamValue: string;
      result: string;
      runMs: number;
    };

const TOOL_CALL_ID = "sim_tool_1";

const SCRIPT: SimSegment[] = [
  {
    kind: "thinking",
    text:
      "The user wants smoother streaming. Network chunks arrive in bursts — sometimes a single word, sometimes three paragraphs at once — so painting them directly reads as jarring jumps. " +
      "The fix is a pacer between the growing target text and what is painted: every animation frame reveals a slice of the outstanding backlog proportional to elapsed time. " +
      "I should check how the pacer is wired before changing any constants.",
  },
  {
    kind: "text",
    text:
      "Let me walk through how the **stream pacer** works.\n\n" +
      "Every SSE frame grows the target text, but the display only advances per animation frame — `backlog × dt / catchUpMs` characters at a time, so a burst diffuses over roughly a quarter second while a fast stream can never run away from the display.\n\n" +
      "Three properties matter here:\n\n" +
      "- **Catch-up time** controls how quickly a burst is absorbed\n" +
      "- **Min reveal** guarantees progress on the exponential tail\n" +
      "- **Word lookahead** lets words pop whole instead of mid-token\n\n" +
      "Now I'll check where the constants live.",
  },
  {
    kind: "tool",
    toolName: "bash",
    baseInput: { timeout: 120 },
    streamKey: "command",
    streamValue: 'grep -rn "createStreamPacer" hooks lib --include="*.ts" | head -20 && echo done',
    result:
      'hooks/useSmoothStreamText.ts:73:export function createStreamPacer(options: StreamPacerOptions = {}): StreamPacer {\n' +
      'hooks/useSmoothStreamText.ts:206:    const pacer = (pacerRef.current ??= createStreamPacer(options));\n' +
      "done",
    runMs: 900,
  },
  {
    kind: "text",
    text:
      "Found it. The pacer core is small enough to read whole:\n\n" +
      "```ts\nconst backlog = target.length - shown;\nconst reveal = Math.max(minRevealChars, Math.ceil((backlog * dt) / catchUpMs));\nlet cut = Math.min(target.length, shown + reveal);\n```\n\n" +
      "So the *feel* is governed by a handful of constants, and none of them depend on how the network happens to batch tokens — which is exactly the point. Tune the knobs on the right until the cadence reads naturally, then save.",
  },
];

function segmentLength(s: SimSegment): number {
  return s.kind === "tool" ? s.streamValue.length : s.text.length;
}

/** Content blocks for "segment `seg` has `offset` chars revealed". */
function buildContent(seg: number, offset: number): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];
  for (let i = 0; i <= seg && i < SCRIPT.length; i++) {
    const s = SCRIPT[i];
    const off = i < seg ? segmentLength(s) : offset;
    if (off <= 0) continue;
    if (s.kind === "thinking") blocks.push({ type: "thinking", thinking: s.text.slice(0, off) });
    else if (s.kind === "text") blocks.push({ type: "text", text: s.text.slice(0, off) });
    else {
      // Fresh input object per emit — exactly how message_update frames behave.
      blocks.push({
        type: "toolCall",
        toolCallId: TOOL_CALL_ID,
        toolName: s.toolName,
        input: { ...s.baseInput, [s.streamKey]: s.streamValue.slice(0, off) },
      });
    }
  }
  return blocks;
}

// ── Network arrival patterns ────────────────────────────────────────────────

type FeedPattern = "steady" | "bursty" | "stall-flush" | "slow-start";

const FEED_PATTERNS: { value: FeedPattern; label: string }[] = [
  { value: "steady", label: "Steady — regular small chunks" },
  { value: "bursty", label: "Bursty — trickle with big flushes" },
  { value: "stall-flush", label: "Stall + flush — 2s silence, then a dump" },
  { value: "slow-start", label: "Slow start — long first gaps" },
];

/** Stateful generator of (gap, size) chunk events for one run. */
function createFeed(pattern: FeedPattern): () => { delayMs: number; chars: number } {
  let i = 0;
  switch (pattern) {
    case "steady":
      return () => ({ delayMs: 45, chars: 14 });
    case "bursty":
      return () =>
        Math.random() < 0.22
          ? { delayMs: 380 + Math.random() * 500, chars: 140 + Math.floor(Math.random() * 220) }
          : { delayMs: 40 + Math.random() * 45, chars: 6 + Math.floor(Math.random() * 16) };
    case "stall-flush":
      return () => {
        i += 1;
        return i % 14 === 0 ? { delayMs: 2000, chars: 480 } : { delayMs: 45, chars: 12 };
      };
    case "slow-start":
      return () => {
        const d = Math.max(45, 750 - i * 55);
        i += 1;
        return { delayMs: d, chars: 12 };
      };
  }
}

interface ArrivalStats {
  chunks: number;
  chars: number;
  maxChunk: number;
  /** Last ~40 chunk sizes for the arrival strip. */
  bars: number[];
}

const EMPTY_STATS: ArrivalStats = { chunks: 0, chars: 0, maxChunk: 0, bars: [] };

// ── Simulator ───────────────────────────────────────────────────────────────

function useTurnSimulator(pattern: FeedPattern, speed: number, loop: boolean) {
  const [message, setMessage] = useState<AssistantMessage | null>(null);
  const [toolResults, setToolResults] = useState<Map<string, ToolResultMessage> | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<ArrivalStats>(EMPTY_STATS);
  const runIdRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // Loop/speed/pattern read at schedule time so mid-run changes apply.
  const knobsRef = useRef({ pattern, speed, loop });
  knobsRef.current = { pattern, speed, loop };

  const stop = useCallback(() => {
    runIdRef.current += 1;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setRunning(false);
  }, []);

  const start = useCallback(() => {
    runIdRef.current += 1;
    const run = runIdRef.current;
    window.clearTimeout(timerRef.current ?? undefined);
    const feed = createFeed(knobsRef.current.pattern);
    const sim = { seg: 0, offset: 0 };
    setToolResults(undefined);
    setStats(EMPTY_STATS);
    setMessage({ role: "assistant", model: "playground", provider: "simulator", content: [] });
    setRunning(true);

    const emit = (state: { seg: number; offset: number }) => {
      setMessage({ role: "assistant", model: "playground", provider: "simulator", content: buildContent(state.seg, state.offset) });
    };

    const finish = () => {
      setRunning(false);
      if (knobsRef.current.loop) {
        timerRef.current = window.setTimeout(() => {
          if (runIdRef.current === run) start();
        }, 1600);
      }
    };

    const scheduleChunk = () => {
      const { delayMs, chars } = feed();
      timerRef.current = window.setTimeout(() => {
        if (runIdRef.current !== run) return;
        setStats((prev) => ({
          chunks: prev.chunks + 1,
          chars: prev.chars + chars,
          maxChunk: Math.max(prev.maxChunk, chars),
          bars: [...prev.bars.slice(-39), chars],
        }));
        let budget = chars;
        while (budget > 0 && sim.seg < SCRIPT.length) {
          const segment = SCRIPT[sim.seg];
          const len = segmentLength(segment);
          const take = Math.min(budget, len - sim.offset);
          sim.offset += take;
          budget -= take;
          if (sim.offset < len) break;
          if (segment.kind === "tool") {
            // Input complete: show it whole, run the tool, deliver the
            // result, then resume streaming the rest of the turn.
            emit(sim);
            timerRef.current = window.setTimeout(() => {
              if (runIdRef.current !== run) return;
              setToolResults(new Map([[TOOL_CALL_ID, {
                role: "toolResult",
                toolCallId: TOOL_CALL_ID,
                content: [{ type: "text", text: segment.result }],
                isError: false,
              } as ToolResultMessage]]));
              sim.seg += 1;
              sim.offset = 0;
              if (sim.seg >= SCRIPT.length) finish();
              else scheduleChunk();
            }, segment.runMs / knobsRef.current.speed);
            return;
          }
          sim.seg += 1;
          sim.offset = 0;
        }
        emit(sim);
        if (sim.seg >= SCRIPT.length) finish();
        else scheduleChunk();
      }, delayMs / knobsRef.current.speed);
    };

    scheduleChunk();
  }, []);

  useEffect(() => stop, [stop]);

  return { message, toolResults, running, stats, start, stop };
}

// ── Controls ────────────────────────────────────────────────────────────────

const NUMERIC_KNOBS: { key: keyof typeof STREAM_TUNING_RANGES; label: string; unit: string; group: "pacer" | "motion" }[] = [
  { key: "catchUpMs", label: "Catch-up time", unit: "ms", group: "pacer" },
  { key: "minRevealChars", label: "Min reveal / frame", unit: "ch", group: "pacer" },
  { key: "maxBacklogChars", label: "Max display lag", unit: "ch", group: "pacer" },
  { key: "wordLookaheadChars", label: "Word lookahead", unit: "ch", group: "pacer" },
  { key: "drainCatchUpMs", label: "Superseded drain (0 = snap)", unit: "ms", group: "pacer" },
  { key: "plainTailWindowChars", label: "Animated tail window", unit: "ch", group: "pacer" },
  { key: "wordFadeMs", label: "Word fade-in", unit: "ms", group: "motion" },
  { key: "wordBlurPx", label: "Word blur-in", unit: "px", group: "motion" },
  { key: "blockEnterMs", label: "Block entrance", unit: "ms", group: "motion" },
  { key: "blockRisePx", label: "Block rise", unit: "px", group: "motion" },
  { key: "collapseMs", label: "Collapse grow/shrink", unit: "ms", group: "motion" },
];

function Knob({ label, unit, value, min, max, step, onChange }: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "1fr 76px", alignItems: "center", rowGap: 2, marginBottom: 10, fontSize: 12, color: "var(--text-muted)" }}>
      <span>{label}</span>
      <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
        {value}{unit}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.currentTarget.value))}
        style={{ gridColumn: "1 / -1", width: "100%", accentColor: "var(--accent)" }}
      />
    </label>
  );
}

const BUTTON_BASE = {
  padding: "6px 10px",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
} as const;

function SectionTitle({ children }: { children: string }) {
  return <h3 style={{ margin: "14px 0 8px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-dim)" }}>{children}</h3>;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function StreamTunerPage() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [draft, setDraft] = useState<StreamTuning>(DEFAULT_STREAM_TUNING);
  const [pattern, setPattern] = useState<FeedPattern>("bursty");
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [expandTools, setExpandTools] = useState(true);
  const [savedFlash, setSavedFlash] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const [settingsText, setSettingsText] = useState("");
  const { message, toolResults, running, stats, start, stop } = useTurnSimulator(pattern, speed, loop);

  // Adopt the persisted tuning after mount (localStorage is client-only; the
  // server render must use the defaults or hydration mismatches), then
  // AUTO-START. On a slow transport (dev bundle through a tunnel onto a
  // tablet) hydration can lag the server-rendered HTML by many seconds —
  // motion appearing is the "ready" signal, and nobody has to find a button.
  useEffect(() => {
    setDraft(getStreamTuning());
    setHydrated(true);
    window.__tunerHydrated = true;
    const bootLog = document.getElementById("tuner-boot-log");
    if (bootLog) bootLog.style.display = "none";
    start();
  }, [start]);

  // Any runtime failure surfaces ON the page: a remote tablet has no console,
  // and a dead button with no message is undebuggable from a chat transcript.
  useEffect(() => {
    const onError = (event: ErrorEvent) => setPageError(event.message || "unknown script error");
    const onRejection = (event: PromiseRejectionEvent) => setPageError(String(event.reason ?? "unhandled rejection"));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const cssVars = useMemo(() => streamTuningCssVars(draft), [draft]);
  const settingsJson = useMemo(() => JSON.stringify(draft), [draft]);

  const setField = useCallback((key: keyof StreamTuning, value: number | boolean | string) => {
    setDraft((prev) => normalizeStreamTuning({ ...prev, [key]: value }));
  }, []);

  const handleSave = () => {
    saveStreamTuning(draft);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1800);
  };

  // Clipboard, most-capable first: async API (needs a secure context and, in
  // an iframe, the clipboard-write allowance Cody's panel grants) → hidden
  // selection + execCommand (no permission model, works in Android WebViews)
  // → "manual" mode, where the JSON field below is focused and pre-selected
  // for a long-press copy. The field is always rendered, so the settings are
  // recoverable even when every programmatic path is blocked.
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(settingsJson);
      setCopyState("copied");
    } catch {
      try {
        const scratch = document.createElement("textarea");
        scratch.value = settingsJson;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.opacity = "0";
        document.body.appendChild(scratch);
        scratch.select();
        const ok = document.execCommand("copy");
        scratch.remove();
        setCopyState(ok ? "copied" : "manual");
      } catch {
        setCopyState("manual");
      }
    }
    window.setTimeout(() => setCopyState("idle"), 2200);
  };

  const handleApplySettings = () => {
    try {
      setDraft(normalizeStreamTuning(JSON.parse(settingsText)));
      setSettingsText("");
    } catch {
      setPageError("Settings JSON did not parse — paste the exact string from Copy settings.");
    }
  };

  const knob = (key: keyof typeof STREAM_TUNING_RANGES, label: string, unit: string) => (
    <Knob
      key={key}
      label={label}
      unit={unit}
      value={draft[key]}
      min={STREAM_TUNING_RANGES[key].min}
      max={STREAM_TUNING_RANGES[key].max}
      step={STREAM_TUNING_RANGES[key].step}
      onChange={(v) => setField(key, v)}
    />
  );

  return (
    <StreamTuningProvider value={draft}>
      <div style={{ display: "flex", height: "100vh", background: "var(--bg)", color: "var(--text)" }}>
        {/* ── Preview column: the real MessageView under the draft tuning ── */}
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "20px 24px", ...cssVars }}>
          <div style={{ maxWidth: 720, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
              <h1 className="display-serif" style={{ fontSize: 20, margin: 0 }}>Stream tuner</h1>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                simulated turn · rendered by the production streaming pipeline
              </span>
              {/* Liveness at a glance: server-rendered HTML says "loading" until
                  the (large, dev-mode) bundle hydrates — a static page with dead
                  buttons and no chip means scripts have not arrived yet. */}
              <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 11, padding: "2px 8px", borderRadius: 999, fontVariantNumeric: "tabular-nums", background: "color-mix(in srgb, var(--accent) 12%, transparent)", color: hydrated ? "var(--accent)" : "var(--text-dim)" }}>
                {hydrated ? (running ? "running" : "idle") : "loading scripts…"}
              </span>
            </div>
            {/* Painted by the inline BOOT_DIAGNOSTIC script; React never
                touches its contents. suppressHydrationWarning: the script may
                write into it before hydration reaches this node. */}
            <div
              id="tuner-boot-log"
              suppressHydrationWarning
              style={{ display: "none", fontSize: 11, fontFamily: "var(--font-mono)", padding: "8px 10px", marginBottom: 12, borderRadius: "var(--radius-control)", border: "1px solid color-mix(in srgb, var(--status-error) 45%, transparent)", background: "color-mix(in srgb, var(--status-error) 8%, transparent)", color: "var(--status-error)", overflowWrap: "anywhere" }}
            />
            <script dangerouslySetInnerHTML={{ __html: BOOT_DIAGNOSTIC }} />
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 16px" }}>
              The feed below arrives in deliberately ugly network patterns; the pacer and the motion
              knobs decide what you actually see. Judge with your eyes, then save.
            </p>
            {prefersReducedMotion && (
              <p style={{ fontSize: 12, padding: "8px 10px", borderRadius: "var(--radius-control)", border: "1px solid color-mix(in srgb, var(--status-warning) 45%, transparent)", background: "color-mix(in srgb, var(--status-warning) 8%, transparent)", color: "var(--status-warning)" }}>
                Your OS has reduce-motion enabled — pacing and entrance animations are disabled
                app-wide, so this playground will show instant text.
              </p>
            )}
            {pageError !== null && (
              <p style={{ fontSize: 12, padding: "8px 10px", borderRadius: "var(--radius-control)", border: "1px solid color-mix(in srgb, var(--status-error) 45%, transparent)", background: "color-mix(in srgb, var(--status-error) 8%, transparent)", color: "var(--status-error)", overflowWrap: "anywhere" }}>
                Page error: {pageError}
              </p>
            )}
            {message !== null && (
              <MessageView
                message={message}
                isStreaming={running}
                toolResults={toolResults}
                modelNames={{ "simulator:playground": "Stream Tuner" }}
                toolCallsDefaultCollapsed={!expandTools}
                thinkingDefaultExpanded
              />
            )}
            {message === null && (
              <p style={{ fontSize: 13, color: "var(--text-dim)" }}>The scripted turn starts automatically once the page is ready.</p>
            )}
          </div>
        </div>

        {/* ── Control panel ── */}
        <div style={{ width: 320, flexShrink: 0, overflowY: "auto", padding: "20px 16px", borderLeft: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <SectionTitle>Simulated network</SectionTitle>
          <select
            value={pattern}
            onChange={(e) => setPattern(e.currentTarget.value as FeedPattern)}
            style={{ width: "100%", marginBottom: 8, padding: "5px 6px", fontSize: 12, borderRadius: "var(--radius-control)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
          >
            {FEED_PATTERNS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <Knob label="Speed" unit="×" value={speed} min={0.25} max={4} step={0.25} onChange={setSpeed} />
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <button
              onClick={running ? stop : start}
              style={{ ...BUTTON_BASE, flex: 1, background: "var(--accent)", borderColor: "var(--accent)", color: "var(--on-accent)", fontWeight: 500 }}
            >
              {running ? "Stop" : message === null ? "Start" : "Restart"}
            </button>
            <label style={{ ...BUTTON_BASE, display: "flex", alignItems: "center", gap: 5 }}>
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.currentTarget.checked)} style={{ accentColor: "var(--accent)" }} />
              Loop
            </label>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            <input type="checkbox" checked={expandTools} onChange={(e) => setExpandTools(e.currentTarget.checked)} style={{ accentColor: "var(--accent)" }} />
            Expand tool calls (watch input stream)
          </label>
          {/* Arrival strip: what the network actually delivered, per chunk. */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 40, padding: "2px 4px", borderRadius: "var(--radius-control)", background: "var(--bg)", border: "1px solid var(--border)" }}>
            {stats.bars.map((chars, i) => (
              <div key={`${stats.chunks - stats.bars.length + i}`} style={{ flex: 1, minWidth: 1, height: Math.max(2, Math.min(36, chars / 8)), background: chars > 100 ? "var(--status-warning)" : "var(--accent)", borderRadius: 1 }} />
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", margin: "4px 0 0", fontFamily: "var(--font-mono)" }}>
            {stats.chunks} chunks · {stats.chars} ch · max {stats.maxChunk} ch
          </div>

          <SectionTitle>Pacing (reveal engine)</SectionTitle>
          {NUMERIC_KNOBS.filter((k) => k.group === "pacer").map((k) => knob(k.key, k.label, k.unit))}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
            <input type="checkbox" checked={draft.paceToolInput} onChange={(e) => setField("paceToolInput", e.currentTarget.checked)} style={{ accentColor: "var(--accent)" }} />
            Pace tool-call input &amp; header preview
          </label>

          <SectionTitle>Motion (CSS)</SectionTitle>
          {NUMERIC_KNOBS.filter((k) => k.group === "motion").map((k) => knob(k.key, k.label, k.unit))}
          <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
            Easing
            <select
              value={draft.easing}
              onChange={(e) => setField("easing", e.currentTarget.value)}
              style={{ width: "100%", marginTop: 4, padding: "5px 6px", fontSize: 12, borderRadius: "var(--radius-control)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
            >
              {STREAM_EASING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>

          <SectionTitle>Apply</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              onClick={handleSave}
              style={{ ...BUTTON_BASE, background: "var(--accent)", borderColor: "var(--accent)", color: "var(--on-accent)", fontWeight: 500 }}
            >
              {savedFlash ? "Saved — live chats updated" : "Save as app default"}
            </button>
            <button onClick={() => setDraft(getStreamTuning())} style={BUTTON_BASE}>
              Revert to saved
            </button>
            <button onClick={() => setDraft(DEFAULT_STREAM_TUNING)} style={BUTTON_BASE}>
              Reset to factory defaults
            </button>
            <button onClick={handleCopy} style={BUTTON_BASE}>
              {copyState === "copied" ? "Copied to clipboard ✓" : copyState === "manual" ? "Blocked — long-press the field below" : "Copy settings (JSON)"}
            </button>
          </div>
          {/* The JSON is always visible and selectable: the last-resort copy
              path on locked-down mobile browsers, and the paste target for
              applying settings someone sent you. */}
          <input
            value={settingsText === "" ? settingsJson : settingsText}
            onChange={(e) => setSettingsText(e.currentTarget.value)}
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            aria-label="Settings JSON"
            style={{ width: "100%", marginTop: 6, padding: "5px 6px", fontSize: 10, fontFamily: "var(--font-mono)", borderRadius: "var(--radius-control)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)" }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button onClick={handleApplySettings} disabled={settingsText === ""} style={{ ...BUTTON_BASE, flex: 1, opacity: settingsText === "" ? 0.5 : 1 }}>
              Apply pasted JSON
            </button>
            <button onClick={() => setSettingsText("")} disabled={settingsText === ""} style={{ ...BUTTON_BASE, opacity: settingsText === "" ? 0.5 : 1 }}>
              Clear
            </button>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, marginTop: 10 }}>
            Knobs apply to this preview immediately{isDefaultStreamTuning(draft) ? " (currently at defaults)" : ""}.
            Saving persists them for the whole app; open chats pick the change up without a reload.
          </p>
        </div>
      </div>
    </StreamTuningProvider>
  );
}
