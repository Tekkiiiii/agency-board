import type { ReactNode } from "react";

// Bordered surface. `accent` adds the amber top rule for "needs you" panels; `tone=danger` for red alerts.
export function Card({
  title,
  subtitle,
  actions,
  children,
  accent,
  tone,
  flush,
  className,
  headingLevel = 2,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  accent?: boolean;
  tone?: "danger" | "warn";
  flush?: boolean;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const cls = ["hub-card", accent && "hub-card--accent", tone && `hub-card--${tone}`, flush && "hub-card--flush", className]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={cls}>
      {(title || actions) && (
        <header className="hub-card__head">
          <div className="hub-card__titles">
            {title && <H className="hub-card__title">{title}</H>}
            {subtitle && <p className="hub-card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="hub-card__actions">{actions}</div>}
        </header>
      )}
      <div className="hub-card__body">{children}</div>
    </section>
  );
}
