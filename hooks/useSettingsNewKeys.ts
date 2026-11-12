"use client";

/**
 * Which engine settings are "New" for the person who opened Settings, and the
 * two things that make a badge fade: seeing its chip and changing the setting.
 *
 * SettingsShell calls this once, and it is mounted only while Settings is
 * open, so one instance is one Settings open: it makes one `openId`, fetches
 * the answer once (`GET /api/settings-seen`), and every panel, the rail and
 * the search read that one answer through the context in
 * components/settings/new-badges.ts. The rules live on the server
 * (lib/settings-seen.ts); the batching and the "on screen long enough" logic
 * live in lib/settings-new-reporter.ts.
 *
 * A chip is never hidden because the server's count reached 3: that takes
 * effect at the NEXT open. Within this open it goes away only when the person
 * changes the setting, which every Settings write announces through
 * `subscribeSettingsWritten` (hooks/useConfigWriter.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SETTINGS_SEEN_ROUTE,
  createSeenReporter,
  newOpenId,
  parseNewKeysAnswer,
  type NewKeysAnswer,
  type SeenReporter,
} from "@/lib/settings-new-reporter";
import { subscribeSettingsWritten } from "./useConfigWriter";

export interface SettingsNewKeysState {
  /** The keys that are still "New" for this person in this open, changed ones removed. */
  newKeys: ReadonlySet<string>;
  isNew(key: string): boolean;
  /** The engine version that brought `key`; null when it is not known. */
  introducedIn(key: string): string | null;
  /** The chip of `key` was on screen long enough. Counted once per open. */
  reportSeen(key: string): void;
  /** `key` was changed: hides its badge at once and tells the server. */
  reportChanged(key: string): void;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** The state when nothing is badged: the default of the context, and what a disabled hook returns. */
export const NO_NEW_KEYS: SettingsNewKeysState = {
  newKeys: NO_KEYS,
  isNew: () => false,
  introducedIn: () => null,
  reportSeen: () => {},
  reportChanged: () => {},
};

interface LoadedAnswer {
  answer: NewKeysAnswer;
  keys: ReadonlySet<string>;
}

/** Send one report. `keepalive` lets the last one outlive the page that closed Settings. */
async function postReport(report: { openId: string; seen?: string[]; changed?: string[] }, options: { keepalive: boolean }): Promise<boolean> {
  try {
    const response = await fetch(SETTINGS_SEEN_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: options.keepalive,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * @param enabled   the engine has a settings schema to badge (`capabilities.nativeSettings`).
 * @param engineId  the active engine: a different one is a different set of settings, so the answer is read again.
 */
export function useSettingsNewKeys({ enabled, engineId }: { enabled: boolean; engineId: string | null }): SettingsNewKeysState {
  const [openId] = useState(newOpenId);
  const [loaded, setLoaded] = useState<LoadedAnswer | null>(null);
  const [changed, setChanged] = useState<ReadonlySet<string>>(NO_KEYS);
  const loadedRef = useRef<LoadedAnswer | null>(null);
  const changedRef = useRef<ReadonlySet<string>>(NO_KEYS);
  const reporterRef = useRef<SeenReporter | null>(null);

  // One reporter per open and engine; closing Settings (or switching engine)
  // sends what is still waiting.
  useEffect(() => {
    if (!enabled) return undefined;
    const reporter = createSeenReporter(openId, {
      send: postReport,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as number),
    });
    reporterRef.current = reporter;
    return () => {
      reporter.dispose();
      if (reporterRef.current === reporter) reporterRef.current = null;
    };
  }, [enabled, engineId, openId]);

  // The answer is read once per open, not polled: a chip must not disappear
  // from under the cursor because the count reached 3 while Settings was open.
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    loadedRef.current = null;
    changedRef.current = NO_KEYS;
    setLoaded(null);
    setChanged(NO_KEYS);
    fetch(SETTINGS_SEEN_ROUTE, { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const answer = parseNewKeysAnswer(body);
        if (!answer || controller.signal.aborted) return;
        const next: LoadedAnswer = { answer, keys: new Set(answer.keys) };
        loadedRef.current = next;
        setLoaded(next);
        // A setting changed before the answer came in is changed all the same.
        for (const key of answer.keys) if (changedRef.current.has(key)) reporterRef.current?.changed(key);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled, engineId]);

  const reportSeen = useCallback((key: string) => {
    const current = loadedRef.current;
    if (!current?.keys.has(key) || changedRef.current.has(key)) return;
    reporterRef.current?.seen(key);
  }, []);

  const reportChanged = useCallback((key: string) => {
    const current = loadedRef.current;
    // Once the answer is known only a badged key matters; before that every
    // write is remembered, since it may turn out to be one.
    if (current && !current.keys.has(key)) return;
    if (changedRef.current.has(key)) return;
    const next = new Set(changedRef.current).add(key);
    changedRef.current = next;
    setChanged(next);
    if (current) reporterRef.current?.changed(key);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeSettingsWritten((keys) => {
      for (const key of keys) reportChanged(key);
    });
  }, [enabled, reportChanged]);

  const newKeys = useMemo<ReadonlySet<string>>(() => {
    if (!loaded) return NO_KEYS;
    if (changed.size === 0) return loaded.keys;
    return new Set([...loaded.keys].filter((key) => !changed.has(key)));
  }, [loaded, changed]);

  return useMemo<SettingsNewKeysState>(() => {
    if (!enabled) return NO_NEW_KEYS;
    return {
      newKeys,
      isNew: (key) => newKeys.has(key),
      introducedIn: (key) => loaded?.answer.since[key] ?? null,
      reportSeen,
      reportChanged,
    };
  }, [enabled, newKeys, loaded, reportSeen, reportChanged]);
}
