"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { SubmitButton } from "./SubmitButton";

type Variant = "primary" | "secondary" | "danger" | "ghost";

/** Optional action result: shown in the dialog (failure, dialog stays open) or next to the trigger (success). */
export type ConfirmResult = { ok: boolean; message?: string };

function asResult(v: unknown): ConfirmResult | null {
  return v !== null && typeof v === "object" && typeof (v as { ok?: unknown }).ok === "boolean" ? (v as ConfirmResult) : null;
}

// Native modal <dialog> (showModal makes the page inert and keeps focus inside; Esc closes).
// Submits `action` (a server action) with `fields` as hidden inputs plus any `children` inputs.
// With `typedConfirmation`, the confirm button stays disabled until the exact string is typed;
// the typed value is also sent as `confirm` so the server action can re-check it.
// If `action` returns `{ ok, message? }`: ok -> dialog closes and `message` shows beside the trigger
// (announced politely); !ok -> dialog stays open with `message` as an inline alert. Any other return
// value (void, redirects) keeps the old behaviour: close after the action settles.
export function ConfirmDialog({
  triggerLabel,
  triggerVariant = "secondary",
  triggerSize = "sm",
  title,
  description,
  confirmLabel = "Confirm",
  confirmVariant = "primary",
  pendingLabel,
  typedConfirmation,
  action,
  fields,
  children,
}: {
  triggerLabel: ReactNode;
  triggerVariant?: Variant;
  triggerSize?: "sm" | "md";
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  confirmVariant?: Variant;
  pendingLabel?: string;
  typedConfirmation?: string;
  action: (formData: FormData) => unknown; // may return ConfirmResult (see above)
  fields?: Record<string, string>;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const inputId = `${id}-confirm`;
  const errorId = `${id}-error`;
  const blocked = typedConfirmation !== undefined && typed !== typedConfirmation;

  function open() {
    setTyped("");
    setError(null);
    setNotice(null);
    ref.current?.showModal();
  }
  function close() {
    ref.current?.close();
  }

  async function submit(fd: FormData) {
    setError(null);
    const r = asResult(await action(fd));
    if (r && !r.ok) {
      setError(r.message ?? "That did not work. Nothing was changed. Try again.");
      return;
    }
    setNotice(r?.message ?? null);
    close();
  }

  return (
    <>
      <button type="button" className={`hub-btn hub-btn--${triggerVariant} hub-btn--${triggerSize}`} onClick={open} aria-haspopup="dialog">
        {triggerLabel}
      </button>
      {notice && (
        <span className="hub-dialog-notice" aria-hidden="true">
          {notice}
        </span>
      )}
      <span className="hub-sr-only" role="status" aria-live="polite">
        {notice ?? ""}
      </span>
      <dialog
        ref={ref}
        className="hub-dialog"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onClick={(e) => {
          if (e.target === ref.current) close(); // backdrop click
        }}
      >
        <form action={submit} className="hub-dialog__form">
          <h2 id={titleId} className="hub-dialog__title">
            {title}
          </h2>
          {description && (
            <div id={descId} className="hub-dialog__desc">
              {description}
            </div>
          )}
          {fields && Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          {children}
          {typedConfirmation !== undefined && (
            <div className="hub-field">
              <label htmlFor={inputId} className="hub-label">
                Type <span className="hub-mono hub-confirm-word">{typedConfirmation}</span> to confirm
              </label>
              <input
                id={inputId}
                name="confirm"
                className="hub-input hub-mono"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
          {error && (
            <p id={errorId} className="hub-notice hub-notice--danger" role="alert">
              {error}
            </p>
          )}
          <div className="hub-dialog__actions">
            <button type="button" className="hub-btn hub-btn--secondary hub-btn--md" onClick={close} autoFocus>
              Cancel
            </button>
            <SubmitButton variant={confirmVariant} disabled={blocked} pendingLabel={pendingLabel}>
              {confirmLabel}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
