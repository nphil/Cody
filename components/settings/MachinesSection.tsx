"use client";

/**
 * Settings › System › Machines: which computers show CPU and memory meters in
 * the top bar. "This server" is always there (and can be renamed); any other
 * machine is one Cody reaches over ssh, named by an alias from `~/.ssh/config`
 * or `user@host`.
 *
 * The card builds against `GET/PUT /api/machines` and `POST /api/machines/test`.
 * `PUT` takes the whole ssh list as it should be afterwards, so adding, editing
 * and removing are all "send the list again, changed". Gating is by what the
 * API reports, so no control is shown that would fail: a member sees names
 * only (the server omits addresses from them), and a server without an ssh
 * program cannot add, edit or test.
 */
import { AlertCircle, Check, Loader2, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import {
  checkMachineDestination,
  checkMachineName,
  LOCAL_MACHINE_ID,
  MAX_MACHINES,
  MAX_NAME_LENGTH,
  type MachineConfig,
  type MachineFieldCode,
  type MachinesPayload,
  type MachinesUpdate,
  type MachineTestResult,
} from "@/lib/machines/types";
import { machineDisplayName, machineReasonKey, wholePercent } from "@/lib/machines/present";
import { dangerButtonStyle, primaryButtonStyle, smallButtonStyle } from "./account-controls";
import { cardStyle, cardTitleStyle, dimLineStyle, mutedLineStyle } from "./EngineRoster";
import { nativeInputStyle, SettingsHighlightContext } from "./primitives";

export const MACHINES_ROUTE = "/api/machines";
const TEST_ROUTE = "/api/machines/test";

const RING_STYLE = { boxShadow: "0 0 0 2px var(--accent)", borderColor: "var(--accent)" } as const;

// ── Requests ─────────────────────────────────────────────────────────────────

type SshEntry = { id?: string; name: string; destination: string };

async function putMachines(body: MachinesUpdate): Promise<MachinesPayload> {
  const response = await fetch(MACHINES_ROUTE, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatApiError(payload));
  return payload as MachinesPayload;
}

async function postTest(destination: string): Promise<MachineTestResult> {
  const response = await fetch(TEST_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destination }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatApiError(payload));
  return payload as MachineTestResult;
}

/** Undo of a removal. Reads the list as it is NOW and puts the machine back at its end, so nothing changed since (another tab, an edit) is lost. */
async function restoreMachine(entry: SshEntry): Promise<MachinesPayload> {
  const read = await fetch(MACHINES_ROUTE);
  const body = await read.json().catch(() => null);
  if (!read.ok || !body) throw new Error(formatApiError(body));
  const current = body as MachinesPayload;
  const list: SshEntry[] = current.machines
    .filter((machine) => machine.kind === "ssh")
    .map((machine) => ({ id: machine.id, name: machine.name, destination: machine.destination ?? "" }));
  return putMachines({ machines: [...list, entry] });
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** One in-flight test at a time per row or form; a newer run or a reset makes
 * an older answer irrelevant. */
function useMachineTest() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<MachineTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reset = useCallback(() => {
    seq.current += 1;
    setTesting(false);
    setResult(null);
    setError(null);
  }, []);

  const run = useCallback((destination: string) => {
    const mine = ++seq.current;
    setTesting(true);
    setResult(null);
    setError(null);
    void postTest(destination)
      .then((next) => { if (seq.current === mine) setResult(next); })
      .catch((failure: unknown) => { if (seq.current === mine) setError(messageOf(failure)); })
      .finally(() => { if (seq.current === mine) setTesting(false); });
  }, []);

  return { testing, result, error, run, reset };
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12, color: "var(--status-error)", minWidth: 0, overflowWrap: "anywhere" }}>
      <AlertCircle size={13} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

function TestOutcome({ result, error }: { result: MachineTestResult | null; error: string | null }) {
  const { t } = useI18n();
  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!result) return null;
  if (result.ok) {
    const memory = wholePercent(result.memPercent);
    return (
      <div role="status" style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12, color: "var(--status-success)", minWidth: 0 }}>
        <Check size={13} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ minWidth: 0 }}>
          {result.cpuPercent === null
            ? t("machines.settings.testOkNoCpu", { memory })
            : t("machines.settings.testOk", { cpu: wholePercent(result.cpuPercent), memory })}
        </span>
      </div>
    );
  }
  return (
    <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <ErrorLine>{t(machineReasonKey(result.reason))}</ErrorLine>
      {result.detail && (
        <div style={{ ...dimLineStyle, fontFamily: "var(--font-mono)", wordBreak: "break-all", paddingLeft: 19 }}>{result.detail}</div>
      )}
    </div>
  );
}

function TestButton({ testing, disabled, onClick, label }: { testing: boolean; disabled: boolean; onClick: () => void; label: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="ui-focus-ring"
      onClick={onClick}
      disabled={testing || disabled}
      aria-label={label}
      aria-busy={testing}
      style={{ ...smallButtonStyle, opacity: disabled && !testing ? 0.6 : 1 }}
    >
      {testing ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
      {t("machines.settings.test")}
    </button>
  );
}

function fieldMessage(code: MachineFieldCode): string {
  return formatApiError({ code });
}

// ── Add / edit form ──────────────────────────────────────────────────────────

function MachineForm({ existing, ssh, onCancel, onSaved }: {
  /** The saved machine this form edits, or null when it adds one. */
  existing: MachineConfig | null;
  /** The whole ssh list as saved now. */
  ssh: readonly SshEntry[];
  onCancel: () => void;
  onSaved: (payload: MachinesPayload) => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const [name, setName] = useState(existing?.name ?? "");
  const [destination, setDestination] = useState(existing?.destination ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [destinationTouched, setDestinationTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const test = useMachineTest();

  const checkedName = checkMachineName(name);
  const checkedDestination = checkMachineDestination(destination);
  const valid = checkedName.ok && checkedDestination.ok;

  const submit = () => {
    if (!checkedName.ok || !checkedDestination.ok) return;
    const entry: SshEntry = { ...(existing ? { id: existing.id } : {}), name: checkedName.value, destination: checkedDestination.value };
    const list = existing ? ssh.map((item) => (item.id === existing.id ? entry : item)) : [...ssh, entry];
    setBusy(true);
    setError(null);
    void putMachines({ machines: list })
      .then(onSaved)
      .catch((failure: unknown) => setError(messageOf(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 10, border: "1px solid var(--accent)", borderRadius: "var(--radius-card)", minWidth: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <label htmlFor={`${uid}-name`} style={{ fontSize: 12, fontWeight: 600 }}>{t("machines.settings.nameLabel")}</label>
        <input
          id={`${uid}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setNameTouched(true)}
          placeholder={t("machines.settings.namePlaceholder")}
          maxLength={MAX_NAME_LENGTH * 2}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={nameTouched && !checkedName.ok}
          style={{ ...nativeInputStyle, minWidth: 0, width: "100%", boxSizing: "border-box" }}
        />
        {nameTouched && !checkedName.ok && <ErrorLine>{fieldMessage(checkedName.code)}</ErrorLine>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <label htmlFor={`${uid}-address`} style={{ fontSize: 12, fontWeight: 600 }}>{t("machines.settings.addressLabel")}</label>
        <input
          id={`${uid}-address`}
          value={destination}
          onChange={(event) => {
            setDestination(event.target.value);
            test.reset();
          }}
          onBlur={() => setDestinationTouched(true)}
          placeholder={t("machines.settings.addressPlaceholder")}
          disabled={busy}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={destinationTouched && !checkedDestination.ok}
          style={{ ...nativeInputStyle, minWidth: 0, width: "100%", boxSizing: "border-box", fontFamily: "var(--font-mono)" }}
        />
        {destinationTouched && !checkedDestination.ok
          ? <ErrorLine>{fieldMessage(checkedDestination.code)}</ErrorLine>
          : <span style={dimLineStyle}>{t("machines.settings.addressHint")}</span>}
      </div>

      <TestOutcome result={test.result} error={test.error} />
      {error && <ErrorLine>{error}</ErrorLine>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <TestButton
          testing={test.testing}
          disabled={busy || !checkedDestination.ok}
          onClick={() => { if (checkedDestination.ok) test.run(checkedDestination.value); }}
          label={t("machines.settings.test")}
        />
        <button
          type="button"
          className="ui-focus-ring"
          onClick={submit}
          disabled={busy || !valid}
          style={{ ...primaryButtonStyle, opacity: busy || !valid ? 0.6 : 1 }}
        >
          {busy ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          {existing ? t("machines.settings.save") : t("machines.settings.add")}
        </button>
        <button type="button" className="ui-focus-ring" onClick={onCancel} disabled={busy} style={smallButtonStyle}>
          {t("machines.settings.cancel")}
        </button>
      </div>
    </div>
  );
}

// ── One ssh machine ──────────────────────────────────────────────────────────

function MachineRow({ machine, canEdit, sshAvailable, busy, onEdit, onRemove }: {
  machine: MachineConfig;
  canEdit: boolean;
  sshAvailable: boolean;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const test = useMachineTest();
  const destination = machine.destination;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 10, borderTop: "1px solid var(--border)", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        <div style={{ flex: "1 1 160px", minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 650, overflowWrap: "anywhere" }}>{machine.name}</div>
          {canEdit && destination && (
            <div style={{ ...dimLineStyle, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{destination}</div>
          )}
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {sshAvailable && destination && (
              <TestButton
                testing={test.testing}
                disabled={busy}
                onClick={() => test.run(destination)}
                label={t("machines.settings.testAria", { name: machine.name })}
              />
            )}
            {sshAvailable && (
              <button
                type="button"
                className="ui-focus-ring"
                onClick={onEdit}
                disabled={busy}
                aria-label={t("machines.settings.editAria", { name: machine.name })}
                style={smallButtonStyle}
              >
                <Pencil size={13} aria-hidden="true" />
                {t("machines.settings.edit")}
              </button>
            )}
            <button
              type="button"
              className="ui-focus-ring"
              onClick={onRemove}
              disabled={busy}
              aria-label={t("machines.settings.removeAria", { name: machine.name })}
              style={dangerButtonStyle}
            >
              <Trash2 size={13} aria-hidden="true" />
              {t("machines.settings.remove")}
            </button>
          </div>
        )}
      </div>
      <TestOutcome result={test.result} error={test.error} />
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

export function MachinesSection() {
  const { t } = useI18n();
  const uid = useId();
  const route = useSettingsRoute<MachinesPayload>(MACHINES_ROUTE);
  const payload = route.data;

  const highlightId = useContext(SettingsHighlightContext);
  const cardRef = useRef<HTMLElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const cardHighlighted = highlightId === "machines";
  const addHighlighted = highlightId === "add-machine";
  useEffect(() => {
    if (cardHighlighted) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [cardHighlighted]);
  useEffect(() => {
    if (addHighlighted) (addRef.current ?? cardRef.current)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [addHighlighted, payload]);

  const local = payload?.machines.find((machine) => machine.kind === "local" || machine.id === LOCAL_MACHINE_ID) ?? null;
  // This server's default name is stored in English; show it in the reader's language (a name they chose shows as typed).
  const savedLocalName = local ? machineDisplayName(local, t) : t("machines.defaultName");
  const [localName, setLocalName] = useState(savedLocalName);
  const [localTouched, setLocalTouched] = useState(false);
  useEffect(() => { setLocalName(savedLocalName); }, [savedLocalName]);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Never show a card for an API this server does not have.
  if (route.unsupported) return null;

  const canEdit = payload?.canEdit === true;
  const sshAvailable = payload?.sshAvailable === true;
  const machines = payload?.machines ?? [];
  const sshMachines = machines.filter((machine) => machine.kind === "ssh");
  const sshList: SshEntry[] = sshMachines.map((machine) => ({ id: machine.id, name: machine.name, destination: machine.destination ?? "" }));
  const atLimit = machines.length >= MAX_MACHINES;

  const checkedLocal = checkMachineName(localName);
  const localChanged = checkedLocal.ok && checkedLocal.value !== savedLocalName;

  const write = (body: MachinesUpdate, done?: () => void) => {
    setBusy(true);
    setError(null);
    void putMachines(body)
      .then((next) => {
        setSettingsRouteData(MACHINES_ROUTE, next);
        done?.();
      })
      .catch((failure: unknown) => setError(messageOf(failure)))
      .finally(() => setBusy(false));
  };

  const saveLocal = () => {
    if (!checkedLocal.ok || !localChanged) return;
    write({ localName: checkedLocal.value }, () => setLocalTouched(false));
  };

  const remove = (machine: MachineConfig) => {
    const gone: SshEntry = { name: machine.name, destination: machine.destination ?? "" };
    write({ machines: sshList.filter((item) => item.id !== machine.id) }, () => {
      toast.success(t("machines.settings.removed", { name: machine.name }), undefined, {
        durationMs: 8000,
        action: {
          label: t("machines.settings.undo"),
          onClick: () => {
            void restoreMachine(gone)
              .then((next) => setSettingsRouteData(MACHINES_ROUTE, next))
              .catch((failure: unknown) => toast.error(t("machines.settings.undoFailed", { name: gone.name }), messageOf(failure)));
          },
        },
      });
    });
  };

  return (
    <section
      ref={cardRef}
      data-search-id="machines"
      aria-label={t("machines.settings.title")}
      style={{ ...cardStyle, minWidth: 0, transition: "box-shadow var(--dur-fast), border-color var(--dur-fast)", ...(cardHighlighted ? RING_STYLE : {}) }}
    >
      <div style={cardTitleStyle}>
        <Server size={13} aria-hidden="true" />
        {t("machines.settings.title")}
      </div>
      <div style={mutedLineStyle}>{t("machines.settings.description")}</div>

      {route.loading && !payload && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", ...mutedLineStyle }}>
          <Loader2 size={13} className="icon-spin" aria-hidden="true" />
          {t("machines.settings.loading")}
        </div>
      )}
      {route.error && !payload && <ErrorLine>{route.error}</ErrorLine>}

      {payload && (
        <>
          {/* This server */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <label htmlFor={`${uid}-local`} style={{ fontSize: 12, fontWeight: 600 }}>{t("machines.settings.thisServer")}</label>
            {canEdit
              ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
                  <input
                    id={`${uid}-local`}
                    value={localName}
                    onChange={(event) => setLocalName(event.target.value)}
                    onBlur={() => setLocalTouched(true)}
                    onKeyDown={(event) => { if (event.key === "Enter") saveLocal(); }}
                    placeholder={t("machines.defaultName")}
                    maxLength={MAX_NAME_LENGTH * 2}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={localTouched && !checkedLocal.ok}
                    style={{ ...nativeInputStyle, flex: "1 1 160px", minWidth: 0, boxSizing: "border-box" }}
                  />
                  <button
                    type="button"
                    className="ui-focus-ring"
                    onClick={saveLocal}
                    disabled={busy || !localChanged}
                    style={{ ...smallButtonStyle, opacity: busy || !localChanged ? 0.6 : 1 }}
                  >
                    {busy && localChanged ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                    {t("machines.settings.save")}
                  </button>
                </div>
              )
              : <div id={`${uid}-local`} style={{ fontSize: 12.5, fontWeight: 650, overflowWrap: "anywhere" }}>{savedLocalName}</div>}
            {canEdit && localTouched && !checkedLocal.ok && <ErrorLine>{fieldMessage(checkedLocal.code)}</ErrorLine>}
            <span style={dimLineStyle}>{t("machines.settings.thisServerHint")}</span>
          </div>

          {/* ssh machines */}
          {sshMachines.length === 0 && !adding && <div style={dimLineStyle}>{t("machines.settings.none")}</div>}
          {sshMachines.map((machine) => (
            editingId === machine.id && canEdit && sshAvailable
              ? (
                <div key={machine.id} style={{ paddingTop: 10, borderTop: "1px solid var(--border)", minWidth: 0 }}>
                  <MachineForm
                    existing={machine}
                    ssh={sshList}
                    onCancel={() => setEditingId(null)}
                    onSaved={(next) => {
                      setEditingId(null);
                      setSettingsRouteData(MACHINES_ROUTE, next);
                    }}
                  />
                </div>
              )
              : (
                <MachineRow
                  key={machine.id}
                  machine={machine}
                  canEdit={canEdit}
                  sshAvailable={sshAvailable}
                  busy={busy}
                  onEdit={() => {
                    setAdding(false);
                    setEditingId(machine.id);
                  }}
                  onRemove={() => remove(machine)}
                />
              )
          ))}

          {error && <ErrorLine>{error}</ErrorLine>}

          {canEdit && sshAvailable && adding && (
            <MachineForm
              existing={null}
              ssh={sshList}
              onCancel={() => setAdding(false)}
              onSaved={(next) => {
                setAdding(false);
                setSettingsRouteData(MACHINES_ROUTE, next);
              }}
            />
          )}
          {canEdit && sshAvailable && !adding && !atLimit && (
            <button
              ref={addRef}
              type="button"
              className="ui-focus-ring"
              data-search-id="add-machine"
              onClick={() => {
                setEditingId(null);
                setAdding(true);
              }}
              disabled={busy}
              style={{ ...smallButtonStyle, alignSelf: "flex-start", ...(addHighlighted ? RING_STYLE : {}) }}
            >
              <Plus size={13} aria-hidden="true" />
              {t("machines.settings.addMachine")}
            </button>
          )}

          {!canEdit && <div style={dimLineStyle}>{t("machines.settings.readOnly")}</div>}
          {canEdit && !sshAvailable && <div style={dimLineStyle}>{t("machines.settings.noSsh")}</div>}
          {canEdit && sshAvailable && atLimit && <div style={dimLineStyle}>{t("machines.settings.limit", { count: MAX_MACHINES })}</div>}
          <div style={dimLineStyle}>{t("machines.settings.footnote")}</div>
        </>
      )}
    </section>
  );
}
