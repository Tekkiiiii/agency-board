"use client";

import { useActionState, useId, useState } from "react";
import { SubmitButton } from "../_components/client/SubmitButton";
import { decideAction } from "./actions";

// Decide one pending approval. Option buttons fill the answer (toggle); the answer is optional free text.
// Approve = primary (amber), Deny = secondary. Errors (confidential routing 422, already-decided 409) show inline.
export function ApprovalForm({ id, options, question }: { id: string; options: string[]; question: string }) {
  const [state, action] = useActionState(decideAction, null);
  const [answer, setAnswer] = useState("");
  const answerId = useId();
  const optsId = useId();
  const short = question.length > 60 ? `${question.slice(0, 57)}…` : question;

  return (
    <form action={action} className="ap-form">
      <input type="hidden" name="id" value={id} />
      {options.length > 0 && (
        <div className="ap-options" role="group" aria-labelledby={optsId}>
          <span id={optsId} className="hub-label">
            Options
          </span>
          <div className="ap-options__list">
            {options.map((o) => {
              const on = answer === o;
              return (
                <button
                  key={o}
                  type="button"
                  className={`hub-btn hub-btn--secondary hub-btn--sm ap-option${on ? " is-on" : ""}`}
                  aria-pressed={on}
                  onClick={() => setAnswer(on ? "" : o)}
                >
                  {o}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="hub-field">
        <label htmlFor={answerId} className="hub-label">
          Answer <span className="hub-hint">(optional{options.length > 0 ? ", or pick an option" : ""})</span>
        </label>
        <textarea
          id={answerId}
          name="answer"
          className="hub-textarea ap-answer"
          rows={2}
          maxLength={2000}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      </div>
      <div className="ap-form__actions">
        <SubmitButton name="decision" value="approved" variant="primary" pendingLabel="Saving…" aria-label={`Approve: ${short}`}>
          Approve
        </SubmitButton>
        <SubmitButton name="decision" value="denied" variant="secondary" pendingLabel="Saving…" aria-label={`Deny: ${short}`}>
          Deny
        </SubmitButton>
      </div>
      {state && (
        <p className={`hub-notice ${state.ok ? "hub-notice--ok" : "hub-notice--danger"}`} role={state.ok ? "status" : "alert"}>
          {state.message}
        </p>
      )}
    </form>
  );
}
