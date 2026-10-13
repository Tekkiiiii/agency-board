"use client";

import { useActionState, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./_components/client/ConfirmDialog";
import { CopyButton } from "./_components/client/CopyButton";
import { SubmitButton } from "./_components/client/SubmitButton";
import type { ActionResult, RotateResult } from "./actions";

type FormAction = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

function Result({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  return (
    <p className={`ov-result${r.ok ? "" : " ov-result--err"}`} role={r.ok ? "status" : "alert"}>
      {r.message}
    </p>
  );
}

// Approve / Deny one pending approval (no answer text; the Approvals page handles answers).
export function ApprovalActions({ id, question, action }: { id: string; question: string; action: FormAction }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="ov-actions">
      <input type="hidden" name="id" value={id} />
      <SubmitButton name="decision" value="approved" size="sm" pendingLabel="Saving…" aria-label={`Approve: ${question}`}>
        Approve
      </SubmitButton>
      <SubmitButton name="decision" value="denied" variant="secondary" size="sm" pendingLabel="Saving…" aria-label={`Deny: ${question}`}>
        Deny
      </SubmitButton>
      <Result r={state} />
    </form>
  );
}

export interface AlertItem {
  id: string;
  machine: string | null;
  hasDevice: boolean;
  body: ReactNode; // server-rendered summary (rule, identity, time)
}

type Rotated = Extract<RotateResult, { ok: true }>;

// Open red alerts with Rotate / Disable / Trust. Kept mounted even when the list is empty so a fresh
// connect code (shown once, after Rotate closes the alert) survives the page refresh.
export function AlertList({
  items,
  rotate,
  disable,
  trust,
}: {
  items: AlertItem[];
  rotate: (fd: FormData) => Promise<RotateResult>;
  disable: (fd: FormData) => Promise<ActionResult>;
  trust: FormAction;
}) {
  const [rotated, setRotated] = useState<Rotated | null>(null);
  return (
    <>
      {rotated && (
        <div className="ov-rotated" role="status">
          <p>
            Tokens on <span className="hub-mono">{rotated.machine || "the device"}</span> were revoked. New connect code:{" "}
            <span className="hub-mono ov-code">{rotated.code}</span>
          </p>
          <p className="hub-hint">Run one of these on that machine. The code is single-use and expires.</p>
          <div className="ov-actions">
            <CopyButton value={rotated.commands.mac} label="Copy mac command" />
            <CopyButton value={rotated.commands.windows} label="Copy Windows command" />
            <button type="button" className="hub-btn hub-btn--ghost hub-btn--sm" onClick={() => setRotated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <ul className="ov-needs">
          {items.map((a) => (
            <li key={a.id} className="ov-need ov-need--alert">
              {a.body}
              <AlertActions item={a} rotate={rotate} disable={disable} trust={trust} onRotated={setRotated} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// Rotate and Disable revoke tokens, so both confirm first; Disable also needs the machine name typed
// (re-checked server-side).
function AlertActions({
  item,
  rotate,
  disable,
  trust,
  onRotated,
}: {
  item: AlertItem;
  rotate: (fd: FormData) => Promise<RotateResult>;
  disable: (fd: FormData) => Promise<ActionResult>;
  trust: FormAction;
  onRotated: (r: Rotated) => void;
}) {
  const { id, machine, hasDevice } = item;
  const [trustState, trustAction] = useActionState(trust, null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const name = machine ?? "this device";

  return (
    <div className="ov-alert-actions">
      <div className="ov-actions">
        {hasDevice && (
          <ConfirmDialog
            triggerLabel="Rotate"
            triggerVariant="primary"
            title={`Rotate ${name}?`}
            description={`Every token on ${name} stops working now. You get a new one-time connect code to run on that machine.`}
            confirmLabel="Rotate tokens"
            pendingLabel="Rotating…"
            fields={{ id }}
            action={async (fd) => {
              const r = await rotate(fd);
              if (r.ok) onRotated(r);
              else setResult(r);
            }}
          />
        )}
        {hasDevice && machine && (
          <ConfirmDialog
            triggerLabel="Disable"
            title={`Disable ${machine}?`}
            description="Revokes the device and every agent token on it. Reconnecting needs a new connect code from Devices."
            confirmLabel="Disable device"
            confirmVariant="danger"
            pendingLabel="Disabling…"
            typedConfirmation={machine}
            fields={{ id }}
            action={async (fd) => setResult(await disable(fd))}
          />
        )}
        <form action={trustAction}>
          <input type="hidden" name="id" value={id} />
          <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…" aria-label={`Trust alert on ${name}`}>
            Trust
          </SubmitButton>
        </form>
      </div>
      <Result r={result ?? trustState} />
    </div>
  );
}
