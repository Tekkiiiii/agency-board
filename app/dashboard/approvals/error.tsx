"use client";

import { RouteError } from "../_components/client/RouteError";
import "./approvals.css";

// Shown when approvals cannot be read. No raw error text (may carry DB messages).
export default function ApprovalsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      title="Approvals"
      subtitle="Questions your agents are blocked on. Oldest first."
      what="approvals"
      error={error}
      reset={reset}
      message={<p>The database query failed. If the roles and grants migration (20261007000002) is not applied yet, apply it and retry.</p>}
    />
  );
}
