import { TIMEZONE } from "../../../lib/config";
import Link from "next/link";
import { navCounts } from "../../../lib/dash/counts";
import { requireAdmin } from "../../../lib/dash/session";
import { Badge } from "../_components/Badge";
import { PageHeader } from "../_components/PageHeader";
import { DetailView } from "./DetailView";
import { InboxView } from "./InboxView";
import { SearchView } from "./SearchView";
import "./memory.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Memory" };

type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function MemoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const tab = first(sp.tab) === "inbox" ? "inbox" : "memories";
  const id = first(sp.id);
  const { inbox } = await navCounts();

  return (
    <>
      <PageHeader
        tz={TIMEZONE}
        title="Memory"
        subtitle={tab === "inbox" ? "Review what inbox-only agents want to remember." : "Search, curate, and link everything your agents remember."}
        live={!id}
      />
      <nav className="mem-tabs" aria-label="Memory views">
        <Link href="/dashboard/memory" className="mem-tab" aria-current={tab === "memories" ? "page" : undefined}>
          Memories
        </Link>
        <Link href="/dashboard/memory?tab=inbox" className="mem-tab" aria-current={tab === "inbox" ? "page" : undefined}>
          Inbox
          <Badge variant="count" count={inbox} label="pending inbox items" />
        </Link>
      </nav>
      {tab === "inbox" ? <InboxView /> : id ? <DetailView id={id} done={first(sp.done)} /> : <SearchView sp={sp} />}
    </>
  );
}
