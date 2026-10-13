"use client";

import { RouteError } from "./_components/client/RouteError";
import "./overview.css";

// Page-level fallback for /dashboard (and any sub-route without its own error.tsx).
// Never shows the error message (may carry DB detail); only the digest for log lookup.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      title="Overview"
      subtitle="Your agents, shared memory, and work in progress."
      what="overview"
      error={error}
      reset={reset}
      message={
        <p>
          The dashboard could not read its data. If the roles and grants migration (
          <span className="hub-mono">20261007000002</span>) has not been applied yet, pages that read roles, grants or confidential
          projects stay unavailable until it is.
        </p>
      }
    />
  );
}
