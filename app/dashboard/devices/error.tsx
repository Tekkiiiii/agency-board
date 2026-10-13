"use client";

import { RouteError } from "../_components/client/RouteError";
import "./devices.css";

// Route-level fallback for /dashboard/devices. Sections already catch their own load errors; this catches
// anything else (e.g. a render failure) without taking down the shell.
export default function DevicesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      title="Devices"
      subtitle="Machines, their tokens and alerts, and who may do what."
      what="devices"
      error={error}
      reset={reset}
      message={<p>The page hit a server error. If the roles migration (20261007000002) is not applied yet, apply it and retry.</p>}
    />
  );
}
