"use client";

import { useActionState, useId, useState } from "react";
import { ConfirmDialog } from "../_components/client/ConfirmDialog";
import { SubmitButton } from "../_components/client/SubmitButton";
import {
  approveInboxAction,
  editMemoryAction,
  pinMemoryAction,
  rejectInboxAction,
  removeAutoLinkAction,
  retireMemoryAction,
} from "./actions";
import type { ActionState } from "./types";

// Page-local client controls for /dashboard/memory. Every control posts to a server action that
// re-checks admin, validates, and returns a readable, content-free result shown inline (aria-live).

function Result({ state }: { state: ActionState }) {
  return (
    <p className={`mem-result${state ? (state.ok ? " mem-result--ok" : " mem-result--err") : ""}`} role="status" aria-live="polite">
      {state?.message ?? ""}
    </p>
  );
}

const MAX = 8192;

export function EditForm({ id, initial }: { id: string; initial: string }) {
  const [state, action] = useActionState(editMemoryAction, null);
  const [len, setLen] = useState(initial.length);
  const fid = useId();
  return (
    <form action={action} className="mem-edit">
      <input type="hidden" name="id" value={id} />
      <div className="hub-field">
        <label htmlFor={`${fid}-content`} className="hub-label">
          New content
        </label>
        <textarea
          id={`${fid}-content`}
          name="content"
          className="hub-textarea mem-edit__text"
          defaultValue={initial}
          maxLength={MAX}
          required
          rows={12}
          spellCheck={false}
          onChange={(e) => setLen(e.target.value.length)}
          aria-describedby={`${fid}-hint`}
        />
        <p id={`${fid}-hint`} className="hub-hint">
          Saves a new version (<span className="hub-mono">-v2</span>, <span className="hub-mono">-v3</span> …) that supersedes this one. The
          original author is kept; flags gain <span className="hub-mono">edited-by-owner</span>.{" "}
          <span className="hub-mono">
            {len}/{MAX}
          </span>
        </p>
      </div>
      <div className="mem-actions-row">
        <SubmitButton variant="primary" pendingLabel="Saving…">
          Save new version
        </SubmitButton>
        <Result state={state} />
      </div>
    </form>
  );
}

export function PinButton({ id, pinned }: { id: string; pinned: boolean }) {
  const [state, action] = useActionState(pinMemoryAction, null);
  return (
    <form action={action} className="mem-inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="pinned" value={pinned ? "false" : "true"} />
      <SubmitButton variant="secondary" size="sm" pendingLabel={pinned ? "Unpinning…" : "Pinning…"}>
        {pinned ? "Unpin" : "Pin"}
      </SubmitButton>
      {state && !state.ok && <Result state={state} />}
    </form>
  );
}

export function RetireButton({ id, slug }: { id: string; slug: string }) {
  const [state, action] = useActionState(retireMemoryAction, null);
  return (
    <div className="mem-inline">
      <ConfirmDialog
        triggerLabel="Retire"
        triggerVariant="danger"
        title="Retire this memory?"
        description={
          <p>
            <span className="hub-mono">{slug}</span> stops appearing in recall and search for every agent. The row is soft-deleted and stays
            in the database.
          </p>
        }
        confirmLabel="Retire"
        confirmVariant="danger"
        pendingLabel="Retiring…"
        action={action}
        fields={{ id }}
      />
      {state && <Result state={state} />}
    </div>
  );
}

export function RemoveLinkButton({ linkId, label }: { linkId: number; label: string }) {
  const [state, action] = useActionState(removeAutoLinkAction, null);
  return (
    <form action={action} className="mem-inline">
      <input type="hidden" name="linkId" value={String(linkId)} />
      <SubmitButton variant="ghost" size="sm" pendingLabel="Removing…" aria-label={`Remove auto link to ${label}`}>
        Remove link
      </SubmitButton>
      {state && !state.ok && <Result state={state} />}
    </form>
  );
}

export function InboxReview({ id, target }: { id: string; target: string | null }) {
  const [approveState, approve] = useActionState(approveInboxAction, null);
  const [rejectState, reject] = useActionState(rejectInboxAction, null);
  const fid = useId();
  return (
    <div className="mem-review">
      <form action={approve} className="mem-review__approve">
        <input type="hidden" name="id" value={id} />
        <div className="hub-field mem-review__field">
          <label htmlFor={`${fid}-ns`} className="hub-label">
            Approve into namespace
          </label>
          <input
            id={`${fid}-ns`}
            name="namespace"
            className="hub-input mem-mono-input"
            defaultValue={target ?? ""}
            placeholder="project/name"
            autoComplete="off"
            spellCheck={false}
            required={!target}
            pattern="[a-z0-9\-]+(/[a-z0-9\-]+)*"
          />
        </div>
        <SubmitButton variant="primary" pendingLabel="Approving…">
          Approve
        </SubmitButton>
      </form>
      <form action={reject}>
        <input type="hidden" name="id" value={id} />
        <SubmitButton variant="secondary" pendingLabel="Rejecting…">
          Reject
        </SubmitButton>
      </form>
      <Result state={rejectState ?? approveState} />
    </div>
  );
}
