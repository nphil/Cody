"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import type { WordSuggestion } from "@/lib/word-completion";

/** Computed styles that decide where a glyph lands in a textarea. The overlay
 * copies every one of them so it wraps — and scrolls — identically. */
const MIRRORED_STYLES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch",
  "fontKerning", "fontFeatureSettings", "fontVariationSettings",
  "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
] as const;

interface Props {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  suggestion: WordSuggestion;
  /** Called with the suggestion when it is fully visible on its line, or null
   * when the line has no room left for it. */
  onFit: (fitting: WordSuggestion | null) => void;
  /** False while the overlay is only being measured, or when it did not fit. */
  visible: boolean;
}

/**
 * The dimmed completion drawn after the caret. A textarea cannot hold styled
 * inline text, so this is a transparent twin of it laid exactly on top: the
 * same text wraps the same way, and the ghost sits at the caret's own
 * position inside it. It takes no pointer events and is hidden from screen
 * readers (the textarea stays the only real content). The ghost is positioned
 * out of flow, so the twin's wrapping — and therefore the alignment
 * with the real text — never depends on whether the suggestion is showing.
 */
export function ComposerGhostText({ textareaRef, suggestion, visible, onFit }: Props) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);

  // Re-measured whenever the suggestion changes; the next keystroke removes
  // the overlay, so there is no resize or scroll tracking to keep alive
  // beyond the scroll listener below.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    const ghost = ghostRef.current;
    if (!ta || !mirror || !ghost) return;
    const computed = getComputedStyle(ta);
    for (const key of MIRRORED_STYLES) mirror.style[key] = computed[key];
    // The textarea's scrollbar (when it overflows) narrows its text column,
    // and `clientWidth` is the width without it.
    const borderX = parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
    mirror.style.width = `${ta.clientWidth + borderX}px`;
    mirror.style.height = `${ta.offsetHeight}px`;
    mirror.scrollTop = ta.scrollTop;
    const columnRight = mirror.getBoundingClientRect().left + mirror.clientWidth - parseFloat(computed.paddingRight);
    const ghostRight = ghost.getBoundingClientRect().right;
    onFit(ghostRight <= columnRight + 0.5 ? suggestion : null);
    const onScroll = () => { mirror.scrollTop = ta.scrollTop; };
    ta.addEventListener("scroll", onScroll);
    return () => ta.removeEventListener("scroll", onScroll);
  }, [suggestion, textareaRef, onFit]);

  const { text, cursor, suffix } = suggestion;
  return (
    <div
      ref={mirrorRef}
      aria-hidden="true"
      data-testid="composer-ghost-text"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        boxSizing: "border-box",
        borderStyle: "solid",
        borderColor: "transparent",
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        color: "transparent",
        pointerEvents: "none",
        visibility: visible ? "visible" : "hidden",
        userSelect: "none",
      }}
    >
      {text.slice(0, cursor)}
      <span style={{ position: "relative" }}>
        <span ref={ghostRef} style={{ position: "absolute", whiteSpace: "nowrap", color: "var(--text-dim)" }}>{suffix}</span>
      </span>
      {text.slice(cursor)}
    </div>
  );
}
