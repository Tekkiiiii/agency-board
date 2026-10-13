"use client";

import { RouteError } from "../_components/client/RouteError";
import "./access.css";

// The most likely cause before go-live is the roles/grants migration not being applied.
export default function AccessError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      title="Access"
      subtitle="Who can see each confidential project. Every box starts unticked."
      what="access data"
      error={error}
      reset={reset}
      message={
        <p>
          The dashboard could not read identities, confidential projects or the audit list. If migration{" "}
          <span className="hub-mono">20261007000002_roles_grants</span> is not applied yet, the tables <span className="hub-mono">agent_roles</span>,{" "}
          <span className="hub-mono">confidential_projects</span>, <span className="hub-mono">grants</span> and{" "}
          <span className="hub-mono">admin_audit</span> do not exist. Apply it, then retry.
        </p>
      }
    />
  );
}
