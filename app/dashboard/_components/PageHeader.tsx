import type { ReactNode } from "react";
import { AutoRefresh } from "./client/AutoRefresh";
import { formatDay, zoneLabel } from "./time";

// Per-page header (§17): title, one-line subtitle, date in the configured timezone, live sync indicator.
// This file is also bundled client-side (RouteError), so it cannot import lib/config: pages pass `tz` (TIMEZONE).
// `live={false}` for pages that must not auto-refresh (e.g. while editing forms).
export function PageHeader({
  title,
  subtitle,
  actions,
  live = true,
  tz,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  live?: boolean;
  tz?: string; // IANA zone from the server (TIMEZONE); omitted in client error boundaries -> runtime zone
}) {
  const now = new Date();
  return (
    <header className="hub-page-head">
      <div className="hub-page-head__text">
        <h1 className="hub-page-head__title">{title}</h1>
        {subtitle && <p className="hub-page-head__subtitle">{subtitle}</p>}
      </div>
      <div className="hub-page-head__meta">
        <time className="hub-page-head__date" dateTime={now.toISOString()} title={`Date in ${zoneLabel(tz, now)}`}>
          {formatDay(now, tz)}
        </time>
        <AutoRefresh renderedAt={now.getTime()} enabled={live} />
        {actions && <div className="hub-page-head__actions">{actions}</div>}
      </div>
    </header>
  );
}
