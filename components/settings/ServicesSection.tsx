"use client";

/**
 * Settings › System › Services: background processes the agent started (dev
 * servers, watchers). From omp 18.18.9 they keep running after the chat's
 * engine exits, so this is where they can be seen and stopped.
 *
 * Builds against `GET/POST /api/services` (admin-only on the server). A server
 * whose engine has no such command answers `unsupported` and the card hides.
 * English-only, like the rest of the settings dialog.
 */
import { Loader2, Server, Square } from "lucide-react";
import { useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { toast } from "@/components/ui/toast";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { formatRelativeTime } from "@/lib/format";
import type { ServiceRow } from "@/lib/omp/services";
import { ErrorNote, requestJson, smallButtonStyle } from "./account-controls";
import { cardStyle, cardTitleStyle, dimLineStyle, LoadingLine, mutedLineStyle } from "./EngineRoster";
import { SettingsHighlightContext } from "./primitives";

export const SERVICES_ROUTE = "/api/services";

const RING_STYLE = { boxShadow: "0 0 0 2px var(--accent)", borderColor: "var(--accent)" } as const;

interface ServicesPayload {
  services: ServiceRow[];
}

const rowKey = (row: ServiceRow) => `${row.scope ?? row.projectDir ?? ""}\u0000${row.name}`;

const commandStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 11,
  color: "var(--text-muted)",
  overflowWrap: "anywhere",
};

export function ServicesSection({ initial }: { initial?: ServicesPayload } = {}) {
  const route = useSettingsRoute<ServicesPayload>(SERVICES_ROUTE);
  const payload = route.data ?? initial ?? null;

  const highlightId = useContext(SettingsHighlightContext);
  const cardRef = useRef<HTMLElement | null>(null);
  const highlighted = highlightId === "services";
  useEffect(() => {
    if (highlighted) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [payload]);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (route.unsupported) return null;

  const stop = (row: ServiceRow, action: "stop" | "kill") => {
    setBusyKey(rowKey(row));
    setError(null);
    void requestJson<ServicesPayload>(SERVICES_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, name: row.name, projectDir: row.projectDir, scope: row.scope }),
    })
      .then((next) => {
        setSettingsRouteData<ServicesPayload>(SERVICES_ROUTE, next);
        toast.success(action === "kill" ? `Killed ${row.name}` : `Stopped ${row.name}`);
      })
      .catch((failure: unknown) => {
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message);
        toast.error(`Could not stop ${row.name}`, message);
      })
      .finally(() => setBusyKey(null));
  };

  const services = payload?.services ?? [];

  return (
    <section
      ref={cardRef}
      data-search-id="services"
      aria-label="Background services"
      style={{ ...cardStyle, minWidth: 0, transition: "box-shadow var(--dur-fast), border-color var(--dur-fast)", ...(highlighted ? RING_STYLE : {}) }}
    >
      <div style={cardTitleStyle}>
        <Server size={13} aria-hidden="true" />
        Background services
      </div>
      <div style={mutedLineStyle}>
        Dev servers and watchers the agent started. They keep running after the chat ends, so stop the ones you no longer need.
      </div>

      {route.loading && !payload && <LoadingLine label="Reading running services…" />}
      {route.error && !payload && <ErrorNote message={route.error} />}

      {payload && (services.length === 0
        ? <div style={dimLineStyle}>No background services are running.</div>
        : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {services.map((row) => {
              const busy = busyKey === rowKey(row);
              const started = row.startedAt === null ? null : formatRelativeTime(new Date(row.startedAt).toISOString(), "en", now);
              return (
                <li key={rowKey(row)} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
                    <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>
                      {row.name}
                      <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> · {row.state}{started ? ` · started ${started}` : ""}</span>
                    </span>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        type="button"
                        className="ui-focus-ring"
                        onClick={() => stop(row, "stop")}
                        disabled={busy}
                        aria-busy={busy}
                        style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}
                      >
                        {busy ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
                        Stop
                      </button>
                      <button
                        type="button"
                        className="ui-focus-ring"
                        onClick={() => stop(row, "kill")}
                        disabled={busy}
                        title="Ends it immediately without waiting for it to shut down"
                        style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}
                      >
                        Kill
                      </button>
                    </span>
                  </div>
                  <span style={dimLineStyle}>
                    {row.scope ? `Machine-wide service “${row.scope}”` : row.projectDir}
                    {row.internal ? " · run by the engine itself" : ""}
                  </span>
                  {row.command && <span style={commandStyle}>{row.command}</span>}
                </li>
              );
            })}
          </ul>
        ))}

      <ErrorNote message={error} />
    </section>
  );
}
