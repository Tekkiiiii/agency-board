import type { Metadata } from "next";
import type { ReactNode } from "react";
import { navCounts } from "../../lib/dash/counts";
import { requireAdmin } from "../../lib/dash/session";
import { Nav } from "./_components/Nav";
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
  return (
    <div className={`hub-root hub-shell ${fontClasses}`}>
      <a href="#hub-main" className="hub-skip">
        Skip to content
      </a>
      <Nav email={email} counts={counts} />
      <main id="hub-main" className="hub-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
