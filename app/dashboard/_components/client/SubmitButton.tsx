"use client";

import type { MouseEvent, ReactNode } from "react";
import { useFormStatus } from "react-dom";

type Variant = "primary" | "secondary" | "danger" | "ghost";

// A named submit button's name/value must reach the server action even where the browser does not
// expose SubmitEvent.submitter (React builds the action's FormData from it). On click we put a
// hidden <input name value> right before the button; the form's submit event (fired synchronously
// by the same click, incl. Enter-key implicit submission) reads it, then it is removed on the next
// task. The button keeps its own name/value so no-JS / pre-hydration submissions still carry it.
// Duplicate entries, when both paths work, hold the same value, so `fd.get(name)` is always right.
function carrySubmitter(e: MouseEvent<HTMLButtonElement>) {
  const btn = e.currentTarget;
  if (!btn.name || !btn.form || e.defaultPrevented) return;
  const input = btn.ownerDocument.createElement("input");
  input.type = "hidden";
  input.name = btn.name;
  input.value = btn.value;
  if (btn.form.id) input.setAttribute("form", btn.form.id);
  btn.before(input);
  setTimeout(() => input.remove(), 0);
}

// Submit button for server-action forms: disabled + pending label while the action runs.
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  disabled,
  name,
  value,
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: Variant;
  size?: "sm" | "md";
  disabled?: boolean;
  name?: string;
  value?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      aria-label={ariaLabel}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      onClick={name ? carrySubmitter : undefined}
      className={`hub-btn hub-btn--${variant} hub-btn--${size}${className ? ` ${className}` : ""}`}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}
