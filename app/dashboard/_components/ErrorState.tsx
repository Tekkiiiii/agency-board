import type { ReactNode } from "react";

// The one "degraded / unavailable" treatment for data that could not be read (missing migration, DB down).
// Neutral, never danger red: red is reserved for failed user actions and genuinely dangerous states (§17).
// Works in server components (no hooks); pass `onRetry` only from client components (error boundaries).
// Never put raw error text here (it may carry DB detail): a digest / error code goes in `reference`.
export function ErrorState({
  title,
  message,
  reference,
  onRetry,
  retryLabel = "Try again",
  page,
  className,
}: {
  title: string;
  message?: ReactNode;
  reference?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  page?: boolean; // whole-page boundary: larger padding + title
  className?: string;
}) {
  const cls = ["hub-notice", "hub-notice--degraded", "hub-error-state", page && "hub-error-state--page", className].filter(Boolean).join(" ");
  return (
    <div className={cls} role="status">
      <p className="hub-error-state__title">{title}</p>
      {message && <div className="hub-error-state__msg">{message}</div>}
      {reference && (
        <p className="hub-error-state__ref">
          Reference <span className="hub-mono">{reference}</span>
        </p>
      )}
      {onRetry && (
        <div className="hub-error-state__action">
          <button type="button" className="hub-btn hub-btn--secondary hub-btn--sm" onClick={onRetry}>
            {retryLabel}
          </button>
        </div>
      )}
    </div>
  );
}
