"use client";

import { Fragment, startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { CopyButton } from "../_components/client/CopyButton";
import { SubmitButton } from "../_components/client/SubmitButton";
import type { AgentId, Role } from "../../../lib/types";
import { addDeviceAction, rotateDeviceAction, setRoleAction } from "./actions";
import { INITIAL_STATE, type ConnectResult } from "./types";

const ROLE_OPTIONS: Role[] = ["director", "lead", "member"];

// ---------- connect code ----------

function Countdown({ expiresAt }: { expiresAt: string }) {
  const end = new Date(expiresAt).getTime();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (now === null) return <span className="hub-mono">10:00</span>;
  const left = Math.max(0, Math.round((end - now) / 1000));
  if (left === 0) return <span className="dv-expired">Expired. Issue a new code.</span>;
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <span className="hub-mono" aria-label={`Expires in ${mm} minutes ${ss} seconds`}>
      {mm}:{ss}
    </span>
  );
}

function Command({ label, value }: { label: string; value: string }) {
  return (
    <div className="dv-cmd">
      <div className="dv-cmd__head">
        <span className="dv-cmd__label">{label}</span>
        <CopyButton value={value} label="Copy command" />
      </div>
      <pre className="dv-cmd__code hub-mono" tabIndex={0} aria-label={`${label} command`}>
        {value}
      </pre>
    </div>
  );
}

export function ConnectCodePanel({ result }: { result: ConnectResult }) {
  const showMac = result.os !== "windows";
  const showWin = result.os === "windows" || result.os === null;
  return (
    <div className="dv-connect" role="status" aria-live="polite">
      <div className="dv-connect__top">
        <div>
          <p className="dv-connect__label">
            Connect code for <span className="hub-mono">{result.machine}</span>
          </p>
          <p className="dv-connect__code hub-mono">{result.code}</p>
        </div>
        <div className="dv-connect__meta">
          <span className="hub-hint">Single use · expires in</span> <Countdown expiresAt={result.expiresAt} />
          <CopyButton value={result.code} label="Copy code" />
        </div>
      </div>
      <p className="hub-hint">
        Run this on <span className="hub-mono">{result.machine}</span> itself. It stores the tokens and configures{" "}
        {result.agents.length ? result.agents.map((a) => a.charAt(0).toUpperCase() + a.slice(1)).join(", ") : "the agents on that machine"}.
      </p>
      {showMac && <Command label={result.os === "linux" ? "Linux (Terminal)" : "macOS / Linux (Terminal)"} value={result.commands.mac} />}
      {showWin && <Command label="Windows (PowerShell)" value={result.commands.windows} />}
    </div>
  );
}

// ---------- add device ----------

// One checkbox per device-capable agent (AGENCY_BOARD_DEVICE_AGENTS, resolved on the server). `windowsBlocked` comes from
// agentAllowedOnOs; restricted agents start unticked.
export interface AgentOption {
  id: string;
  restricted: boolean;
  windowsBlocked: boolean;
}
const label = (a: string) => a.charAt(0).toUpperCase() + a.slice(1);

export function AddDeviceForm({ agents }: { agents: AgentOption[] }) {
  const [state, formAction, pending] = useActionState(addDeviceAction, INITIAL_STATE);
  const [os, setOs] = useState<"mac" | "windows" | "linux">("mac");
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(agents.map((a) => [a.id, !a.restricted])));
  const id = useId();

  return (
    <div className="dv-add">
      <form
        className="dv-add__form"
        onSubmit={(e) => {
          // Submit without React's automatic form reset so the fields keep matching the issued code.
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          startTransition(() => formAction(fd));
        }}
      >
        <div className="hub-field">
          <label htmlFor={`${id}-machine`} className="hub-label">
            Machine name
          </label>
          <input
            id={`${id}-machine`}
            name="machine_name"
            className="hub-input hub-mono"
            required
            maxLength={64}
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
            placeholder="laptop"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-machine-hint`}
          />
          <span id={`${id}-machine-hint`} className="hub-hint">
            Letters, digits, dot, dash, underscore. Reusing a name reconnects that device.
          </span>
        </div>
        <div className="hub-field">
          <label htmlFor={`${id}-os`} className="hub-label">
            Operating system
          </label>
          <select
            id={`${id}-os`}
            name="os"
            className="hub-select"
            value={os}
            onChange={(e) => {
              const v = e.target.value as typeof os;
              setOs(v);
              if (v === "windows") setChecked((c) => ({ ...c, ...Object.fromEntries(agents.filter((a) => a.windowsBlocked).map((a) => [a.id, false])) }));
            }}
          >
            <option value="mac">macOS</option>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
          </select>
        </div>
        <fieldset className="dv-agents">
          <legend className="hub-label">Agents</legend>
          {agents.map((a) => {
            const blocked = os === "windows" && a.windowsBlocked;
            const hint = blocked ? `${label(a.id)} is not available on Windows.` : a.restricted ? `${label(a.id)} stays read-capped (contract §11).` : null;
            return (
              <Fragment key={a.id}>
                <label className={`dv-check${blocked ? " dv-check--off" : ""}`}>
                  <input
                    type="checkbox"
                    name="agents"
                    value={a.id}
                    checked={!!checked[a.id] && !blocked}
                    disabled={blocked}
                    onChange={(e) => setChecked((c) => ({ ...c, [a.id]: e.target.checked }))}
                    aria-describedby={hint ? `${id}-${a.id}-hint` : undefined}
                  />{" "}
                  {label(a.id)}
                </label>
                {hint && (
                  <span id={`${id}-${a.id}-hint`} className="hub-hint">
                    {hint}
                  </span>
                )}
              </Fragment>
            );
          })}
        </fieldset>
        <div className="dv-add__submit">
          <button type="submit" className="hub-btn hub-btn--primary hub-btn--md" disabled={pending} aria-busy={pending || undefined}>
            {pending ? "Issuing…" : "Issue connect code"}
          </button>
        </div>
      </form>
      {state.error && (
        <p className="hub-notice hub-notice--danger" role="alert">
          {state.error}
        </p>
      )}
      {state.ok && state.connect && <ConnectCodePanel result={state.connect} />}
    </div>
  );
}

// ---------- rotate ----------

export function RotateControl({
  deviceId,
  machine,
  alertId,
  label = "Rotate",
  variant = "secondary",
}: {
  deviceId: string;
  machine: string;
  alertId?: string;
  label?: string;
  variant?: "primary" | "secondary";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, formAction] = useActionState(rotateDeviceAction, INITIAL_STATE);
  const [showResult, setShowResult] = useState(false);
  const id = useId();

  useEffect(() => {
    if (state.ok || state.error) setShowResult(true);
  }, [state]);

  function open() {
    setShowResult(false);
    ref.current?.showModal();
  }
  const close = () => ref.current?.close();
  const done = showResult && state.ok && state.connect;

  return (
    <>
      <button type="button" className={`hub-btn hub-btn--${variant} hub-btn--sm`} onClick={open} aria-haspopup="dialog">
        {label}
      </button>
      <dialog
        ref={ref}
        className="hub-dialog dv-dialog--wide"
        aria-labelledby={`${id}-t`}
        onClick={(e) => {
          if (e.target === ref.current) close();
        }}
      >
        <form action={formAction} className="hub-dialog__form">
          <h2 id={`${id}-t`} className="hub-dialog__title">
            {done ? "New connect code" : <>Rotate tokens for <span className="hub-mono">{machine}</span>?</>}
          </h2>
          {!done && (
            <div className="hub-dialog__desc">
              Every token on this machine stops working now. You get a new single-use connect code; run the command on{" "}
              <span className="hub-mono">{machine}</span> to reconnect its agents.
            </div>
          )}
          <input type="hidden" name="device_id" value={deviceId} />
          {alertId && <input type="hidden" name="alert_id" value={alertId} />}
          {showResult && state.error && (
            <p className="hub-notice hub-notice--danger" role="alert">
              {state.error}
            </p>
          )}
          {done && <ConnectCodePanel result={state.connect!} />}
          <div className="hub-dialog__actions">
            {done ? (
              <button type="button" className="hub-btn hub-btn--secondary hub-btn--md" onClick={close} autoFocus>
                Done
              </button>
            ) : (
              <>
                <button type="button" className="hub-btn hub-btn--secondary hub-btn--md" onClick={close} autoFocus>
                  Cancel
                </button>
                <SubmitButton variant="danger" pendingLabel="Rotating…">
                  Rotate tokens
                </SubmitButton>
              </>
            )}
          </div>
        </form>
      </dialog>
    </>
  );
}

// ---------- role ----------

export function RoleControl({
  agent,
  deviceId,
  ident,
  role,
  roleIsDefault,
  demoteLabel,
  restrictedWarnFor,
  warning,
}: {
  agent: AgentId;
  deviceId: string;
  ident: string;
  role: Role;
  roleIsDefault: boolean;
  demoteLabel: string | null; // identity demoted to lead if this one becomes director
  restrictedWarnFor: Role[]; // target roles that need the restricted-agent warning
  warning: string; // RESTRICTED_WARNING, passed from the server
}) {
  const [state, formAction, pending] = useActionState(setRoleAction, INITIAL_STATE);
  const [value, setValue] = useState<Role>(role);
  const [next, setNext] = useState<Role | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const id = useId();

  useEffect(() => setValue(role), [role]);
  useEffect(() => {
    if (state.error) setValue(role); // failed change: show the stored role again
  }, [state, role]);

  function submit(target: Role) {
    const fd = new FormData();
    fd.set("agent", agent);
    fd.set("device_id", deviceId);
    fd.set("role", target);
    if (target === "director") fd.set("ack_director", demoteLabel ?? "");
    if (restrictedWarnFor.includes(target)) fd.set("ack_restricted", "1");
    startTransition(() => formAction(fd));
  }

  function change(target: Role) {
    if (target === value) return;
    setValue(target);
    if (target === "director" || restrictedWarnFor.includes(target)) {
      setNext(target);
      ref.current?.showModal();
    } else {
      submit(target);
    }
  }

  function cancel() {
    ref.current?.close();
  }

  const isDirector = next === "director";
  const isRestricted = next !== null && restrictedWarnFor.includes(next);

  return (
    <div className="dv-role">
      <label htmlFor={`${id}-sel`} className="hub-sr-only">
        Role for {ident}
      </label>
      <select
        id={`${id}-sel`}
        className="hub-select dv-role__select"
        value={value}
        disabled={pending}
        aria-describedby={roleIsDefault ? `${id}-def` : undefined}
        onChange={(e) => change(e.target.value as Role)}
      >
        {ROLE_OPTIONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {roleIsDefault && (
        <span id={`${id}-def`} className="dv-role__default" title="No role set yet; this is the default for the agent">
          default
        </span>
      )}
      <span className="dv-role__status" aria-live="polite">
        {pending ? "Saving…" : state.error ? <span className="dv-role__err">{state.error}</span> : null}
      </span>
      <dialog
        ref={ref}
        className="hub-dialog"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-d`}
        onClose={() => {
          // Esc, backdrop or Cancel: revert the select unless the change was confirmed.
          if (!confirmed.current) setValue(role);
          confirmed.current = false;
          setNext(null);
        }}
        onClick={(e) => {
          if (e.target === ref.current) cancel();
        }}
      >
        <form
          className="hub-dialog__form"
          onSubmit={(e) => {
            e.preventDefault();
            const target = next;
            confirmed.current = true;
            ref.current?.close();
            if (target) submit(target);
          }}
        >
          <h2 id={`${id}-t`} className="hub-dialog__title">
            Make <span className="hub-mono">{ident}</span> {next}?
          </h2>
          <div id={`${id}-d`} className="hub-dialog__desc dv-dialog__stack">
            {isDirector && (
              <p>
                There is one director at a time.{" "}
                {demoteLabel ? (
                  <>
                    <span className="hub-mono dv-strong">{demoteLabel}</span> will be demoted to <strong>lead</strong>.
                  </>
                ) : (
                  <>No identity is director right now, so nobody is demoted.</>
                )}
              </p>
            )}
            {isRestricted && (
              <div className="hub-notice hub-warnbox" role="note">
                <p>
                  <strong>{warning}</strong>
                </p>
                <p>
                  The read cap stays at every role (contract §11): this agent still reads only <span className="hub-mono">{agent}/*</span>,{" "}
                  <span className="hub-mono">shared/inbox</span> and assigned projects, and writes only to the inbox. The role changes
                  dispatch, review and forget rights.
                </p>
              </div>
            )}
          </div>
          <div className="hub-dialog__actions">
            <button type="button" className="hub-btn hub-btn--secondary hub-btn--md" onClick={cancel} autoFocus>
              Cancel
            </button>
            <button type="submit" className="hub-btn hub-btn--primary hub-btn--md">
              Make {next}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
