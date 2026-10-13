"use client";

import { useId, useState } from "react";
import type { AgentId } from "../../../lib/types";
import { ConfirmDialog } from "../_components/client/ConfirmDialog";
import { revokeAgentAction, setFlagAction, type KillResult } from "./actions";

type Msg = { ok: boolean; text: string } | null;

function Result({ msg, idle }: { msg: Msg; idle?: string }) {
  return (
    <p className={`hub-kill__result${msg ? (msg.ok ? " hub-kill__result--ok" : " hub-kill__result--error") : ""}`} role="status" aria-live="polite">
      {msg?.text ?? idle ?? ""}
    </p>
  );
}

async function run(action: (fd: FormData) => Promise<KillResult>, fd: FormData): Promise<Msg> {
  try {
    const r = await action(fd);
    return r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error };
  } catch {
    return { ok: false, text: "The request failed. Nothing was changed. Try again." };
  }
}

// One flag toggle. `word` is the exact text to type for the change this button makes.
export function FlagControl({
  flag,
  active,
  word,
  onLabel,
  offLabel,
  dialogTitle,
  dialogBody,
}: {
  flag: "dispatch" | "writes";
  active: boolean;
  word: string;
  onLabel: string;
  offLabel: string;
  dialogTitle: string;
  dialogBody: string;
}) {
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <div className="hub-kill__control">
      <ConfirmDialog
        key={String(active)}
        triggerLabel={active ? offLabel : onLabel}
        triggerVariant={active ? "secondary" : "danger"}
        triggerSize="md"
        title={dialogTitle}
        description={<p>{dialogBody}</p>}
        confirmLabel={active ? offLabel : onLabel}
        confirmVariant={active ? "primary" : "danger"}
        pendingLabel="Applying…"
        typedConfirmation={word}
        fields={{ flag, on: String(!active) }}
        action={async (fd) => setMsg(await run(setFlagAction, fd))}
      />
      <Result msg={msg} />
    </div>
  );
}

// Revoke every live token of one agent (all machines). The agent name must be typed exactly.
export function RevokeControl({ agents }: { agents: readonly AgentId[] }) {
  const [agent, setAgent] = useState<AgentId | "">("");
  const [msg, setMsg] = useState<Msg>(null);
  const id = useId();
  return (
    <div className="hub-kill__revoke">
      <div className="hub-field hub-kill__select">
        <label htmlFor={`${id}-agent`} className="hub-label">
          Agent
        </label>
        <select
          id={`${id}-agent`}
          className="hub-select hub-mono"
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value as AgentId | "");
            setMsg(null);
          }}
        >
          <option value="">Choose an agent…</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="hub-kill__revoke-btn">
        {agent ? (
          <ConfirmDialog
            key={agent}
            triggerLabel={`Revoke ${agent}`}
            triggerVariant="danger"
            triggerSize="md"
            title={`Revoke every ${agent} token?`}
            description={
              <p>
                All active <span className="hub-mono">{agent}</span> tokens on every machine stop working immediately: the next request
                gets <span className="hub-mono">401 REVOKED</span>. To bring {agent} back, connect its device again from Devices.
              </p>
            }
            confirmLabel={`Revoke ${agent}`}
            confirmVariant="danger"
            pendingLabel="Revoking…"
            typedConfirmation={agent}
            fields={{ agent }}
            action={async (fd) => {
              const m = await run(revokeAgentAction, fd);
              setMsg(m);
              if (m?.ok) setAgent("");
            }}
          />
        ) : (
          <button type="button" className="hub-btn hub-btn--danger hub-btn--md" disabled aria-describedby={`${id}-hint`}>
            Revoke agent
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className="hub-hint hub-kill__revoke-hint">
        Choose an agent first. You will type its name to confirm.
      </p>
      <Result msg={msg} />
    </div>
  );
}
