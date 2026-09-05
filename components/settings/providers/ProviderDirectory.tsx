"use client";

/**
 * Settings › Providers: the directory. Section Connected (status-first: signed
 * in › key saved in Cody › key from the container › local / custom), each
 * row a brand tile, the winning method, the model count and a missing-
 * variable hint; section Discovered (local runtimes the server can see, from
 * `useLocalAiScan`); then one "+ Add provider". Members read; admins act.
 *
 * Every nested surface is a Drawer: the detail (a side drawer on a desktop,
 * a pushed level on a phone), the Add picker and the local-endpoint form.
 * A change anywhere ends in `invalidateProviderReads()`, and this list
 * re-reads through the settings route cache.
 */
import { AlertCircle, ArrowDown, ArrowUp, Check, Copy, Cpu, Loader2, Plus, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useConfigWriter } from "@/hooks/useConfigWriter";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { runtimeEndpointUrl, runtimeLabel, runtimeProviderName, useLocalAiScan, type LocalAiScanResult } from "@/hooks/useLocalAiScan";
import { useSettingsRoute } from "@/hooks/useSettingsData";
import { sortConnectedRows, type ProviderRow, type ProvidersResponse } from "@/lib/provider-directory";
import { Directory, type DirectoryRow, type DirectorySection } from "../Directory";
import { Drawer } from "../Drawer";
import { chipStyle } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";
import { AddProviderPicker, type PickChoice } from "./AddProviderPicker";
import { buttonStyle, describeModels, describeWinning, invalidateProviderReads, missingOptionalHint, primaryButtonStyle, ProviderTile, quietButtonStyle } from "./controls";
import { LocalEndpointForm } from "./LocalEndpointForm";
import { PROVIDERS_PANEL_ID, ProviderDetail } from "./ProviderDetail";

export const PROVIDERS_ROUTE = "/api/providers";

interface DetailTarget {
  id: string;
  loginId?: string | null;
  autoStart?: boolean;
}

/** A button inside a row that is itself a button: neither click nor Enter
 * may bubble into the row's open. */
function stopRow(event: MouseEvent | KeyboardEvent) {
  event.stopPropagation();
}

const rowButton = { ...quietButtonStyle, padding: "4px 6px", minHeight: 28 } as const;

function CopyUrlButton({ url }: { url: string }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <button type="button" className="ui-focus-ring" onClick={() => copy(url)} aria-label={`Copy base URL ${url}`} style={buttonStyle}>
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      {copied ? "Copied" : "Copy URL"}
    </button>
  );
}

export function ProviderDirectory() {
  const { capabilities, engine, isMobile, platform, harnessLabel } = useSettingsShell();
  const providers = useSettingsRoute<ProvidersResponse>(PROVIDERS_ROUTE);
  const scan = useLocalAiScan(true);
  const writer = useConfigWriter();
  const { track } = useSaveStatus(PROVIDERS_PANEL_ID);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [endpointForm, setEndpointForm] = useState<{ name?: string; baseUrl?: string } | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);

  const response = providers.data;
  const shortName = response?.engine.shortName ?? engine?.shortName ?? harnessLabel;
  const rows = useMemo(() => response?.providers ?? [], [response]);
  const connected = useMemo(() => sortConnectedRows(rows), [rows]);
  const canEdit = response?.canEdit ?? false;
  const readOnly = response?.instanceSource === "readonly";
  const canReorder = engine?.id === "omp" && capabilities.configEditor && canEdit && !readOnly && connected.length > 1;
  const canAddCustom = capabilities.models;

  const detailRow = detail ? rows.find((row) => row.id === detail.id) ?? null : null;
  // The row the drawer shows can vanish under it (removed, or the engine
  // switched); the drawer closes rather than rendering a ghost.
  useEffect(() => {
    if (detail && response && !detailRow) setDetail(null);
  }, [detail, detailRow, response]);

  const reload = useCallback(() => {
    invalidateProviderReads();
  }, []);
  // Stable closers: on a phone a Drawer registers a level with the shell in
  // an effect keyed on its `onClose`, and a fresh arrow per render would
  // re-register on every render — which re-renders the shell, forever.
  const closeDetail = useCallback(() => setDetail(null), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const closeEndpointForm = useCallback(() => setEndpointForm(null), []);

  const enable = async (row: ProviderRow) => {
    setEnableError(null);
    try {
      for (const id of row.catalogIds) {
        const result = await fetch("/api/providers/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: id }) });
        const body = await result.json().catch(() => null) as { error?: string } | null;
        if (!result.ok || body?.error) throw new Error(body?.error || `HTTP ${result.status}`);
      }
      reload();
    } catch (failure) {
      setEnableError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= connected.length) return;
    const next = [...connected];
    [next[index], next[target]] = [next[target], next[index]];
    // The engine's order names its own provider ids; a row's ids move as one.
    const ordered = next.flatMap((row) => row.catalogIds);
    void track(() => writer.patchTop({ modelProviderOrder: ordered }).then(reload));
  };

  const pick = (choice: PickChoice) => {
    setPickerOpen(false);
    setDetail({ id: choice.row.id, loginId: choice.loginId ?? null, autoStart: Boolean(choice.loginId) });
  };

  const connectedRows: DirectoryRow[] = connected.map((row, index) => {
    const status = describeWinning(row, shortName);
    const parts = [describeModels(row), missingOptionalHint(row)].filter((part): part is string => Boolean(part));
    return {
      id: row.id,
      icon: <ProviderTile brand={row.brand} />,
      title: <span data-search-id={`provider-${row.id}`}>{row.name}</span>,
      status: { tone: status.tone, text: status.text },
      subtitle: parts.length > 0 ? parts.join(" · ") : row.reason ?? undefined,
      trailing: (
        <>
          {row.disabled && canEdit && (
            <button type="button" className="ui-focus-ring" onClick={(event) => { stopRow(event); void enable(row); }} onKeyDown={stopRow} disabled={readOnly} style={rowButton}>Enable</button>
          )}
          {canReorder && (
            <>
              <button type="button" className="ui-focus-ring" aria-label={`Move ${row.name} up`} disabled={index === 0} onClick={(event) => { stopRow(event); move(index, -1); }} onKeyDown={stopRow} style={{ ...rowButton, opacity: index === 0 ? 0.35 : 1 }}><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" className="ui-focus-ring" aria-label={`Move ${row.name} down`} disabled={index === connected.length - 1} onClick={(event) => { stopRow(event); move(index, 1); }} onKeyDown={stopRow} style={{ ...rowButton, opacity: index === connected.length - 1 ? 0.35 : 1 }}><ArrowDown size={14} aria-hidden="true" /></button>
            </>
          )}
        </>
      ),
      onOpen: () => setDetail({ id: row.id }),
    };
  });

  const configuredEndpoints = rows.filter((row) => row.endpoint?.baseUrl).map((row) => ({ row, host: row.endpoint!.baseUrl!.replace(/\/v1\/?$/, "").replace(/\/+$/, "") }));
  const discoveredRows: DirectoryRow[] = scan.results.map((result: LocalAiScanResult) => {
    const configured = configuredEndpoints.find((entry) => entry.host === result.baseUrl.replace(/\/+$/, ""));
    const url = runtimeEndpointUrl(result);
    return {
      id: `${result.origin}-${result.baseUrl}`,
      icon: <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-subtle)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "var(--text-muted)" }}><Server size={15} /></span>,
      title: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{runtimeLabel(result)}{result.origin === "host" && <span style={chipStyle}>host</span>}</span>,
      status: result.error ? { tone: "warn", text: result.error } : { tone: "ok", text: `Found at ${result.baseUrl}` },
      subtitle: result.error ? undefined : result.models.length > 0 ? `${result.models.length} model${result.models.length === 1 ? "" : "s"}` : "Running, but no models are loaded yet",
      actions: configured
        ? <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Configured as {configured.row.name}</span>
        : canAddCustom && canEdit
          ? <button type="button" className="ui-focus-ring" onClick={() => setEndpointForm({ name: runtimeProviderName(result), baseUrl: url })} style={buttonStyle}><Plus size={12} aria-hidden="true" /> Add</button>
          : <CopyUrlButton url={url} />,
    };
  });

  const sections: DirectorySection[] = [
    {
      id: "connected",
      title: "Connected",
      rows: connectedRows,
      // Nothing read yet (the fetch effect has not run, or is in flight) is
      // a loading state, never the empty state: the empty copy is a warning.
      empty: !response && !providers.error
        ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Loader2 size={13} className="icon-spin" aria-hidden="true" /> Reading providers…</span>
        : providers.error
          ? <span style={{ color: "var(--status-error)" }}>{providers.error}</span>
          : <span style={{ color: "var(--status-warning)" }}>{shortName} cannot answer a prompt until a provider is connected.</span>,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Providers</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", maxWidth: "62ch" }}>
          How {shortName} reaches a model vendor: a subscription signed in with its own login, an API key saved here and handed to every engine, or a local endpoint.{!canEdit && response && " Only an administrator can change them."}
        </p>
      </div>

      {readOnly && (
        <div role="status" style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>
          <AlertCircle size={14} aria-hidden="true" style={{ flexShrink: 0, color: "var(--status-warning)", marginTop: 1 }} />
          <span><span style={{ ...chipStyle, color: "var(--status-warning)", marginRight: 6 }}>Read-only</span>{response?.readonlyReason}</span>
        </div>
      )}
      {enableError && <div role="alert" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--status-error)" }}><AlertCircle size={13} aria-hidden="true" />{enableError}</div>}

      <Directory sections={sections} ariaLabel="Connected providers" />

      <div data-search-id="add-provider" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="ui-focus-ring" onClick={() => setPickerOpen(true)} disabled={!response} style={{ ...primaryButtonStyle, opacity: response ? 1 : 0.6 }}>
          <Plus size={14} aria-hidden="true" /> Add provider
        </button>
        {response && !canEdit && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Browsing only — an administrator connects providers.</span>}
      </div>

      <section data-search-id="discovered-runtimes" aria-label="Discovered" style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h4 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>Discovered</h4>
          <button type="button" className="ui-focus-ring" onClick={scan.rescan} disabled={scan.scanning} style={{ ...quietButtonStyle, minHeight: 28, padding: "4px 8px" }}>
            {scan.scanning ? <Loader2 size={12} className="icon-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
            {scan.scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Ollama, LM Studio and llama.cpp / llama-swap on well-known ports where Cody itself runs{platform?.desktop ? ", plus the same ports on the Windows host" : ""}.
          {!canAddCustom && ` ${shortName} takes no custom endpoints from Cody; copy the URL into its own configuration.`}
        </p>
        {platform?.desktop && (
          <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, display: "flex", gap: 6, alignItems: "flex-start" }}>
            <Cpu size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
            <span>Windows-side runtimes must listen beyond localhost to be reachable here — Ollama: set <code style={{ fontFamily: "var(--font-mono)" }}>OLLAMA_HOST=0.0.0.0</code>. GPU details arrive once the desktop shell&apos;s GPU bridge lands.</span>
          </p>
        )}
        <Directory
          sections={[{
            id: "discovered",
            rows: discoveredRows,
            empty: !scan.scanned
              ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Loader2 size={13} className="icon-spin" aria-hidden="true" /> Scanning…</span>
              : scan.error
                ? <span style={{ color: "var(--status-error)" }}>{scan.error}</span>
                : "Nothing detected. Start Ollama, LM Studio or llama.cpp, then rescan.",
          }]}
          ariaLabel="Discovered runtimes"
        />
      </section>

      {detailRow && response && (
        <ProviderDetail
          key={detailRow.id}
          row={detailRow}
          response={response}
          open
          onClose={closeDetail}
          initialLoginId={detail?.loginId ?? null}
          autoStart={detail?.autoStart ?? false}
          onChanged={reload}
        />
      )}

      <Drawer open={pickerOpen} title="Add provider" presentation={isMobile ? "push" : "side"} onClose={closePicker} width={520} ariaLabel="Add provider">
        <AddProviderPicker
          rows={rows}
          discovered={scan.results}
          canAddCustom={canAddCustom && canEdit}
          onPick={pick}
          onAddCustom={() => { setPickerOpen(false); setEndpointForm({}); }}
        />
      </Drawer>

      <Drawer open={endpointForm !== null} title="Add local endpoint" presentation={isMobile ? "push" : "side"} onClose={closeEndpointForm} ariaLabel="Add local endpoint">
        {endpointForm && (
          <LocalEndpointForm
            initialName={endpointForm.name}
            initialBaseUrl={endpointForm.baseUrl}
            onSaved={(name) => {
              setEndpointForm(null);
              reload();
              setDetail({ id: name });
            }}
          />
        )}
      </Drawer>
    </div>
  );
}
