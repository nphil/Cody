"use client";
import { useState } from "react";

/** Crossfades the live status text above the composer. The label swaps
 * abruptly many times per run ("Waiting for model…" → "Running bash…" →
 * subagent counts), which reads as flicker on a line the eye is already
 * watching. The outgoing text stays stacked under the incoming one (same
 * grid cell) just long enough to fade out — compositor-only opacity +
 * transform, and the global prefers-reduced-motion block collapses both
 * animations to instant. */
export function StatusTextCrossfade({ text }: { text: string }) {
  const [swap, setSwap] = useState<{ text: string; prev: string | null; gen: number }>({ text, prev: null, gen: 0 });
  // Derived state during render, not an effect: the swap must land in the
  // same commit as the text change or the old label flashes for a frame.
  if (text !== swap.text) {
    setSwap((s) => ({ text, prev: s.text, gen: s.gen + 1 }));
  }
  return (
    <span className="chat-status-swap">
      {swap.prev !== null && (
        <span
          key={`out-${swap.gen}`}
          aria-hidden
          className="chat-status-swap-out"
          // Drop the ghost once faded so stale text never lingers for
          // find-in-page or when animations are disabled mid-flight.
          onAnimationEnd={() => setSwap((s) => (s.gen === swap.gen ? { ...s, prev: null } : s))}
        >
          {swap.prev}
        </span>
      )}
      <span key={`in-${swap.gen}`} className="chat-status-swap-in">{swap.text}</span>
    </span>
  );
}
