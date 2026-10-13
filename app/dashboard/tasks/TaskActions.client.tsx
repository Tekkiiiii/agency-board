"use client";

import { useActionState, useId, useState } from "react";
import { ConfirmDialog } from "../_components/client/ConfirmDialog";
import { SubmitButton } from "../_components/client/SubmitButton";
import { cancelAction, reassignAction, retryAction, type TaskActionResult } from "./actions";

type Target = { value: string; label: string };

// Admin actions for one task in the detail panel. Results (incl. 409 races) are shown inline.
export function TaskActions({
  taskId,
  taskTitle,
  status,
  currentTarget,
  targets,
  identitiesOk,
}: {
  taskId: string;
  taskTitle: string;
  status: string;
  currentTarget: string | null;
  targets: Target[];
  identitiesOk: boolean;
}) {
  const [reassignState, reassign] = useActionState(reassignAction, null);
  const [retryState, retry] = useActionState(retryAction, null);
  const [cancelState, setCancelState] = useState<TaskActionResult>(null);
  const selectId = useId();

  const canReassign = status !== "done";
  const canCancel = status === "open" || status === "claimed" || status === "blocked" || status === "failed";
  const canRetry = status === "failed" || status === "cancelled";
  // Show the most recent result; useActionState keeps old ones, so prefer whichever changed last.
  const [last, setLast] = useState<"reassign" | "retry" | "cancel" | null>(null);
  const result = last === "reassign" ? reassignState : last === "retry" ? retryState : last === "cancel" ? cancelState : null;

  if (!canReassign && !canCancel && !canRetry) {
    return <p className="hub-hint">Done tasks have no actions.</p>;
  }

  return (
    <div className="tb-actions">
      {canReassign && (
        <form action={reassign} onSubmit={() => setLast("reassign")} className="tb-reassign">
          <input type="hidden" name="id" value={taskId} />
          <div className="hub-field">
            <label htmlFor={selectId} className="hub-label">
              Reassign to
            </label>
            <div className="tb-reassign__row">
              <select id={selectId} name="target" className="hub-select hub-mono" defaultValue={currentTarget ?? ""} required>
                <option value="" disabled>
                  Choose an agent…
                </option>
                {targets.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <SubmitButton variant="secondary" pendingLabel="Reassigning…">
                Reassign
              </SubmitButton>
            </div>
            <span className="hub-hint">
              Reopens the task for that agent and clears any claim or block.
              {!identitiesOk && " Machine identities are unavailable until the roles migration is applied; only whole agents are listed."}
            </span>
          </div>
        </form>
      )}

      {(canRetry || canCancel) && (
        <div className="tb-actions__row">
          {canRetry && (
            <form action={retry} onSubmit={() => setLast("retry")}>
              <input type="hidden" name="id" value={taskId} />
              <SubmitButton variant="primary" size="sm" pendingLabel="Reopening…">
                Retry
              </SubmitButton>
            </form>
          )}
          {canCancel && (
            <ConfirmDialog
              triggerLabel="Cancel task"
              triggerVariant="danger"
              title="Cancel this task?"
              description={
                <>
                  <strong className="tb-dialog-title">{taskTitle}</strong> will move to Cancelled and any lease is cleared. You can retry it
                  later.
                </>
              }
              confirmLabel="Cancel task"
              confirmVariant="danger"
              pendingLabel="Cancelling…"
              fields={{ id: taskId }}
              action={async (fd: FormData) => {
                setLast("cancel");
                setCancelState(await cancelAction(null, fd));
              }}
            />
          )}
        </div>
      )}

      {result && (
        <p className={`hub-notice ${result.ok ? "hub-notice--ok" : "hub-notice--danger"}`} role={result.ok ? "status" : "alert"}>
          {result.message}
        </p>
      )}
    </div>
  );
}
