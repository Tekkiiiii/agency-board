import Link from "next/link";
import type { NavCounts } from "../../../lib/dash/counts";
import { Badge } from "./Badge";
import { NavLink } from "./client/NavLink";
import { Icon } from "./icons";

// Left nav (top bar under 900px). Order fixed by §17. Kill switch and the single profile block
// sit at the bottom, separated; there is no profile at the top.
export function Nav({ email, counts }: { email: string; counts: NavCounts }) {
  const items = [
    { href: "/dashboard", label: "Overview", icon: Icon.overview, exact: true },
    { href: "/dashboard/fleet", label: "Fleet", icon: Icon.fleet },
    { href: "/dashboard/tasks", label: "Tasks", icon: Icon.tasks },
    { href: "/dashboard/approvals", label: "Approvals", icon: Icon.approvals, count: counts.approvals, countLabel: "pending approvals" },
    { href: "/dashboard/memory", label: "Memory", icon: Icon.memory, count: counts.inbox, countLabel: "inbox items to review" },
    { href: "/dashboard/devices", label: "Devices", icon: Icon.devices, count: counts.alerts, countLabel: "open high alerts" },
    { href: "/dashboard/access", label: "Access", icon: Icon.access },
  ];
  const initial = (email.trim()[0] ?? "?").toUpperCase();
  return (
    <aside className="hub-sidebar">
      <div className="hub-sidebar__inner">
        <div className="hub-brand">
          <span className="hub-brand__name">agency-board</span>
          <span className="hub-brand__sub">Overseer</span>
        </div>
        <nav className="hub-nav" aria-label="Dashboard">
          <ul className="hub-nav__list">
            {items.map((it) => (
              <li key={it.href}>
                <NavLink href={it.href} exact={it.exact}>
                  <it.icon />
                  <span className="hub-nav__label">{it.label}</span>
                  {it.count !== undefined && <Badge variant="count" count={it.count} label={it.countLabel ?? ""} />}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="hub-sidebar__foot">
          {counts.alerts > 0 && (
            // Top bar only (hidden in the wide sidebar, where the Devices badge is always visible): the
            // tab row scrolls, so high alerts stay reachable even when the Devices tab is off screen.
            <Link
              href="/dashboard/devices"
              className="hub-topalert"
              aria-label={`${counts.alerts} open high ${counts.alerts === 1 ? "alert" : "alerts"} on Devices`}
            >
              <Icon.devices />
              <span className="hub-badge hub-badge--count" aria-hidden="true">
                {counts.alerts > 99 ? "99+" : counts.alerts}
              </span>
            </Link>
          )}
          <NavLink href="/dashboard/kill-switch" className="hub-nav__link hub-killswitch">
            <Icon.power />
            <span className="hub-nav__label">Kill switch</span>
          </NavLink>
          <div className="hub-profile">
            <span className="hub-avatar" aria-hidden="true">
              {initial}
            </span>
            <div className="hub-profile__text">
              <span className="hub-profile__email" title={email}>
                {email}
              </span>
              <form action="/auth/signout" method="post">
                <button type="submit" className="hub-linkbtn">
                  <Icon.signOut />
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
