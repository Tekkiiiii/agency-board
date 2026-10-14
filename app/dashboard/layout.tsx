import type { Metadata } from "next";
import type { ReactNode } from "react";
import { navCounts } from "../../lib/dash/counts";
import { requireAdmin } from "../../lib/dash/session";
import { getUpdateStatusWithin, type UpdateStatus } from "../../lib/update/status";
import { Nav } from "./_components/Nav";
import { UpdateBanner } from "./_components/UpdateBanner";
import { fontClasses } from "./_components/fonts";
import "./dashboard.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "agency-board", template: "%s · agency-board" },
  robots: { index: false, follow: false },
};

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { email } = await requireAdmin();
  const counts = await navCounts();
  // Bounded to 1.5 s on a cold cache (the lookup keeps warming it); cached for an hour in memory and never throws in practice;
  // the catch keeps a surprise from taking the dashboard down.
  const update: UpdateStatus = await getUpdateStatusWithin().catch(() => ({ state: "hidden" }));
  return (
    <div className={`hub-root hub-shell ${fontClasses}`}>
      <a href="#hub-main" className="hub-skip">
        Skip to content
      </a>
      <Nav email={email} counts={counts} />
      <main id="hub-main" className="hub-main" tabIndex={-1}>
        <UpdateBanner status={update} />
        {children}
      </main>
    </div>
  );
}
