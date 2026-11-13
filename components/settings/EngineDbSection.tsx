"use client";

/**
 * Settings › System › Engine database: whether the engine's own store (saved
 * logins, settings, caches) is healthy, when Cody last checked, what it last
 * repaired, and buttons to check or repair now.
 *
 * Cody checks by itself every six hours and repairs damage that is confined to
 * data the engine refills; this card is where the owner sees that, and where
 * damage Cody will not touch (logins, settings) is explained. Builds against
 * `GET/POST /api/engine-db` (admin-only on the server); another engine answers
 * `unsupported` and the card hides. English-only, like the rest of the dialog.
 */
import { Database, Loader2, ShieldCheck, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { formatRelativeTime } from "@/lib/format";
import type { EngineDbStatus } from "@/lib/omp/engine-db";
import { ErrorNote, requestJson, smallButtonStyle } from "./account-controls";
import { cardStyle, cardTitleStyle, dimLineStyle, LoadingLine, mutedLineStyle } from "./EngineRoster";

export const ENGINE_DB_ROUTE = "/api/engine-db";

/** The one line that says how the store is, in plain words. */
export function engineDbHeadline(status: EngineDbStatus): { tone: "ok" | "warn" | "bad"; text: string } {
  const check = status.lastCheck;
  if (!check) return { tone: "warn", text: "Not checked yet. Cody checks a minute after it starts and every six hours." };
  if (check.verdict === "ok") return { tone: "ok", text: "Healthy." };
  if (check.verdict === "absent") return { tone: "ok", text: "The engine has not created its database yet." };
  if (check.verdict === "derived") {
    return { tone: "warn", text: `Damaged, but only in data the engine refills by itself (${check.tables.join(", ")}). Your logins and settings are fine. Repair it to fix stale usage numbers.` };
  }
  if (check.verdict === "critical") {
    return { tone: "bad", text: `Damaged in a part that holds logins or settings${check.tables.length > 0 ? ` (${check.tables.join(", ")})` : ""}. Cody will not repair this by itself, because a repair could lose a saved login.` };
  }
  return { tone: "bad", text: "Cody could not read the database at all." };
}

const TONE_COLOR = { ok: "var(--status-success)", warn: "var(--status-warning)", bad: "var(--status-error)" } as const;

export function EngineDbSection() {
  const route = useSettingsRoute<EngineDbStatus>(ENGINE_DB_ROUTE);
  const status = route.data ?? null;
  const [busy, setBusy] = useState<"check" | "repair" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Checked 3 hours ago" needs a clock; it ticks once a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (route.unsupported) return null;

  const run = (action: "check" | "repair") => {
    setBusy(action);
    setError(null);
    void requestJson<EngineDbStatus>(ENGINE_DB_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) })
      .then((next) => {
        setSettingsRouteData<EngineDbStatus>(ENGINE_DB_ROUTE, next);
        setNow(Date.now());
        const verdict = next.lastCheck?.verdict;
        if (action === "repair" && next.lastRepair?.outcome === "repaired") toast.success("Engine database repaired", "Your logins and settings were not touched.");
        else if (action === "repair" && verdict !== "ok") toast.error("The repair did not go through", next.lastRepair?.reason);
        else if (verdict === "ok") toast.success("Engine database is healthy");
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(null));
  };

  const headline = status ? engineDbHeadline(status) : null;
  const check = status?.lastCheck ?? null;
  const repair = status?.lastRepair ?? null;
  const checkedAgo = check ? formatRelativeTime(new Date(check.at).toISOString(), "en", Math.max(now, check.at)) : null;
  const repairedAgo = repair ? formatRelativeTime(new Date(repair.at).toISOString(), "en", Math.max(now, repair.at)) : null;

  return (
    <section data-search-id="engine-database" aria-label="Engine database" style={{ ...cardStyle, minWidth: 0 }}>
      <div style={cardTitleStyle}>
        <Database size={13} aria-hidden="true" />
        Engine database
      </div>
      <div style={mutedLineStyle}>
        Where the engine keeps your saved logins, settings and cached usage numbers. Cody checks it every six hours and repairs damage to cached data by itself.
      </div>

      {route.loading && !status && <LoadingLine label="Reading the last check…" />}
      {route.error && !status && <ErrorNote message={route.error} />}

      {headline && (
        <div role="status" style={{ fontSize: 12, color: TONE_COLOR[headline.tone], overflowWrap: "anywhere" }}>
          {headline.text}
        </div>
      )}
      {checkedAgo && <div style={dimLineStyle}>Last checked {checkedAgo}.</div>}
      {repair && repairedAgo && (
        <div style={dimLineStyle}>
          {repair.outcome === "repaired"
            ? `Repaired ${repairedAgo}${repair.rebuilt && repair.rebuilt.length > 0 ? `: rebuilt ${repair.rebuilt.map((row) => `${row.table} (${row.kept.toLocaleString("en-US")} rows kept)`).join(", ")}` : ""}.`
            : repair.outcome === "failed"
              ? `A repair ${repairedAgo} did not go through${repair.reason ? `: ${repair.reason}` : ""}. Nothing was changed.`
              : repair.outcome === "refused"
                ? `A repair ${repairedAgo} was refused: ${repair.reason ?? "the damage reaches logins or settings."}`
                : null}
          {status && status.backups > 0 ? ` ${status.backups} backup${status.backups === 1 ? "" : "s"} kept.` : ""}
        </div>
      )}
      {status?.engineAtRisk && (
        <div style={{ fontSize: 12, color: "var(--status-warning)" }}>
          This server&apos;s omp ({status.engineVersion}) is older than 18.16.0, which fixed a fault that can damage this database. Update the engine below.
        </div>
      )}
      {check?.verdict === "critical" && check.sample.length > 0 && (
        <details style={dimLineStyle}>
          <summary>What the check found</summary>
          <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{check.sample.join("\n")}</div>
        </details>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="ui-focus-ring" onClick={() => run("check")} disabled={busy !== null} aria-busy={busy === "check"} style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}>
          {busy === "check" ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}
          Check now
        </button>
        {check?.verdict === "derived" && (
          <button type="button" className="ui-focus-ring" onClick={() => run("repair")} disabled={busy !== null} aria-busy={busy === "repair"} style={{ ...smallButtonStyle, opacity: busy ? 0.6 : 1 }}>
            {busy === "repair" ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />}
            Repair now
          </button>
        )}
      </div>
      <ErrorNote message={error} />
    </section>
  );
}
