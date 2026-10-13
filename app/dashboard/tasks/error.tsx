"use client";

import { RouteError } from "../_components/client/RouteError";
import "./tasks.css";

// Shown when the board cannot be read (e.g. a migration is missing). No error details are shown: they may
// contain database messages; the digest is enough to find the server log line.
export default function TasksError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      title="Tasks"
      subtitle="What every agent is working on, what is waiting, and what got stuck."
      what="task board"
      error={error}
      reset={reset}
      message={<p>The database query failed. If the roles and grants migration (20261007000002) is not applied yet, apply it and retry.</p>}
    />
  );
}
