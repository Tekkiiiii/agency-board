"use client";

import { RouteError } from "../_components/client/RouteError";
import "../overview.css";

// /dashboard/fleet reads agent_roles + grants (migration 20261007000002). A DB error lands here.
// Never shows the error message (may carry DB detail); only the digest for log lookup.
export default function FleetError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      title="Fleet"
      subtitle="Every agent identity, its role, and what it is doing."
      what="fleet"
      error={error}
      reset={reset}
      message={
        <p>
          Reading identities failed. The fleet needs the roles and grants tables from migration{" "}
          <span className="hub-mono">20261007000002</span>; if it is not applied yet, apply it and retry.
        </p>
      }
    />
  );
}
