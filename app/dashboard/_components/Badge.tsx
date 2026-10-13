import type { ReactNode } from "react";

export type BadgeTone = "ok" | "danger" | "warn" | "info" | "neutral";

type BadgeProps =
  // count: the amber "needs you" badge (approvals, inbox, open high alerts — identical everywhere)
  | { variant: "count"; count: number; label: string }
  // status: small tinted pill; danger only for genuinely dangerous states
  | { variant: "status"; tone?: BadgeTone; children: ReactNode }
  // role: identity role (director / write / read ...)
  | { variant: "role"; children: ReactNode };

export function Badge(props: BadgeProps) {
  if (props.variant === "count") {
    if (props.count <= 0) return null;
    const shown = props.count > 99 ? "99+" : String(props.count);
    return (
      <span className="hub-badge hub-badge--count" aria-label={`${props.count} ${props.label}`}>
        {shown}
      </span>
    );
  }
  if (props.variant === "role") return <span className="hub-badge hub-badge--role">{props.children}</span>;
  return <span className={`hub-badge hub-badge--status hub-tone-${props.tone ?? "neutral"}`}>{props.children}</span>;
}
