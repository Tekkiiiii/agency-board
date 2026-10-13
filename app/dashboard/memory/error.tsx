"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { RouteError } from "../_components/client/RouteError";
import "./memory.css";

// Route-level error boundary: a DB failure (e.g. the roles/grants migration not applied yet, so
// confidential_projects / hub_search(granted) are missing) renders inline, keeping the header and tabs.
// The raw error message is never shown (it could carry DB detail); only the digest for log lookup.
export default function MemoryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const inbox = useSearchParams().get("tab") === "inbox";
  return (
    <RouteError
      title="Memory"
      subtitle={inbox ? "Review what inbox-only agents want to remember." : "Search, curate, and link everything your agents remember."}
      what="memory data"
      error={error}
      reset={reset}
      message={
        <p>
          The database did not answer as expected. If this is a fresh deploy, the roles/grants migration{" "}
          <span className="hub-mono">20261007000002</span> may not be applied yet.
        </p>
      }
    >
      <nav className="mem-tabs" aria-label="Memory views">
        <Link href="/dashboard/memory" className="mem-tab" aria-current={inbox ? undefined : "page"}>
          Memories
        </Link>
        <Link href="/dashboard/memory?tab=inbox" className="mem-tab" aria-current={inbox ? "page" : undefined}>
          Inbox
        </Link>
      </nav>
    </RouteError>
  );
}
